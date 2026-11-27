/**
 * @fileoverview Runs failing jobs against a real Redis and reads the lines the library writes: one
 * `QUEUE_JOB_FAILED` warning for each failed attempt, none for a job handed back to BullMQ, from a
 * worker registered after the application booted, and nothing of a payload or an error message.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger, Module, type INestApplicationContext } from '@nestjs/common'
import { DelayedError } from 'bullmq'
import { BymaxQueueModule, QueueService, WorkerRegistry } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** A value that must never be logged: it stands for a payload and for an error message. */
const SECRET = 'SECRET-do-not-log'

class PaymentDeclined extends Error {}

let redis: RedisContainer
let app: INestApplicationContext
const lines: unknown[] = []

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  jest.restoreAllMocks()
  redis = await startRedisContainer()

  @Module({
    imports: [
      BymaxQueueModule.forRoot({
        connection: { url: redis.url },
        shutdown: { drainTimeoutMs: 1000 },
      }),
    ],
  })
  class Host {}

  app = await NestFactory.createApplicationContext(Host, { logger: false })
}, 60_000)

afterAll(async () => {
  await app.close()
  await redis.stop()
})

describe('E2E — the log of a failed job', () => {
  it('writes one warning per failed attempt, none for a hand-back, and no payload or message', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      lines.push(message)
    })
    const queues = app.get(QueueService)
    let handedBack = false
    app.get(WorkerRegistry).register({
      queueName: 'payments',
      handler: async (job) => {
        if (job.name === 'later' && !handedBack) {
          handedBack = true
          await job.moveToDelayed(Date.now() + 100, job.token)
          throw new DelayedError()
        }
        if (job.name === 'charge') throw new PaymentDeclined(`card ${SECRET} was declined`)
      },
    })

    await queues.enqueue('payments', 'later', {}, { jobId: 'hand-back' })
    await queues.enqueue('payments', 'charge', { card: SECRET }, { jobId: 'c1', attempts: 2 })
    await waitFor(async () => {
      const { counts } = await queues.getMetrics('payments')
      return counts.completed === 1 && counts.failed === 1
    })

    expect(handedBack).toBe(true)
    const failed = lines.filter((line) => (line as { event?: string }).event === 'QUEUE_JOB_FAILED')
    expect(failed).toStrictEqual(
      [1, 2].map((attempt) => ({
        event: 'QUEUE_JOB_FAILED',
        message: 'A job attempt failed',
        queue: 'payments',
        jobName: 'charge',
        jobId: 'c1',
        attempt,
        errorClass: 'PaymentDeclined',
      })),
    )
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  }, 30_000)
})
