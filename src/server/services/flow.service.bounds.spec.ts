/**
 * @fileoverview Unit tests for the bounds on `FlowService` calls: a wall-clock deadline of
 * `enqueueTimeoutMs`, and a cap on the number of trees one `addBulk` accepts. The BullMQ
 * `FlowProducer` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { FlowJob } from 'bullmq'
import { FlowService } from './flow.service'
import type { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'

const producers: { add: jest.Mock; addBulk: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  FlowProducer: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn(),
      addBulk: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })
    producers.push(instance)
    return instance
  }),
}))

const flow = { name: 'parent', queueName: 'q', data: {} } as FlowJob

/** A flow service with a 3 s enqueue deadline, and its mocked producer. */
function makeFlow(): { service: FlowService; producer: (typeof producers)[number] } {
  const connection = {
    getClient: jest.fn().mockReturnValue({ options: { commandTimeout: 5000 } }),
  } as unknown as ConnectionResolver
  const service = new FlowService(connection, true, 'bull', undefined, 3000)
  const producer = producers.at(-1)
  if (producer === undefined) throw new Error('no producer was created')
  return { service, producer }
}

/** The code and details of a QueueException. */
function describeException(err: unknown): { code: string; details: unknown } {
  const { error } = (err as QueueException).getResponse() as {
    error: { code: string; details: unknown }
  }
  return { code: error.code, details: error.details }
}

/** The HTTP status a QueueException carries. */
function statusOf(err: unknown): number {
  return (err as QueueException).getStatus()
}

beforeEach(() => {
  producers.length = 0
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('FlowService — the enqueue deadline', () => {
  it.each(['add', 'addBulk'] as const)(
    'releases the caller of %s with CONNECTION_TIMEOUT when the producer never answers',
    async (method) => {
      const { service, producer } = makeFlow()
      producer[method].mockReturnValue(new Promise(() => undefined))

      const outcome = (method === 'add' ? service.add(flow) : service.addBulk([flow])).catch(
        (e: unknown) => e,
      )
      await jest.advanceTimersByTimeAsync(2999)
      let settled = false
      void outcome.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      await jest.advanceTimersByTimeAsync(1)

      expect(statusOf(await outcome)).toBe(503)
      expect(describeException(await outcome)).toStrictEqual({
        code: 'queue.connection_timeout',
        details: {
          operation: method === 'add' ? 'addFlow' : 'addFlowBulk',
          timeoutMs: 3000,
        },
      })
    },
  )

  it('holds no timer once the producer answers', async () => {
    const { service, producer } = makeFlow()
    producer.add.mockResolvedValue({ job: { id: '1' } })

    await expect(service.add(flow)).resolves.toStrictEqual({ job: { id: '1' } })
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('FlowService — the addBulk count cap', () => {
  it('accepts 1000 trees and refuses 1001 with BULK_ENQUEUE_FAILED, without calling the producer', async () => {
    const { service, producer } = makeFlow()
    producer.addBulk.mockResolvedValue([])

    await service.addBulk(Array.from({ length: 1000 }, () => flow))
    const err = await service
      .addBulk(Array.from({ length: 1001 }, () => flow))
      .catch((e: unknown) => e)

    expect(producer.addBulk).toHaveBeenCalledTimes(1)
    expect(statusOf(err)).toBe(400)
    expect(describeException(err)).toStrictEqual({
      code: 'queue.bulk_enqueue_failed',
      details: { reason: 'batch size exceeds limit', limit: 1000, received: 1001 },
    })
  })
})
