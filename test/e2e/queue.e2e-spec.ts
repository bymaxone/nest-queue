/**
 * @fileoverview End-to-end suite exercising the library against a real Redis
 * (Testcontainers). Covers the seven specification scenarios — typed
 * enqueue/process, graceful shutdown drain, multi-level flows, interval job
 * schedulers, retry-then-succeed, deduplication, and the dual-mode connection
 * retry policy — plus a dead-letter-queue smoke check. One container is booted
 * for the whole suite and Redis is flushed between scenarios.
 * @layer test/e2e
 */

import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'
import { Redis } from 'ioredis'
import {
  ConnectionResolver,
  FlowService,
  QueueService,
  WorkerRegistry,
} from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'
import { buildTestModule } from './fixtures/test.module'
import { EchoProcessor } from './fixtures/processors/echo.processor'
import { SlowProcessor } from './fixtures/processors/slow.processor'
import { RetryProcessor } from './fixtures/processors/retry.processor'
import { DedupProcessor } from './fixtures/processors/dedup.processor'
import { FlowRecorder } from './fixtures/processors/flow.processors'

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

/** Normalize a `QueueEvents` return value, which may arrive JSON-serialized. */
function normalize(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value
}

/** Boot an application context for the given Redis connection. */
async function bootApp(url: string): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(buildTestModule({ url }), { logger: false })
}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext | undefined

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
}, 60_000)

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
  await maintenance.flushall()
})

afterAll(async () => {
  await maintenance.quit()
  await redis.stop()
})

describe('E2E — queue library against real Redis', () => {
  it('S1: enqueues, processes, and returns a typed result', async () => {
    // The typed return value round-trips and is observed via @OnQueueEvent('completed').
    app = await bootApp(redis.url)
    const echo = app.get(EchoProcessor)
    const queues = app.get(QueueService)

    await queues.enqueue('echo', 'echo', { value: 'hello' })
    await waitFor(() => echo.completed.length > 0, 10_000)

    expect(normalize(echo.completed[0]?.returnvalue)).toEqual({ echoed: 'hello' })
  })

  it('S2: graceful shutdown finishes an in-flight job before the context closes', async () => {
    // worker.close() drains the active job within the budget; it is never forced.
    const localApp = await bootApp(redis.url)
    const slow = localApp.get(SlowProcessor)
    const queues = localApp.get(QueueService)

    await queues.enqueue('slow', 'slow', { ms: 400 })
    await waitFor(() => slow.started, 10_000)
    await localApp.close()

    expect(slow.completed).toBe(true)
  })

  it('S3: a three-level flow completes every descendant before the root', async () => {
    // Children and grandchildren are processed before the parent becomes runnable.
    app = await bootApp(redis.url)
    const flow = app.get(FlowService)
    const recorder = app.get(FlowRecorder)

    await flow.add({
      name: 'root',
      queueName: 'flow-root',
      data: {},
      children: [
        {
          name: 'child',
          queueName: 'flow-child',
          data: {},
          children: [{ name: 'leaf', queueName: 'flow-leaf', data: {} }],
        },
      ],
    })

    await waitFor(() => recorder.order.length === 3, 15_000)
    expect(recorder.order).toEqual(['leaf', 'child', 'root'])
  })

  it('S4: an interval scheduler fires repeatedly and re-upsert keeps a single scheduler', async () => {
    // every-interval schedulers fire ≥2 in ~10s; re-upserting the same id never duplicates.
    app = await bootApp(redis.url)
    const echo = app.get(EchoProcessor)
    const queues = app.get(QueueService)

    await queues.upsertJobScheduler(
      'echo',
      'tick',
      { every: 400 },
      { name: 'echo', data: { value: 'tick' } },
    )
    await queues.upsertJobScheduler(
      'echo',
      'tick',
      { every: 400 },
      { name: 'echo', data: { value: 'tick' } },
    )

    const schedulers = await queues.getJobSchedulers('echo')
    expect(schedulers).toHaveLength(1)

    await waitFor(() => echo.completed.length >= 2, 15_000)
    expect(echo.completed.length).toBeGreaterThanOrEqual(2)
  })

  it('S5: a failing job retries with backoff and eventually succeeds', async () => {
    // Two failures then a success — exactly three handler invocations.
    app = await bootApp(redis.url)
    const retry = app.get(RetryProcessor)
    const queues = app.get(QueueService)

    await queues.enqueue('retry', 'retry', {}, { attempts: 3, backoff: { type: 'exponential', delay: 50 } })
    await waitFor(() => retry.succeeded, 15_000)

    expect(retry.attempts).toBe(3)
  })

  it('S6: deduplication collapses many rapid same-key enqueues into one processed job', async () => {
    // Five concurrent same-id enqueues yield a single processed job.
    app = await bootApp(redis.url)
    const dedup = app.get(DedupProcessor)
    const queues = app.get(QueueService)

    await Promise.all(
      Array.from({ length: 5 }, () =>
        queues.enqueue('dedup', 'dedup', {}, { deduplication: { id: 'dup-key' } }),
      ),
    )

    await waitFor(() => dedup.processed >= 1, 10_000)
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    expect(dedup.processed).toBe(1)
  })

  it('S7: the worker connection is forced to maxRetriesPerRequest=null while the queue keeps defaults', async () => {
    // Mode A: the queue role keeps ioredis defaults; the duplicated worker role is coerced to null.
    const client = new Redis(redis.url, { maxRetriesPerRequest: 20 })
    const localApp = await NestFactory.createApplicationContext(buildTestModule({ client }), {
      logger: false,
    })
    try {
      const resolver = localApp.get(ConnectionResolver)
      const workers = localApp.get(WorkerRegistry)

      expect(resolver.getClient().options.maxRetriesPerRequest).not.toBeNull()
      const workerConnection = workers.getConnections().get('echo')
      expect(workerConnection?.options.maxRetriesPerRequest).toBeNull()
    } finally {
      await localApp.close()
      await client.quit()
    }
  })

  it('DLQ smoke: an exhausted job lands on the dead-letter queue', async () => {
    // After retries are exhausted, the failure listener routes the job to risky-dlq.
    app = await bootApp(redis.url)
    const queues = app.get(QueueService)

    await queues.enqueue('risky', 'risky', { willFail: true, payload: 'p' }, { attempts: 1 })

    await waitFor(async () => (await queues.getMetrics('risky-dlq')).counts.waiting >= 1, 15_000)
    const metrics = await queues.getMetrics('risky-dlq')
    expect(metrics.counts.waiting).toBeGreaterThanOrEqual(1)
  })
})
