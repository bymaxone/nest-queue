/**
 * @fileoverview The OpenTelemetry spans of the queue. `queue.enqueue` wraps the add of a job and
 * writes the W3C trace context of its span into the carrier the queue stores with the job;
 * `queue.process` continues that trace in the worker, so a request, the job it enqueued and the work
 * the job did read as one trace. With no SDK registered the OpenTelemetry API does nothing, and no
 * header is written.
 * @layer observability
 */

import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import { Injectable, type OnModuleInit, Inject } from '@nestjs/common'
import { QueueObserverRegistry } from '@bymax-one/nest-queue'
import type { QueueObserveInfo, QueueObserver, TraceCarrier } from '@bymax-one/nest-queue'

/** The tracer name, the package the spans come from. */
const TRACER_NAME = '@bymax-one/nest-queue'

/**
 * What the span of a failed operation reports: the library's error code, or only that it failed.
 * Reading it must never replace the failure being reported, so an error that is not one of the
 * library's (no callable `getResponse`, or one that throws or answers something else) is `error`.
 */
function failureOf(error: unknown): string {
  try {
    const code = (error as { getResponse: () => { error: { code: unknown } } }).getResponse().error
      .code
    return typeof code === 'string' ? code : 'error'
  } catch {
    return 'error'
  }
}

/** The message of BullMQ's `RateLimitError`, which its worker reads a manual rate limit by. */
const RATE_LIMIT_MESSAGE = 'bullmq:rateLimitExceeded'

/** The names BullMQ's worker reads as control flow, and the span outcome of each. */
const HAND_BACKS: Readonly<Record<string, string>> = {
  DelayedError: 'delayed',
  WaitingChildrenError: 'waiting_children',
  WaitingError: 'waiting',
}

/**
 * What a processor that hands the job back to BullMQ says it did, as the closed value of the span's
 * `bymax.queue.outcome`. BullMQ's worker reads a rate limit by its message and the other three by the
 * name of the error, and the span does the same: the job is not failed, whatever the error is.
 */
function handBackOf(error: unknown): string | undefined {
  // BullMQ reads the message first and the name after it, and each read is guarded on its own, so a
  // member that throws, or a value that has none (`null`), never hides the other one.
  if (memberOf(error, 'message') === RATE_LIMIT_MESSAGE) return 'rate_limited'
  const name = memberOf(error, 'name')
  return typeof name === 'string' && Object.hasOwn(HAND_BACKS, name) ? HAND_BACKS[name] : undefined
}

/** A member of the error that throws when read must not replace the error being reported. */
function memberOf(error: unknown, key: 'name' | 'message'): unknown {
  try {
    return (error as Record<string, unknown>)[key]
  } catch {
    // An unreadable member is absent.
  }
  return undefined
}

/**
 * Run `run` in `span` and end it. A rejection marks the span failed, by code only, unless it is a
 * control-flow error of BullMQ, which ends the span with no error status and says what happened in
 * `bymax.queue.outcome`.
 */
async function inSpan<T>(span: Span, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const handedBack = handBackOf(error)
    if (handedBack === undefined) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: failureOf(error) })
    } else {
      span.setAttribute('bymax.queue.outcome', handedBack)
    }
    throw error
  } finally {
    span.end()
  }
}

/**
 * Opens `queue.enqueue` and `queue.process` spans. Attributes are `bymax.queue.name` (the configured
 * queue name) and, for an attempt the processor handed back to BullMQ, `bymax.queue.outcome`: no job
 * id, name, data or error text is put on a span.
 */
@Injectable()
export class QueueTracingObserver implements QueueObserver, OnModuleInit {
  /** @param observers - Where this observer registers itself, on module init. */
  constructor(@Inject(QueueObserverRegistry) private readonly observers: QueueObserverRegistry) {}

  /**
   * Start observing the queue. It is not removed on shutdown: `QueueLifecycle` is the only class that
   * exposes `onModuleDestroy`, so the observer keeps tracing the enqueues a handler makes while
   * the workers drain, and goes with the registry when the module does.
   */
  onModuleInit(): void {
    this.observers.register(this)
  }

  /**
   * Wrap an enqueue in `queue.enqueue` and write its trace context into `carrier`.
   *
   * @param info - The queue the job is added to.
   * @param carrier - Where the trace headers go.
   * @param run - The enqueue.
   */
  traceEnqueue<T>(
    info: QueueObserveInfo,
    carrier: TraceCarrier,
    run: () => Promise<T>,
  ): Promise<T> {
    const span = trace.getTracer(TRACER_NAME).startSpan('queue.enqueue', {
      kind: SpanKind.PRODUCER,
      attributes: { 'bymax.queue.name': info.queue },
    })
    const active = trace.setSpan(context.active(), span)
    propagation.inject(active, carrier)
    return context.with(active, () => inSpan(span, run))
  }

  /**
   * Wrap one attempt in `queue.process`, as a continuation of the trace stored with the job.
   *
   * @param info - The queue the job is taken from.
   * @param carrier - The headers stored with the job, empty when it carries none.
   * @param run - The processor.
   */
  traceProcess<T>(
    info: QueueObserveInfo,
    carrier: Readonly<TraceCarrier>,
    run: () => Promise<T>,
  ): Promise<T> {
    const parent = propagation.extract(context.active(), carrier)
    const span = trace
      .getTracer(TRACER_NAME)
      .startSpan(
        'queue.process',
        { kind: SpanKind.CONSUMER, attributes: { 'bymax.queue.name': info.queue } },
        parent,
      )
    return context.with(trace.setSpan(parent, span), () => inSpan(span, run))
  }
}
