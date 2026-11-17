/**
 * @fileoverview Unit tests for the job options `QueueService` refuses before BullMQ is called: a
 * value BullMQ would drop, fail on or read as "no limit" in `enqueue`, or in any job of a bulk,
 * names the option and path and sends nothing. BullMQ's `Queue` is mocked, so what is pinned is
 * that nothing reaches it.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { JobsOptions } from 'bullmq'
import { QueueService } from './queue.service'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** The mocked Queue instances, in creation order. */
const queues: { add: jest.Mock; addBulk: jest.Mock; getJob: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue({ id: 'created' }),
      addBulk: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue({ id: 'found' }),
      close: jest.fn().mockResolvedValue(undefined),
    })
    queues.push(instance)
    return instance
  }),
}))

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

describe('QueueService — job options BullMQ would not honour', () => {
  it.each([Infinity, NaN, -1, 1.5, 'x'])(
    'enqueue refuses a delay of %j and sends nothing',
    async (delay) => {
      const { service, queue } = makeService()

      const err = await rejection(() =>
        service.enqueue('email', 'send', {}, { delay } as unknown as JobsOptions),
      )

      expect(err.getStatus()).toBe(400)
      const { code, details } = envelope(err)
      expect(code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
      expect((details as { reason: string }).reason).toContain('options.delay')
      expect(queue.add).not.toHaveBeenCalled()
    },
  )

  it('enqueueBulk refuses the whole batch and names the job whose option is bad', async () => {
    const { service, queue } = makeService()

    const err = await rejection(() =>
      service.enqueueBulk('email', [
        { name: 'send', data: {}, options: { delay: 10 } },
        { name: 'send', data: {}, options: { attempts: Infinity } },
      ]),
    )

    expect(err.getStatus()).toBe(400)
    expect((envelope(err).details as { reason: string }).reason).toContain(
      'jobs[1].options.attempts',
    )
    expect(queue.addBulk).not.toHaveBeenCalled()
  })

  it('still enqueues options that are sound', async () => {
    const { service, queue } = makeService()

    await service.enqueue(
      'email',
      'send',
      {},
      { delay: 10, attempts: 3, removeOnFail: { count: 5 } },
    )

    expect(queue.add).toHaveBeenCalledTimes(1)
  })
})
