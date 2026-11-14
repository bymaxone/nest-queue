/**
 * @fileoverview Unit tests for the documented timeout code on `FlowService` calls. The BullMQ
 * `FlowProducer` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { FlowJob } from 'bullmq'
import { FlowService } from './flow.service'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'

/** Minimal mock of the BullMQ FlowProducer. */
interface MockFlowProducer {
  add: jest.Mock
  addBulk: jest.Mock
}

const producers: MockFlowProducer[] = []

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

/** A flow service over a client that reports `commandTimeout`, and its mocked producer. */
function makeFlow(commandTimeout?: number): { service: FlowService; producer: MockFlowProducer } {
  const client = { options: commandTimeout === undefined ? {} : { commandTimeout } }
  const connection = {
    getClient: jest.fn().mockReturnValue(client),
  } as unknown as ConnectionResolver
  const service = new FlowService(connection, true, 'bull')
  const producer = producers.at(-1)
  if (producer === undefined) throw new Error('no producer was created')
  return { service, producer }
}

/** The code and details of a QueueException. */
function describeException(err: unknown): { code: string; details: unknown } {
  const { error } = (err as QueueException).getResponse() as {
    error: { code: string; details: unknown }
  }
  return error
}

beforeEach(() => {
  producers.length = 0
})

describe('FlowService — a command timeout is reported as CONNECTION_TIMEOUT', () => {
  it.each([
    ['addFlow', 'add', (s: FlowService) => s.add(flow)],
    ['addFlowBulk', 'addBulk', (s: FlowService) => s.addBulk([flow])],
  ])('%s names itself and the connection deadline', async (operation, method, call) => {
    const { service, producer } = makeFlow(5000)
    const cause = new Error('Command timed out')
    producer[method as keyof MockFlowProducer].mockRejectedValue(cause)

    const err = await call(service).catch((e: unknown) => e)

    expect(describeException(err)).toMatchObject({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation, timeoutMs: 5000 },
    })
    expect((err as QueueException).cause).toBe(cause)
  })

  it('reports a zero deadline when the client carries none, and leaves other failures alone', async () => {
    const { service, producer } = makeFlow()
    producer.add.mockRejectedValueOnce(new Error('Command timed out'))
    const failure = new Error('WRONGTYPE Operation against a key')
    producer.addBulk.mockRejectedValueOnce(failure)

    const timedOut = await service.add(flow).catch((e: unknown) => e)
    const other = await service.addBulk([flow]).catch((e: unknown) => e)

    expect(describeException(timedOut).details).toStrictEqual({
      operation: 'addFlow',
      timeoutMs: 0,
    })
    expect(other).toBe(failure)
  })
})
