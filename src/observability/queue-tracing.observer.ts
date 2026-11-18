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
import { Injectable, type OnModuleDestroy, type OnModuleInit, Inject } from '@nestjs/common'
import { QueueObserverRegistry } from '@bymax-one/nest-queue'
import type { QueueObserveInfo, QueueObserver, TraceCarrier } from '@bymax-one/nest-queue'

/** The tracer name, the package the spans come from. */
const TRACER_NAME = '@bymax-one/nest-queue'

/** What the span of a failed operation reports: the library's error code, or only that it failed. */
function failureOf(error: unknown): string {
  const response =
    typeof error === 'object' && error !== null && 'getResponse' in error
      ? (error as { getResponse: () => unknown }).getResponse()
      : undefined
  const code = (response as { error?: { code?: unknown } } | undefined)?.error?.code
  return typeof code === 'string' ? code : 'error'
}

/** Run `run` in `span`, ending it and marking it failed, by code only, when `run` rejects. */
async function inSpan<T>(span: Span, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: failureOf(error) })
    throw error
  } finally {
    span.end()
  }
}

/**
 * Opens `queue.enqueue` and `queue.process` spans. Attributes are `bymax.queue.name` (the configured
 * queue name) only: no job id, name, data or error text is put on a span.
 */
@Injectable()
export class QueueTracingObserver implements QueueObserver, OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined

  /** @param observers - Where this observer registers itself, on module init. */
  constructor(@Inject(QueueObserverRegistry) private readonly observers: QueueObserverRegistry) {}

  /** Start observing the queue. */
  onModuleInit(): void {
    this.#unregister = this.observers.register(this)
  }

  /** Stop observing the queue. */
  onModuleDestroy(): void {
    this.#unregister?.()
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
