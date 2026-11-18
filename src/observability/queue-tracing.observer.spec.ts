/**
 * @fileoverview Unit tests for the queue's spans, run against a real OpenTelemetry SDK that keeps
 * its spans in memory: `queue.enqueue` writes the W3C trace context of its span into the carrier,
 * `queue.process` continues that trace as its child, a failure is marked by the library's error code
 * and never by text, and no attribute carries a job id, name or payload.
 * @layer observability
 */

import 'reflect-metadata'
import { HttpStatus } from '@nestjs/common'
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { QueueException, QueueObserverRegistry, QUEUE_ERROR_CODES } from '@bymax-one/nest-queue'
import { QueueTracingObserver } from './queue-tracing.observer'

const exporter = new InMemorySpanExporter()
const contextManager = new AsyncLocalStorageContextManager().enable()

beforeAll(() => {
  context.setGlobalContextManager(contextManager)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  )
})

afterAll(() => {
  trace.disable()
  propagation.disable()
  context.disable()
})

beforeEach(() => {
  exporter.reset()
})

/** The finished span with `name`. */
function spanNamed(name: string): ReturnType<InMemorySpanExporter['getFinishedSpans']>[number] {
  const span = exporter.getFinishedSpans().find((candidate) => candidate.name === name)
  if (span === undefined) throw new Error(`no span named ${name}`)
  return span
}

/** Everything a backend would be sent of a span: its name, attributes, status and events. */
function visible(span: ReturnType<typeof spanNamed>): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events,
  })
}

describe('QueueTracingObserver — enqueue', () => {
  it('opens queue.enqueue as a producer span named by the queue only, and writes its trace context', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())
    const carrier: Record<string, string> = {}

    const result = await observer.traceEnqueue({ queue: 'email', job: 'send' }, carrier, () =>
      Promise.resolve('added'),
    )

    expect(result).toBe('added')
    const span = spanNamed('queue.enqueue')
    expect(span.kind).toBe(SpanKind.PRODUCER)
    expect(span.attributes).toEqual({ 'bymax.queue.name': 'email' })
    expect(carrier.traceparent).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    )
  })

  it('makes the span a child of the span that is active, so a request and its job share one trace', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())
    const tracer = trace.getTracer('test')

    await tracer.startActiveSpan('http request', async (request) => {
      await observer.traceEnqueue({ queue: 'email' }, {}, () => Promise.resolve())
      request.end()
    })

    const enqueue = spanNamed('queue.enqueue')
    const request = spanNamed('http request')
    expect(enqueue.spanContext().traceId).toBe(request.spanContext().traceId)
    expect(enqueue.parentSpanContext?.spanId).toBe(request.spanContext().spanId)
  })

  it('marks a failed enqueue with the code of the library error, never its text, and rethrows it', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())
    const error = new QueueException(
      QUEUE_ERROR_CODES.STORAGE_FULL,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        secret: 'SENTINEL',
      },
    )

    await expect(
      observer.traceEnqueue({ queue: 'email' }, {}, () => Promise.reject(error)),
    ).rejects.toBe(error)

    const span = spanNamed('queue.enqueue')
    expect(span.status).toEqual({ code: 2, message: QUEUE_ERROR_CODES.STORAGE_FULL })
    expect(visible(span)).not.toContain('SENTINEL')
  })

  it.each([
    ['an Error', new Error('connect ECONNREFUSED 10.0.0.1:6379')],
    ['an Error with a plain message', new Error('text')],
    [
      'a QueueException whose code is not a string',
      Object.assign(new Error('x'), { getResponse: () => ({ error: { code: 7 } }) }),
    ],
    [
      'an object with getResponse that answers nothing',
      Object.assign(new Error('x'), { getResponse: () => undefined }),
    ],
  ])('marks a failure that is %s as an error, with no text of it', async (_label, error) => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())

    await observer
      .traceEnqueue({ queue: 'email' }, {}, () => Promise.reject(error))
      .catch(() => undefined)

    expect(spanNamed('queue.enqueue').status).toEqual({ code: 2, message: 'error' })
  })
})

describe('QueueTracingObserver — process', () => {
  it('continues the trace stored with the job as the parent of queue.process', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())
    const carrier: Record<string, string> = {}
    await observer.traceEnqueue({ queue: 'email' }, carrier, () => Promise.resolve())

    // The worker runs later, outside any active context.
    const result = await context.with(ROOT_CONTEXT, () =>
      observer.traceProcess({ queue: 'email', job: 'send' }, carrier, () =>
        Promise.resolve('done'),
      ),
    )

    expect(result).toBe('done')
    const enqueue = spanNamed('queue.enqueue')
    const processed = spanNamed('queue.process')
    expect(processed.kind).toBe(SpanKind.CONSUMER)
    expect(processed.attributes).toEqual({ 'bymax.queue.name': 'email' })
    expect(processed.spanContext().traceId).toBe(enqueue.spanContext().traceId)
    expect(processed.parentSpanContext?.spanId).toBe(enqueue.spanContext().spanId)
  })

  it('starts a trace of its own for a job that carries no headers', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())

    await context.with(ROOT_CONTEXT, () =>
      observer.traceProcess({ queue: 'email' }, {}, () => Promise.resolve()),
    )

    expect(spanNamed('queue.process').parentSpanContext).toBeUndefined()
  })

  it('makes work done inside the processor a child of queue.process', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())

    await context.with(ROOT_CONTEXT, () =>
      observer.traceProcess({ queue: 'email' }, {}, async () => {
        await trace.getTracer('test').startActiveSpan('side effect', (inner) => {
          inner.end()
          return Promise.resolve()
        })
      }),
    )

    expect(spanNamed('side effect').parentSpanContext?.spanId).toBe(
      spanNamed('queue.process').spanContext().spanId,
    )
  })

  it('marks a failed attempt by code and rethrows the error as it is', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())
    const error = new Error('payload SENTINEL')

    await expect(
      observer.traceProcess({ queue: 'email' }, {}, () => Promise.reject(error)),
    ).rejects.toBe(error)

    const span = spanNamed('queue.process')
    expect(span.status).toEqual({ code: 2, message: 'error' })
    expect(visible(span)).not.toContain('SENTINEL')
  })
})

describe('QueueTracingObserver — lifecycle', () => {
  it('registers itself on module init and is removed on module destroy', async () => {
    const registry = new QueueObserverRegistry()
    const observer = new QueueTracingObserver(registry)
    expect(registry.active).toBe(false)

    observer.onModuleInit()
    const carrier: Record<string, string> = {}
    await registry.traceEnqueue({ queue: 'email' }, (written) => {
      Object.assign(carrier, written)
      return Promise.resolve()
    })
    expect(registry.active).toBe(true)
    expect(Object.keys(carrier)).toEqual(['traceparent'])

    observer.onModuleDestroy()
    expect(registry.active).toBe(false)
  })

  it('does nothing when destroyed before it was initialised', () => {
    expect(() => {
      new QueueTracingObserver(new QueueObserverRegistry()).onModuleDestroy()
    }).not.toThrow()
  })
})
