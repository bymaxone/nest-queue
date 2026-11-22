/**
 * @fileoverview Runs the refusal of a polluted `Object.prototype` against a real Redis. A key planted
 * after the application booted, by plain assignment as pollution does, is refused before an add, and
 * a client that reconnects afterwards, the one the library opened and the connections BullMQ duplicates
 * for a worker and for queue events, is ended by the guarded connector instead of connecting to what
 * the key names.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import {
  BYMAX_QUEUE_REDIS_CLIENT,
  BymaxQueueModule,
  QueueEventsRegistry,
  QueueException,
  QueueService,
  WorkerRegistry,
} from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

const QUEUE = 'guarded'
/** A queue of its own, so jobs the other rows left behind are not processed by this row's worker. */
const ISOLATED_QUEUE = 'guarded-foreign'
/** A queue for the row whose handler plants the keys itself. */
const SETTLE_QUEUE = 'guarded-settle'

let redis: RedisContainer
let app: INestApplicationContext | undefined
let directory: string | undefined
let socketServer: Server | undefined

beforeAll(async () => {
  redis = await startRedisContainer()
}, 60_000)

afterEach(async () => {
  Reflect.deleteProperty(Object.prototype, 'path')
  Reflect.deleteProperty(Object.prototype, 'zzPlanted')
  await app?.close().catch(() => undefined)
  app = undefined
  await new Promise<void>((done) => {
    if (socketServer === undefined) done()
    else
      socketServer.close(() => {
        done()
      })
  })
  socketServer = undefined
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

afterAll(async () => {
  await redis.stop()
})

/** Boot a module against the real Redis. */
async function boot(): Promise<INestApplicationContext> {
  app = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [BymaxQueueModule.forRoot({ connection: { url: redis.url } })],
    },
    { logger: false },
  )
  return app
}

/** Plant a key on the root prototype by plain assignment, which is enumerable, as pollution does. */
function plant(key: string, value: unknown): void {
  ;(Object.prototype as Record<string, unknown>)[key] = value
}

/** A unix socket server that counts the connections it is offered, and the path it listens on. */
async function listenOnUnixSocket(): Promise<{ path: string; connections: () => number }> {
  directory = mkdtempSync(join(tmpdir(), 'queue-guard-'))
  const path = join(directory, 'redirect.sock')
  let seen = 0
  socketServer = createServer((socket) => {
    seen += 1
    socket.destroy()
  })
  await new Promise<void>((done) => socketServer?.listen(path, done))
  return { path, connections: () => seen }
}

/** Resolve with the status the client reaches, or the last one it showed when the time runs out. */
async function statusAfter(client: Redis, wanted: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (client.status !== wanted && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50))
  }
  return client.status
}

describe('E2E — a polluted Object.prototype is refused', () => {
  it('refuses an add after a key was planted, with a count and no value, and queues nothing', async () => {
    const queues = (await boot()).get(QueueService)
    await queues.enqueue(QUEUE, 'job', {}, { jobId: 'before' })
    plant('zzPlanted', 'planted-value')

    const error: unknown = await queues
      .enqueue(QUEUE, 'job', {}, { jobId: 'after' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(QueueException)
    const body = (error as QueueException).getResponse() as {
      error: { code: string; details: Record<string, unknown> }
    }
    expect(body.error.code).toBe('queue.invalid_options')
    expect(body.error.details).toEqual({
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count: 1,
    })
    expect(JSON.stringify(error)).not.toContain('planted-value')
    Reflect.deleteProperty(Object.prototype, 'zzPlanted')
    expect((await queues.getMetrics(QUEUE)).counts.waiting).toBe(1)
  }, 30_000)

  it('ends the library’s own client on reconnect instead of connecting to a planted path', async () => {
    const context = await boot()
    const client = context.get<Redis>(BYMAX_QUEUE_REDIS_CLIENT)
    const unix = await listenOnUnixSocket()
    plant('path', unix.path)

    client.disconnect(true)

    expect(await statusAfter(client, 'end')).toBe('end')
    expect(unix.connections()).toBe(0)
  }, 30_000)

  it('ends the connection BullMQ duplicated for a worker on reconnect', async () => {
    const context = await boot()
    const registry = context.get(WorkerRegistry)
    registry.register({
      queueName: QUEUE,
      handler: () => Promise.resolve(),
      options: { autorun: false },
    })
    const connection = registry.getConnections().get(QUEUE)!
    const unix = await listenOnUnixSocket()
    plant('path', unix.path)

    connection.disconnect(true)

    expect(await statusAfter(connection, 'end')).toBe('end')
    expect(unix.connections()).toBe(0)
  }, 30_000)

  it('ends the connection BullMQ duplicated for queue events on reconnect', async () => {
    const context = await boot()
    const registry = context.get(QueueEventsRegistry)
    registry.getOrCreate(QUEUE)
    const connection = registry.getConnections().get(QUEUE)!
    const unix = await listenOnUnixSocket()
    plant('path', unix.path)

    connection.disconnect(true)

    expect(await statusAfter(connection, 'end')).toBe('end')
    expect(unix.connections()).toBe(0)
  }, 30_000)

  it('reconnects normally when nothing is planted', async () => {
    const client = (await boot()).get<Redis>(BYMAX_QUEUE_REDIS_CLIENT)

    client.disconnect(true)

    expect(await statusAfter(client, 'ready')).toBe('ready')
  }, 30_000)

  it('keeps a job another producer enqueued when it is refused under a planted removeOnFail', async () => {
    const context = await boot()
    const handler = jest.fn().mockResolvedValue('done')
    const registry = context.get(WorkerRegistry)
    registry.register({ queueName: ISOLATED_QUEUE, handler, options: { autorun: false } })
    const worker = registry.getAll().get(ISOLATED_QUEUE)
    // The other producer is another process, so it adds the job before anything is planted here:
    // BullMQ's own `Queue.add` does not return under a planted `removeOnFail` in this process.
    const producer = new Queue(ISOLATED_QUEUE, { connection: { url: redis.url } })
    try {
      await producer.add('job', { n: 1 }, { jobId: 'foreign' })
      plant('removeOnFail', true)
      plant('removeOnComplete', true)

      void worker?.run()
      await waitForState(producer, 'foreign', 'delayed')
      const refused = await producer.getJob('foreign')

      expect(await refused?.getState()).toBe('delayed')
      expect(refused?.attemptsMade).toBe(0)
      expect(handler).not.toHaveBeenCalled()

      Reflect.deleteProperty(Object.prototype, 'removeOnFail')
      Reflect.deleteProperty(Object.prototype, 'removeOnComplete')
      await waitForState(producer, 'foreign', 'completed', 25_000)

      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'removeOnFail')
      Reflect.deleteProperty(Object.prototype, 'removeOnComplete')
      await producer.close()
    }
  }, 60_000)

  it('keeps a job another producer enqueued when the handler plants removeOnComplete and removeOnFail itself', async () => {
    const context = await boot()
    const handler = jest.fn().mockImplementation(() => {
      plant('removeOnComplete', true)
      plant('removeOnFail', true)
      return Promise.resolve('done')
    })
    const registry = context.get(WorkerRegistry)
    registry.register({ queueName: SETTLE_QUEUE, handler, options: { autorun: false } })
    const worker = registry.getAll().get(SETTLE_QUEUE)
    // Added before anything is planted: BullMQ's own `Queue.add` does not return under a planted `removeOnFail`.
    const producer = new Queue(SETTLE_QUEUE, { connection: { url: redis.url } })
    try {
      await producer.add('job', { n: 1 }, { jobId: 'settled' })

      void worker?.run()
      await waitUntilCalled(handler)
      // The keys stay planted while BullMQ finishes the attempt: the guard refuses once the handler
      // settled, the attempt fails, and the job is kept as failed instead of being deleted.
      await waitForState(producer, 'settled', 'failed', 20_000)
      const kept = await producer.getJob('settled')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(kept).toBeDefined()
      expect(await kept?.getState()).toBe('failed')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'removeOnFail')
      Reflect.deleteProperty(Object.prototype, 'removeOnComplete')
      await producer.close()
    }
  }, 60_000)
})

/** Wait until the job is in `wanted`, and fail with the state it was last seen in when it never is. */
async function waitForState(
  queue: Queue,
  jobId: string,
  wanted: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let seen = 'gone'
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId)
    seen = job === undefined ? 'gone' : await job.getState()
    if (seen === wanted) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`job ${jobId} was ${seen}, not ${wanted}`)
}

/** Wait until the mock has been called, and give the settle that follows a moment to run. */
async function waitUntilCalled(mock: jest.Mock, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (mock.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50))
  }
  await new Promise((done) => setTimeout(done, 300))
}
