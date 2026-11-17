/**
 * @fileoverview Runs the retention cap of `defaultJobOptions` against a real Redis. A `count` of `-1`
 * or `1.5` makes BullMQ keep every job, so the module refuses it at setup; a whole count keeps
 * exactly that many, which is what the README's bounded `removeOn*` caps promise.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { Redis } from 'ioredis'
import { BymaxQueueModule, QueueService, WorkerRegistry } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext | undefined

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
}, 60_000)

afterEach(async () => {
  await app?.close()
  app = undefined
})

afterAll(async () => {
  await maintenance.quit()
  await redis.stop()
})

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

describe('E2E — the retention cap of defaultJobOptions', () => {
  it.each([-1, 1.5])('refuses a removeOnFail count of %s at setup, before any job', (count) => {
    expect(() =>
      BymaxQueueModule.forRoot({
        connection: { url: redis.url },
        defaultJobOptions: { removeOnFail: { count } },
      }),
    ).toThrow()
  })

  it('keeps exactly the configured number of failed jobs out of thirty', async () => {
    app = await NestFactory.createApplicationContext(
      {
        module: RootModule,
        imports: [
          BymaxQueueModule.forRoot({
            connection: { url: redis.url },
            defaultJobOptions: { attempts: 1, removeOnFail: { count: 5 } },
          }),
        ],
      },
      { logger: false },
    )
    const queues = app.get(QueueService)
    app.get(WorkerRegistry).register({
      queueName: 'capped',
      handler: () => Promise.reject(new Error('always fails')),
      options: { concurrency: 1 },
    })
    for (let i = 0; i < 30; i += 1)
      await queues.enqueue('capped', 'j', {}, { jobId: `j${String(i)}` })

    await waitFor(async () => (await queues.getMetrics('capped')).counts.waiting === 0, 15_000)
    await waitFor(async () => (await queues.getMetrics('capped')).counts.active === 0, 15_000)

    expect(await maintenance.zcard('bull:capped:failed')).toBe(5)
  })
})
