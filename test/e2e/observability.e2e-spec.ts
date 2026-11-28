/**
 * @fileoverview Runs the observability of the queue against a real Redis and a real OpenTelemetry
 * SDK that keeps its spans in memory. One trace id must run from the request that enqueues a job,
 * through the job stored in Redis, to the work the worker does; the metrics are scraped after the
 * attempts and read as Prometheus would read them; the readiness indicator pings the real
 * connection; and nothing a job carries, its data or its failure text, reaches a span or a sample.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { Registry } from 'prom-client'
import { Redis } from 'ioredis'
import { BymaxQueueModule, QueueService, WorkerRegistry } from '@bymax-one/nest-queue'
import {
  BymaxQueueObservabilityModule,
  QueueHealthIndicator,
  QueueMetricsContributor,
} from '@bymax-one/nest-queue/observability'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** A value that must never appear in a span or a metric: it stands for a job's data. */
const SENTINEL = 'SENTINEL-job-payload-do-not-export'

const exporter = new InMemorySpanExporter()
const tracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer('e2e')

@Module({})
class RootModule {}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext
let queues: QueueService
let registry: Registry

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

/** The finished spans named `name`. */
function spansNamed(name: string): ReturnType<InMemorySpanExporter['getFinishedSpans']> {
  return exporter.getFinishedSpans().filter((span) => span.name === name)
}

/** The lines of the scrape that start with `name`. */
async function scrape(name: string): Promise<string[]> {
  return (await registry.metrics()).split('\n').filter((line) => line.startsWith(name))
}

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  )
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
  app = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [
        BymaxQueueModule.forRoot({
          connection: { url: redis.url },
          metrics: { enabled: true, cacheTtlMs: 0 },
        }),
        BymaxQueueObservabilityModule,
      ],
    },
    { logger: false },
  )
  queues = app.get(QueueService)
  registry = new Registry()
  app.get(QueueMetricsContributor).registerMetrics(registry)
  app.get(WorkerRegistry).register({
    queueName: 'orders',
    handler: async (job) => {
      await tracer().startActiveSpan('side effect', (span) => {
        span.end()
        return Promise.resolve()
      })
      if ((job.data as { fail?: boolean }).fail === true) {
        throw new Error(`failed with ${SENTINEL}`)
      }
      return 'done'
    },
    options: { concurrency: 1 },
  })
}, 60_000)

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await app.close()
  await maintenance.quit()
  await redis.stop()
  trace.disable()
  propagation.disable()
  context.disable()
})

describe('E2E — observability of the queue', () => {
  it('runs one trace from the request, through the job in Redis, to the work the worker does', async () => {
    const job = await tracer().startActiveSpan('http request', async (request) => {
      const added = await queues.enqueue('orders', 'place', { order: SENTINEL })
      request.end()
      return added
    })
    await waitFor(async () => (await queues.getMetrics('orders')).counts.completed === 1)
    await waitFor(() => spansNamed('queue.process').length === 1)

    const [request] = spansNamed('http request')
    const [enqueue] = spansNamed('queue.enqueue')
    const [processed] = spansNamed('queue.process')
    const [sideEffect] = spansNamed('side effect')
    const traceId = request?.spanContext().traceId
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    for (const span of [enqueue, processed, sideEffect]) {
      expect(span?.spanContext().traceId).toBe(traceId)
    }
    expect(enqueue?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId)
    expect(enqueue?.kind).toBe(SpanKind.PRODUCER)
    expect(processed?.parentSpanContext?.spanId).toBe(enqueue?.spanContext().spanId)
    expect(processed?.kind).toBe(SpanKind.CONSUMER)
    expect(sideEffect?.parentSpanContext?.spanId).toBe(processed?.spanContext().spanId)

    // The context travels in the job's options in Redis, apart from its data.
    const stored = await queues.getJob('orders', job.id ?? '')
    const metadata = JSON.parse(stored?.opts.telemetry?.metadata ?? '{}') as {
      traceparent?: string
    }
    expect(metadata.traceparent).toBe(
      `00-${traceId ?? ''}-${enqueue?.spanContext().spanId ?? ''}-01`,
    )
    expect(stored?.data).toEqual({ order: SENTINEL })
  })

  it('counts and times each attempt, marks a failed one by code, and leaks no payload or failure text', async () => {
    exporter.reset()
    await queues.enqueue(
      'orders',
      'place',
      { fail: true, order: SENTINEL },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    )
    await waitFor(async () => (await queues.getMetrics('orders')).counts.failed === 1)
    await waitFor(() => spansNamed('queue.process').length === 2)
    // Redis can show the job as failed before the worker has reported the attempt.
    const failed = 'bymax_queue_jobs_total{queue="orders",outcome="failed"} 1'
    await waitFor(async () => (await scrape('bymax_queue_jobs_total')).includes(failed))

    const jobs = await scrape('bymax_queue_jobs_total')
    expect(jobs).toContain('bymax_queue_jobs_total{queue="orders",outcome="retried"} 1')
    expect(jobs).toContain(failed)
    const seconds = await scrape('bymax_queue_job_duration_seconds_count')
    expect(Number(seconds[0]?.split(' ').at(-1))).toBeGreaterThanOrEqual(2)
    for (const span of spansNamed('queue.process')) {
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'error' })
    }

    const everything =
      (await registry.metrics()) +
      JSON.stringify(
        exporter.getFinishedSpans().map((span) => ({
          name: span.name,
          attributes: span.attributes,
          status: span.status,
          events: span.events,
        })),
      )
    expect(everything).not.toContain(SENTINEL)
  })

  it('reports the depth of the queue by state, with labels from closed sets', async () => {
    await queues.enqueue('orders', 'later', {}, { delay: 600_000 })

    const depth = await scrape('bymax_queue_depth{')
    expect(depth).toContain('bymax_queue_depth{queue="orders",state="delayed"} 1')
    expect(depth).toHaveLength(4)
    const states = depth.map((line) => /state="([^"]*)"/.exec(line)?.[1])
    expect(states.sort()).toEqual(['active', 'delayed', 'failed', 'waiting'])
  })

  it('answers the readiness check from the real connection', async () => {
    await expect(app.get(QueueHealthIndicator).check()).resolves.toEqual({
      status: 'up',
      details: { mode: 'mode-b-owned' },
    })
  })
})
