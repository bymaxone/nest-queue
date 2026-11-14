/**
 * @fileoverview End-to-end checks of the per-job timeout and the abort signal against a real
 * BullMQ `Worker` and a real Redis (Testcontainers). The unit suite mocks the Worker, so only this
 * file can show that BullMQ hands the handler a signal and what aborts it.
 * @layer test/e2e
 */

import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'
import { Redis } from 'ioredis'
import { QueueService, WorkerRegistry } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'
import { buildTestModule } from './fixtures/test.module'

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

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
}, 60_000)

beforeEach(async () => {
  app = await NestFactory.createApplicationContext(buildTestModule({ url: redis.url }), {
    logger: false,
  })
})

afterEach(async () => {
  await app.close()
  await maintenance.flushall()
})

afterAll(async () => {
  await maintenance.quit()
  await redis.stop()
})

describe('E2E — jobTimeoutMs with a real Worker', () => {
  // The queue must keep moving when a handler never settles: the hung job fails with the timeout
  // error and the next job on the same single-slot worker runs.
  it('fails a hung job and lets the next job run on a single-slot worker', async () => {
    const queues = app.get(QueueService)
    const seen: { signal?: AbortSignal } = {}
    const processed: string[] = []
    app.get(WorkerRegistry).register({
      queueName: 'hung',
      options: { concurrency: 1, jobTimeoutMs: 500 },
      handler: (job, signal) => {
        if ((job.data as { hang?: boolean }).hang === true) {
          if (signal !== undefined) seen.signal = signal
          return new Promise<unknown>(() => undefined)
        }
        processed.push(job.id ?? '')
        return Promise.resolve('ok')
      },
    })

    const hung = await queues.enqueue('hung', 'work', { hang: true }, { attempts: 1 })
    const next = await queues.enqueue('hung', 'work', { hang: false })

    await waitFor(() => processed.includes(next.id ?? ''), 8000)
    const stored = await queues.getJob('hung', hung.id ?? '')
    expect(stored?.failedReason).toContain('queue.job_timeout')
    expect(seen.signal?.aborted).toBe(true)
  })

  // The handler must receive a live signal from BullMQ itself, with or without a timeout, and
  // cancelling the job through the worker must abort it.
  it.each([undefined, 60_000])(
    'hands the handler a signal that worker.cancelJob aborts (jobTimeoutMs %s)',
    async (jobTimeoutMs) => {
      const queues = app.get(QueueService)
      const seen: { signal?: AbortSignal } = {}
      const worker = app.get(WorkerRegistry).register({
        queueName: 'cancellable',
        ...(jobTimeoutMs === undefined ? {} : { options: { jobTimeoutMs } }),
        handler: (_job, signal) => {
          if (signal !== undefined) seen.signal = signal
          return new Promise<unknown>(() => undefined)
        },
      })

      const job = await queues.enqueue('cancellable', 'work', {}, { attempts: 1 })
      await waitFor(() => seen.signal !== undefined, 8000)
      expect(seen.signal?.aborted).toBe(false)

      worker.cancelJob(job.id ?? '')

      await waitFor(() => seen.signal?.aborted === true, 4000)
    },
  )
})
