/**
 * @fileoverview Unit tests for how `QueueService` treats a job id that is one of the queue's own
 * Redis key names: enqueue and bulk enqueue refuse it before BullMQ is called, and a read answers
 * "not found" without a Redis call. BullMQ's `Queue` is mocked, so what is pinned is that nothing
 * reaches it.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { QueueService } from './queue.service'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { RESERVED_JOB_IDS } from '../utils/reserved-job-ids'
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

describe('QueueService — a job id that is one of the queue keys', () => {
  it.each([...RESERVED_JOB_IDS])('enqueue refuses %s before BullMQ is called', async (jobId) => {
    const { service, queue } = makeService()

    const err = await rejection(() => service.enqueue('email', 'send', {}, { jobId }))

    expect(err.getStatus()).toBe(400)
    expect(envelope(err)).toEqual({
      code: QUEUE_ERROR_CODES.INVALID_JOB_ID,
      details: { field: 'jobId' },
    })
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('enqueueBulk refuses the whole batch when one job has such an id, and calls nothing', async () => {
    const { service, queue } = makeService()

    const err = await rejection(() =>
      service.enqueueBulk('email', [
        { name: 'send', data: {}, options: { jobId: 'fine' } },
        { name: 'send', data: {}, options: { jobId: 'active' } },
      ]),
    )

    expect(envelope(err).code).toBe(QUEUE_ERROR_CODES.INVALID_JOB_ID)
    expect(err.getStatus()).toBe(400)
    expect(queue.addBulk).not.toHaveBeenCalled()
  })

  it.each([...RESERVED_JOB_IDS])(
    'getJob answers null for %s without a Redis call',
    async (jobId) => {
      const { service, queue } = makeService()

      await expect(service.getJob('email', jobId)).resolves.toBeNull()

      expect(queue.getJob).not.toHaveBeenCalled()
    },
  )

  it('still enqueues, bulk enqueues and reads an ordinary id', async () => {
    const { service, queue } = makeService()

    await service.enqueue('email', 'send', {}, { jobId: 'dlq-1' })
    await service.enqueueBulk('email', [{ name: 'send', data: {}, options: { jobId: 'dlq-2' } }])
    await service.getJob('email', 'dlq-1')

    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(queue.addBulk).toHaveBeenCalledTimes(1)
    expect(queue.getJob).toHaveBeenCalledWith('dlq-1')
  })
})
