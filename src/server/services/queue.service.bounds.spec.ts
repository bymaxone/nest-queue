/**
 * @fileoverview Unit tests for the exact error contents and boundaries of the bounded
 * `QueueService` calls: the enqueue deadline, the bulk wrapper and the `getJobs` window. BullMQ's
 * `Queue` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Job } from 'bullmq'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** The mocked Queue instances, in creation order. */
const queues: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn(),
      addBulk: jest.fn(),
      getJobs: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })
    queues.push(instance)
    return instance
  }),
}))

/** A service over a stub connection, with a queue already created for `email`. */
function makeService(): { service: QueueService; queue: (typeof queues)[number] } {
  const connection = {
    getClient: jest.fn().mockReturnValue({ id: 'client' }),
    awaitReady: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionResolver
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
  const service = new QueueService(connection, options)
  service.getOrCreateQueue('email')
  const queue = queues.at(-1)
  if (queue === undefined) throw new Error('no queue was created')
  return { service, queue }
}

/** The `{ error: { code, message, details } }` envelope of a QueueException, and its status. */
function envelope(err: unknown): { code: string; details: unknown; status: number } {
  const exception = err as QueueException
  const { error } = exception.getResponse() as { error: { code: string; details: unknown } }
  return { code: error.code, details: error.details, status: exception.getStatus() }
}

beforeEach(() => {
  queues.length = 0
})

afterEach(() => {
  jest.useRealTimers()
})

describe('QueueService — what a timed-out call reports', () => {
  it.each([
    ['enqueue', (service: QueueService) => service.enqueue('email', 'send', {})],
    [
      'enqueueBulk',
      (service: QueueService) => service.enqueueBulk('email', [{ name: 'send', data: {} }]),
    ],
  ])('names the operation and the deadline for %s', async (operation, call) => {
    jest.useFakeTimers()
    const { service, queue } = makeService()
    queue.add.mockReturnValue(new Promise(() => undefined))
    queue.addBulk.mockReturnValue(new Promise(() => undefined))

    const outcome = call(service).catch((err: unknown) => err)
    await jest.advanceTimersByTimeAsync(10_000)

    expect(envelope(await outcome)).toStrictEqual({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation, timeoutMs: 10_000 },
      status: 500,
    })
  })
})

describe('QueueService — enqueueBulk failures', () => {
  // Only the deadline error passes through unchanged; any other failure, a QueueException included,
  // is reported as a failed bulk enqueue.
  it('wraps a QueueException that is not the deadline error', async () => {
    const { service, queue } = makeService()
    queue.addBulk.mockRejectedValue(new QueueException(QUEUE_ERROR_CODES.INVALID_JOB_DATA))

    const err = await service
      .enqueueBulk('email', [{ name: 'send', data: {} }])
      .catch((e: unknown) => e)

    expect(envelope(err).code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
  })
})

describe('QueueService — the getJobs window', () => {
  it('accepts a window of a single job', async () => {
    const { service, queue } = makeService()
    queue.getJobs.mockResolvedValue([{ id: '1' } as Job])

    await expect(service.getJobs('email', 'waiting', 5, 5)).resolves.toHaveLength(1)

    expect(queue.getJobs).toHaveBeenCalledWith(['waiting'], 5, 5)
  })

  it('says what a valid window is when it refuses one', async () => {
    const { service } = makeService()

    const err = await service.getJobs('email', 'waiting', 0, -1).catch((e: unknown) => e)

    expect(envelope(err)).toStrictEqual({
      code: QUEUE_ERROR_CODES.INVALID_OPTIONS,
      details: {
        reason: 'getJobs needs integers with 0 <= start <= end and at most 1000 jobs per call',
      },
      status: 400,
    })
  })
})
