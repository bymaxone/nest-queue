/**
 * @fileoverview Runs the refusal of a job id that is one of the queue's own Redis key names against
 * a real Redis. The unit suite mocks BullMQ, so only this file can show that a refused id leaves the
 * queue healthy, that the set of reserved ids covers every key BullMQ really writes for a queue in
 * use, and which ids BullMQ refuses by itself.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { Redis } from 'ioredis'
import { BymaxQueueModule, QueueService, WorkerRegistry } from '@bymax-one/nest-queue'
import { RESERVED_JOB_IDS } from '../../src/server/utils/reserved-job-ids'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
  app = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [
        BymaxQueueModule.forRoot({
          connection: { url: redis.url },
          flows: { enabled: true },
        }),
      ],
    },
    { logger: false },
  )
}, 60_000)

afterAll(async () => {
  await app.close()
  await maintenance.quit()
  await redis.stop()
})

/** The error a call rejects with, or `undefined` when it resolves. */
async function failure(work: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await work()
  } catch (err) {
    const body = (err as { getResponse?: () => { error?: { code?: string } } }).getResponse?.()
    const code = body?.error?.code
    return { ...(code === undefined ? {} : { code }), message: (err as Error).message }
  }
  throw new Error('the call did not reject')
}

describe('E2E — a job id that is one of the queue keys', () => {
  it('leaves the queue healthy after a refused id, and an ordinary id still works', async () => {
    const queues = app.get(QueueService)

    for (const jobId of ['active', 'wait', 'failed', 'id']) {
      const err = await failure(() => queues.enqueue('healthy', 'j', {}, { jobId }))
      expect(err.code).toBe('queue.invalid_job_id')
    }

    // Before the refusal existed, enqueueing `active` made the next metrics call throw WRONGTYPE.
    await expect(queues.getMetrics('healthy')).resolves.toMatchObject({
      counts: { waiting: 0, active: 0 },
    })
    await queues.enqueue('healthy', 'j', {}, { jobId: 'ordinary' })
    await expect(queues.getMetrics('healthy')).resolves.toMatchObject({ counts: { waiting: 1 } })
    await expect(queues.getJob('healthy', 'ordinary')).resolves.toMatchObject({ id: 'ordinary' })
    await expect(queues.getJob('healthy', 'active')).resolves.toBeNull()
  })

  it('covers every key suffix BullMQ writes for a queue that uses its features', async () => {
    const queues = app.get(QueueService)
    const name = 'keys-live'
    app.get(WorkerRegistry).register({ queueName: name, handler: () => Promise.resolve('ok') })
    await queues.enqueue(name, 'j', {}, { jobId: 'job-done' })
    await queues.enqueue(name, 'j', {}, { jobId: 'job-delayed', delay: 60_000 })
    await queues.enqueue(name, 'j', {}, { jobId: 'job-priority', priority: 3, delay: 60_000 })
    await queues.enqueue(
      name,
      'j',
      {},
      { jobId: 'job-dedup', deduplication: { id: 'k', ttl: 60_000 } },
    )
    await queues.upsertJobScheduler(name, 'sched', { every: 60_000 }, { name: 'tick' })
    await queues.pauseQueue(name)
    await queues.enqueue(name, 'j', {}, { jobId: 'job-paused' })
    await new Promise<void>((resolve) => setTimeout(resolve, 500))

    const stem = `bull:${name}:`
    const keys = await maintenance.keys(`${stem}*`)
    // Only keys with no colon after the stem can collide with a job id, and our own ids are `job-*`.
    const suffixes = keys
      .map((key) => key.slice(stem.length))
      .filter((suffix) => !suffix.includes(':') && !suffix.startsWith('job-'))

    expect(suffixes.length).toBeGreaterThan(3)
    for (const suffix of suffixes) expect(RESERVED_JOB_IDS.has(suffix)).toBe(true)
  })

  it('leaves to BullMQ the ids it already refuses, and does not report them as reserved', async () => {
    const queues = app.get(QueueService)

    const colon = await failure(() => queues.enqueue('own-rules', 'j', {}, { jobId: 'a:b' }))
    const integer = await failure(() => queues.enqueue('own-rules', 'j', {}, { jobId: '5' }))

    expect(colon.message).toContain('Custom Id cannot contain :')
    expect(integer.message).toContain('Custom Id cannot be integers')
    expect(colon.code).not.toBe('queue.invalid_job_id')
    expect(integer.code).not.toBe('queue.invalid_job_id')
  })
})
