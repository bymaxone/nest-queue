/**
 * @fileoverview Unit tests for the first call on a queue the service has not used before while the
 * client is not ready, and for a call refused because the connection is down. BullMQ's `Queue` is
 * mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { QueueService } from './queue.service'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
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
    for (const method of QUEUE_METHODS) instance[method] = jest.fn().mockResolvedValue(undefined)
    queues.push(instance)
    return instance
  }),
}))

const options: ResolvedQueueOptions = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: false },
  metrics: { enabled: false, cacheTtlMs: 5000 },
  shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
}

/** A service whose connection's ready-wait is the given promise factory. */
function makeService(awaitReady: jest.Mock): QueueService {
  const connection = {
    getClient: jest.fn().mockReturnValue({ options: { commandTimeout: 5000 } }),
    awaitReady,
  } as unknown as ConnectionResolver
  return new QueueService(connection, options)
}

/** The code and details of a QueueException. */
function describeException(err: unknown): { code: string; details: unknown } {
  const { error } = (err as QueueException).getResponse() as {
    error: { code: string; details: unknown }
  }
  return error
}

const calls: [string, string, (s: QueueService) => Promise<unknown>][] = [
  ['enqueue', 'add', (s) => s.enqueue('cold', 'send', {})],
  ['enqueueBulk', 'addBulk', (s) => s.enqueueBulk('cold', [{ name: 'send', data: {} }])],
  ['getJob', 'getJob', (s) => s.getJob('cold', '1')],
  ['getJobs', 'getJobs', (s) => s.getJobs('cold', 'waiting')],
  ['getMetrics', 'getJobCounts', (s) => s.getMetrics('cold')],
  [
    'upsertJobScheduler',
    'upsertJobScheduler',
    (s) => s.upsertJobScheduler('cold', 'tick', { every: 1000 }),
  ],
  ['removeJobScheduler', 'removeJobScheduler', (s) => s.removeJobScheduler('cold', 'tick')],
  ['getJobSchedulers', 'getJobSchedulers', (s) => s.getJobSchedulers('cold')],
  ['pauseQueue', 'pause', (s) => s.pauseQueue('cold')],
  ['resumeQueue', 'resume', (s) => s.resumeQueue('cold')],
  ['cleanQueue', 'clean', (s) => s.cleanQueue('cold', 1000, 10)],
]

beforeEach(() => {
  queues.length = 0
})

afterEach(() => {
  jest.useRealTimers()
})

describe('QueueService — a cold queue while the client is not ready', () => {
  // Before this, BullMQ waited for `ready` with no deadline, so the call hung for the outage.
  it.each(calls)(
    '%s rejects at the call deadline, naming itself',
    async (operation, _method, call) => {
      jest.useFakeTimers()
      const service = makeService(jest.fn().mockReturnValue(new Promise(() => undefined)))

      const outcome = call(service).catch((err: unknown) => err)
      await jest.advanceTimersByTimeAsync(9999)
      await jest.advanceTimersByTimeAsync(1)

      expect(describeException(await outcome)).toStrictEqual({
        code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
        message: 'Redis connection timeout',
        details: { operation, timeoutMs: 10_000 },
      })
    },
  )

  // A call that was refused must not run later: a late enqueue would duplicate its retry.
  it('never runs a call that already timed out, even when Redis returns afterwards', async () => {
    jest.useFakeTimers()
    let ready: () => void = () => undefined
    const service = makeService(
      jest.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          ready = resolve
        }),
      ),
    )

    const outcome = service.enqueue('cold', 'send', {}).catch((err: unknown) => err)
    await jest.advanceTimersByTimeAsync(10_000)
    await outcome
    ready()
    await jest.advanceTimersByTimeAsync(0)

    expect(queues.every((queue) => queue.add?.mock.calls.length === 0)).toBe(true)
  })

  it('runs the call once the client is ready, and does not wait again for that queue', async () => {
    const awaitReady = jest.fn().mockResolvedValue(undefined)
    const service = makeService(awaitReady)

    await service.getJob('cold', '1')
    await service.getJob('cold', '2')

    expect(awaitReady).toHaveBeenCalledTimes(1)
    expect(queues[0]?.getJob).toHaveBeenCalledTimes(2)
  })

  it('waits separately for a second queue name', async () => {
    const awaitReady = jest.fn().mockResolvedValue(undefined)
    const service = makeService(awaitReady)

    await service.getJob('one', '1')
    await service.getJob('two', '1')

    expect(awaitReady).toHaveBeenCalledTimes(2)
  })
})

describe('QueueService — a call refused because the connection is down', () => {
  it.each(calls)(
    '%s reports CONNECTION_TIMEOUT with reason offline',
    async (operation, method, call) => {
      const service = makeService(jest.fn().mockResolvedValue(undefined))
      const service2 = service
      service2.getOrCreateQueue('cold')
      const cause = new Error("Stream isn't writeable and enableOfflineQueue options is false")
      queues[0]?.[method]?.mockRejectedValue(cause)

      const err = await call(service).catch((e: unknown) => e)

      expect(describeException(err)).toMatchObject({
        code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
        details: { operation, reason: 'offline' },
      })
      expect((err as QueueException).cause).toBe(cause)
    },
  )
})
