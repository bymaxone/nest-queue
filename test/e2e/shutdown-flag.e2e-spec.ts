/**
 * @fileoverview Runs the `drainOnShutdown` flag through the real shutdown path against a real Redis.
 * The flag deletes the waiting jobs of every queue the process has used when the application
 * closes, so a value that is not a boolean must be refused at setup and never reach that path: a
 * string such as `'false'`, which is what `process.env.X` holds, is truthy.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { Redis } from 'ioredis'
import { BymaxQueueModule, QueueException, QueueService } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

const QUEUE = 'keep-me'
const WAITING_JOBS = 3

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext | undefined

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
}, 60_000)

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
  await maintenance.flushall()
})

afterAll(async () => {
  await maintenance.quit()
  await redis.stop()
})

/** Put `WAITING_JOBS` jobs in the wait list with no worker, through a module that never drains. */
async function seedWaitingJobs(): Promise<void> {
  const seeding = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [BymaxQueueModule.forRoot({ connection: { url: redis.url } })],
    },
    { logger: false },
  )
  const queues = seeding.get(QueueService)
  for (let i = 0; i < WAITING_JOBS; i += 1)
    await queues.enqueue(QUEUE, 'job', {}, { jobId: `seed-${String(i)}` })
  await seeding.close()
  expect(await maintenance.llen(`bull:${QUEUE}:wait`)).toBe(WAITING_JOBS)
}

/**
 * Boot a module with `drainOnShutdown` set to `value`, use the seeded queue so it is cached, and
 * close the application: the whole path a drain would take. Resolves to what was thrown, if anything.
 */
async function runShutdownWith(value: unknown, key = 'drainOnShutdown'): Promise<unknown> {
  try {
    app = await NestFactory.createApplicationContext(
      {
        module: RootModule,
        imports: [
          BymaxQueueModule.forRoot({
            connection: { url: redis.url },
            shutdown: { [key]: value },
          }),
        ],
      },
      { logger: false },
    )
    await app.get(QueueService).getMetrics(QUEUE)
    await app.close()
    app = undefined
    return undefined
  } catch (error) {
    return error
  }
}

/** The reason an `INVALID_OPTIONS` exception carries. */
function reasonOf(error: unknown): string {
  const body = (error as QueueException).getResponse() as {
    error: { code: string; details: { reason: string } }
  }
  expect(body.error.code).toBe('queue.invalid_options')
  return body.error.details.reason
}

describe('E2E — drainOnShutdown through the shutdown path', () => {
  it.each([
    ['the string "false"', 'false', 'a string'],
    ['the string "0"', '0', 'a string'],
    ['the empty string', '', 'a string'],
    ['the number 1', 1, 'a number'],
    ['an object', {}, 'an object'],
    ['an array', [], 'an array'],
    ['a boxed false', new Boolean(false), 'an object'],
    ['null', null, 'null'],
  ])(
    'refuses %s at setup, naming the option and the type, and the waiting jobs survive',
    async (_label, value, type) => {
      await seedWaitingJobs()

      const thrown = await runShutdownWith(value)

      expect(await maintenance.llen(`bull:${QUEUE}:wait`)).toBe(WAITING_JOBS)
      expect(thrown).toBeInstanceOf(QueueException)
      expect(reasonOf(thrown)).toBe(`shutdown.drainOnShutdown must be a boolean, received ${type}`)
    },
    30_000,
  )

  it('keeps the waiting jobs when the flag is false', async () => {
    await seedWaitingJobs()

    expect(await runShutdownWith(false)).toBeUndefined()

    expect(await maintenance.llen(`bull:${QUEUE}:wait`)).toBe(WAITING_JOBS)
  }, 30_000)

  it('keeps the waiting jobs when the flag is absent', async () => {
    await seedWaitingJobs()

    expect(await runShutdownWith(undefined)).toBeUndefined()

    expect(await maintenance.llen(`bull:${QUEUE}:wait`)).toBe(WAITING_JOBS)
  }, 30_000)

  it('still drains the waiting jobs when the flag is the boolean true', async () => {
    await seedWaitingJobs()

    expect(await runShutdownWith(true)).toBeUndefined()

    expect(await maintenance.llen(`bull:${QUEUE}:wait`)).toBe(0)
  }, 30_000)
})
