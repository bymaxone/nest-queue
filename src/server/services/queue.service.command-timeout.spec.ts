/**
 * @fileoverview Unit tests for the documented timeout code on every `QueueService` call that goes
 * through the owned connection. BullMQ's `Queue` is mocked; the real ioredis timeout rejection is
 * produced by a real client against a server that never replies.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'
import { QueueService } from './queue.service'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** Every Queue method QueueService calls, all mocked. */
type MockQueue = Record<string, jest.Mock>

const queues: MockQueue[] = []

const QUEUE_METHODS = [
  'add',
  'addBulk',
  'getJob',
  'getJobs',
  'getJobCounts',
  'upsertJobScheduler',
  'removeJobScheduler',
  'getJobSchedulers',
  'pause',
  'resume',
  'clean',
] as const

jest.mock('bullmq', () => ({
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      close: jest.fn().mockResolvedValue(undefined),
    }) as unknown as MockQueue
    for (const method of QUEUE_METHODS) instance[method] = jest.fn()
    queues.push(instance)
    return instance
  }),
}))

/** Resolved options with the given deadlines. */
function makeOptions(commandTimeoutMs: number, enqueueTimeoutMs: number): ResolvedQueueOptions {
  return {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: {},
    prefix: 'bull',
    queueOptions: {},
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
    commandTimeoutMs,
    enqueueTimeoutMs,
  }
}

/** A service over a stub connection whose client reports `commandTimeout`. */
function makeService(commandTimeout?: number): { service: QueueService; queue: MockQueue } {
  const client = { options: commandTimeout === undefined ? {} : { commandTimeout } }
  const connection = {
    getClient: jest.fn().mockReturnValue(client),
  } as unknown as ConnectionResolver
  const service = new QueueService(connection, makeOptions(7000, 10_000))
  service.getOrCreateQueue('email')
  const queue = queues.at(-1)
  if (queue === undefined) throw new Error('no queue was created')
  return { service, queue }
}

/** The code and details of a QueueException. */
function describeException(err: unknown): { code: string; details: unknown } {
  const { error } = (err as QueueException).getResponse() as {
    error: { code: string; details: unknown }
  }
  return error
}

beforeEach(() => {
  queues.length = 0
})

describe('QueueService — a command timeout is reported as CONNECTION_TIMEOUT', () => {
  const calls: [string, string, (service: QueueService) => Promise<unknown>][] = [
    ['enqueue', 'add', (s) => s.enqueue('email', 'send', {})],
    ['enqueueBulk', 'addBulk', (s) => s.enqueueBulk('email', [{ name: 'send', data: {} }])],
    ['getJob', 'getJob', (s) => s.getJob('email', '1')],
    ['getJobs', 'getJobs', (s) => s.getJobs('email', 'waiting')],
    ['getMetrics', 'getJobCounts', (s) => s.getMetrics('email')],
    [
      'upsertJobScheduler',
      'upsertJobScheduler',
      (s) => s.upsertJobScheduler('email', 'tick', { every: 1000 }),
    ],
    ['removeJobScheduler', 'removeJobScheduler', (s) => s.removeJobScheduler('email', 'tick')],
    ['getJobSchedulers', 'getJobSchedulers', (s) => s.getJobSchedulers('email')],
    ['pauseQueue', 'pause', (s) => s.pauseQueue('email')],
    ['resumeQueue', 'resume', (s) => s.resumeQueue('email')],
    ['cleanQueue', 'clean', (s) => s.cleanQueue('email', 1000, 10)],
  ]

  it.each(calls)('%s names itself and the connection deadline', async (operation, method, call) => {
    const { service, queue } = makeService(5000)
    const cause = new Error('Command timed out')
    ;(queue[method] as jest.Mock).mockRejectedValue(cause)

    const err = await call(service).catch((e: unknown) => e)

    expect(describeException(err)).toMatchObject({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation, timeoutMs: 5000 },
    })
    expect((err as QueueException).cause).toBe(cause)
  })

  it.each(calls)('%s leaves any other failure as it is', async (_operation, method, call) => {
    const { service, queue } = makeService(5000)
    const failure = new Error('WRONGTYPE Operation against a key')
    ;(queue[method] as jest.Mock).mockRejectedValue(failure)

    const err = await call(service).catch((e: unknown) => e)

    // enqueueBulk reports every failure as a failed bulk enqueue; the rest pass through unchanged.
    if (err instanceof QueueException) {
      expect(describeException(err).code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
    } else {
      expect(err).toBe(failure)
    }
  })

  it('falls back to the configured command deadline when the client reports none', async () => {
    const { service, queue } = makeService()
    queue.getJob?.mockRejectedValue(new Error('Command timed out'))

    const err = await service.getJob('email', '1').catch((e: unknown) => e)

    expect(describeException(err).details).toStrictEqual({ operation: 'getJob', timeoutMs: 7000 })
  })
})

describe('QueueService — against a Redis that never replies, with real ioredis', () => {
  const servers: Server[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  /** Boot a service on a real owned connection to a server that accepts and stays silent. */
  async function silentRedis(
    commandTimeoutMs: number,
    enqueueTimeoutMs: number,
  ): Promise<{ service: QueueService; resolver: ConnectionResolver }> {
    const server = createServer((socket) => socket.on('error', () => undefined))
    servers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    const resolver = new ConnectionResolver({
      connection: {
        url: `redis://127.0.0.1:${String(port)}`,
        options: {
          enableReadyCheck: false,
          protocol: 2 as const,
          disableClientInfo: true,
          retryStrategy: () => 100,
        },
      },
      commandTimeoutMs,
    })
    await resolver.init()
    const service = new QueueService(resolver, makeOptions(commandTimeoutMs, enqueueTimeoutMs))
    service.getOrCreateQueue('email')
    const queue = queues.at(-1)
    if (queue === undefined) throw new Error('no queue was created')
    // The mocked Queue issues one real command on the real connection, as BullMQ's add does.
    queue.add?.mockImplementation(() => resolver.getClient().get('job'))
    return { service, resolver }
  }

  // With the defaults the command deadline (5 s) passes before the enqueue deadline (10 s), so the
  // rejection a caller sees is ioredis's, and it must still be the documented timeout code.
  it('rejects enqueue with CONNECTION_TIMEOUT when the command deadline passes first', async () => {
    const { service, resolver } = await silentRedis(300, 10_000)

    const started = Date.now()
    const err = await service.enqueue('email', 'send', {}).catch((e: unknown) => e)

    expect(describeException(err)).toMatchObject({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation: 'enqueue', timeoutMs: 300 },
    })
    expect(Date.now() - started).toBeLessThan(3000)
    resolver.getClient().disconnect()
  })

  // The control: a long command deadline leaves the enqueue deadline to end the wait.
  it('rejects enqueue at the enqueue deadline when the command deadline is longer', async () => {
    const { service, resolver } = await silentRedis(30_000, 400)

    const err = await service.enqueue('email', 'send', {}).catch((e: unknown) => e)

    expect(describeException(err)).toMatchObject({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation: 'enqueue', timeoutMs: 400 },
    })
    resolver.getClient().disconnect()
  })
})
