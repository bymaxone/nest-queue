/**
 * @fileoverview Unit tests for what the `QueueService` calls that write report when Redis refuses
 * them for lack of memory: `STORAGE_FULL` (503) on `enqueue` and, unwrapped, on `enqueueBulk`,
 * where every other failure is `BULK_ENQUEUE_FAILED`. BullMQ's `Queue` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { QueueService } from './queue.service'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** The mocked Queue instances, in creation order. */
const queues: { add: jest.Mock; addBulk: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn(),
      addBulk: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })
    queues.push(instance)
    return instance
  }),
}))

/** What Redis answers a write it refuses under `maxmemory` with `noeviction`. */
const OOM = Object.assign(
  new Error(
    "OOM command not allowed when used memory > 'maxmemory'. script: abc, on @user_script:1.",
  ),
  { name: 'ReplyError' },
)

/** A service over a stub connection, and the mocked queue it created for `email`. */
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
    metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
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

/** Run `work` and return what it rejected with. */
async function rejection(work: () => Promise<unknown>): Promise<QueueException> {
  try {
    await work()
  } catch (err) {
    return err as QueueException
  }
  throw new Error('the call did not reject')
}

/** The code and details of a QueueException. */
function envelope(err: QueueException): { code: string; details: unknown } {
  const { error } = err.getResponse() as { error: { code: string; details: unknown } }
  return { code: error.code, details: error.details }
}

beforeEach(() => {
  queues.length = 0
})

describe('QueueService — Redis out of memory', () => {
  it('enqueue reports STORAGE_FULL (503)', async () => {
    const { service, queue } = makeService()
    queue.add.mockRejectedValue(OOM)

    const err = await rejection(() => service.enqueue('email', 'send', {}))

    expect(err.getStatus()).toBe(503)
    expect(envelope(err)).toEqual({
      code: QUEUE_ERROR_CODES.STORAGE_FULL,
      details: { operation: 'enqueue', reason: 'out_of_memory' },
    })
    expect(err.cause).toMatchObject({ name: 'RedisCommandError', code: 'OOM' })
  })

  it('enqueueBulk reports STORAGE_FULL (503), not BULK_ENQUEUE_FAILED', async () => {
    const { service, queue } = makeService()
    queue.addBulk.mockRejectedValue(OOM)

    const err = await rejection(() => service.enqueueBulk('email', [{ name: 'send', data: {} }]))

    expect(err.getStatus()).toBe(503)
    expect(envelope(err)).toEqual({
      code: QUEUE_ERROR_CODES.STORAGE_FULL,
      details: { operation: 'enqueueBulk', reason: 'out_of_memory' },
    })
    expect(err.cause).toMatchObject({ name: 'RedisCommandError', code: 'OOM' })
  })

  it('enqueueBulk still reports any other failure as BULK_ENQUEUE_FAILED (500)', async () => {
    const { service, queue } = makeService()
    queue.addBulk.mockRejectedValue(new Error('WRONGTYPE Operation against a key'))

    const err = await rejection(() => service.enqueueBulk('email', [{ name: 'send', data: {} }]))

    expect(err.getStatus()).toBe(500)
    expect(envelope(err).code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
  })
})
