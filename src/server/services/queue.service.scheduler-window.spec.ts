/**
 * @fileoverview Unit tests for the `getJobSchedulers` window, which is bounded like `getJobs`:
 * BullMQ reads `-1` as "every scheduler", an unbounded reply held in memory. `Queue` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { QueueService } from './queue.service'
import type { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

const queues: { getJobSchedulers: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      getJobSchedulers: jest.fn().mockResolvedValue([]),
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

describe('QueueService — the getJobSchedulers window', () => {
  it('keeps the default window and accepts a window of 1000', async () => {
    const { service, queue } = makeService()

    await service.getJobSchedulers('email')
    await service.getJobSchedulers('email', 0, 999, false)

    expect(queue.getJobSchedulers).toHaveBeenNthCalledWith(1, 0, 50, true)
    expect(queue.getJobSchedulers).toHaveBeenNthCalledWith(2, 0, 999, false)
  })

  it.each([
    [0, -1],
    [0, 1000],
    [5, 4],
    [-1, 10],
    [0.5, 10],
    [0, Number.NaN],
  ])('refuses the window %s..%s with INVALID_OPTIONS and never asks BullMQ', async (start, end) => {
    const { service, queue } = makeService()

    const err = await service.getJobSchedulers('email', start, end).catch((e: unknown) => e)

    const { error } = (err as QueueException).getResponse() as {
      error: { code: string; details: unknown }
    }
    expect(error.code).toBe('queue.invalid_options')
    expect(error.details).toStrictEqual({
      reason:
        'getJobSchedulers needs integers with 0 <= start <= end and at most 1000 jobs per call',
    })
    expect(queue.getJobSchedulers).not.toHaveBeenCalled()
  })
})
