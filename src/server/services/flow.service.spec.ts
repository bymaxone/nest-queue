/**
 * @fileoverview Unit tests for FlowService. The BullMQ `FlowProducer` is mocked
 * so no real Redis connection is required.
 * @layer server/services
 */

import type { FlowJob, JobNode, Telemetry } from 'bullmq'
import { FlowService } from './flow.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'

/** Minimal mock of the BullMQ FlowProducer returned by the mocked constructor. */
interface MockFlowProducer {
  add: jest.Mock
  addBulk: jest.Mock
  close: jest.MockedFunction<() => Promise<void>>
}

const producerInstances: MockFlowProducer[] = []
const producerConstructorArgs: unknown[][] = []

jest.mock('bullmq', () => ({
  FlowProducer: jest.fn().mockImplementation((...args: unknown[]) => {
    producerConstructorArgs.push(args)
    const instance: MockFlowProducer = {
      add: jest.fn(),
      addBulk: jest.fn(),
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    }
    producerInstances.push(instance)
    return instance
  }),
}))

const fakeClient = { id: 'flow-client' }

/** Build a ConnectionResolver stub returning a fixed client. */
function makeConnection(): ConnectionResolver {
  return { getClient: jest.fn().mockReturnValue(fakeClient) } as unknown as ConnectionResolver
}

/** Extract the error code carried by a QueueException response body. */
function codeOf(err: unknown): string {
  return ((err as QueueException).getResponse() as { error: { code: string } }).error.code
}

beforeEach(() => {
  producerInstances.length = 0
  producerConstructorArgs.length = 0
})

describe('FlowService — enabled', () => {
  it('constructs a FlowProducer on the main connection', () => {
    // When enabled, the producer is built with the resolver's Queue-role client.
    new FlowService(makeConnection(), true)

    expect(producerConstructorArgs).toHaveLength(1)
    const [opts] = producerConstructorArgs[0] as [{ connection: unknown }]
    expect(opts.connection).toBe(fakeClient)
  })

  it('delegates add to the underlying producer', async () => {
    // add forwards the flow definition unchanged and returns the producer result.
    const service = new FlowService(makeConnection(), true)
    const flow = { name: 'root', queueName: 'pdf', data: {} } as FlowJob
    const node = { job: { id: '1' } } as unknown as JobNode
    producerInstances[0]?.add.mockResolvedValue(node)

    await expect(service.add(flow)).resolves.toBe(node)
    expect(producerInstances[0]?.add).toHaveBeenCalledWith(flow)
  })

  it('delegates addBulk to the underlying producer as a mutable array', async () => {
    // addBulk copies the readonly input into the array BullMQ expects.
    const service = new FlowService(makeConnection(), true)
    const flows = [{ name: 'a', queueName: 'q', data: {} }] as FlowJob[]
    const nodes = [{ job: { id: '1' } }] as unknown as JobNode[]
    producerInstances[0]?.addBulk.mockResolvedValue(nodes)

    await expect(service.addBulk(flows)).resolves.toBe(nodes)
    expect(producerInstances[0]?.addBulk).toHaveBeenCalledWith([flows[0]])
  })

  it('returns the underlying producer from getProducer', () => {
    // getProducer exposes the constructed FlowProducer instance.
    const service = new FlowService(makeConnection(), true)

    expect(service.getProducer()).toBe(producerInstances[0])
  })

  it('passes the configured telemetry into the FlowProducer constructor', () => {
    // A configured telemetry instance reaches the producer so spans propagate to children.
    const telemetry = { name: 'sentinel-telemetry' } as unknown as Telemetry
    new FlowService(makeConnection(), true, telemetry)

    const [opts] = producerConstructorArgs[0] as [{ telemetry?: unknown }]
    expect(opts.telemetry).toBe(telemetry)
  })

  it('omits the telemetry key when telemetry is not configured', () => {
    // Without telemetry, the producer options never carry the key.
    new FlowService(makeConnection(), true)

    const [opts] = producerConstructorArgs[0] as [Record<string, unknown>]
    expect('telemetry' in opts).toBe(false)
  })
})

describe('FlowService — disabled', () => {
  it('does not construct a FlowProducer', () => {
    // When disabled, no producer is built (no Redis connection is opened).
    new FlowService(makeConnection(), false)

    expect(producerConstructorArgs).toHaveLength(0)
  })

  it('throws FLOW_DISABLED (503) from add', async () => {
    // add is guarded and rejects with the typed disabled error.
    const service = new FlowService(makeConnection(), false)

    await expect(service.add({} as FlowJob)).rejects.toBeInstanceOf(QueueException)
    await service.add({} as FlowJob).catch((err: unknown) => {
      expect(codeOf(err)).toBe(QUEUE_ERROR_CODES.FLOW_DISABLED)
      expect((err as QueueException).getStatus()).toBe(503)
    })
  })

  it('throws FLOW_DISABLED from addBulk', async () => {
    // addBulk is guarded the same way as add.
    const service = new FlowService(makeConnection(), false)

    await expect(service.addBulk([])).rejects.toBeInstanceOf(QueueException)
  })

  it('throws FLOW_DISABLED from getProducer', () => {
    // getProducer cannot return a producer that was never created.
    const service = new FlowService(makeConnection(), false)

    expect(() => service.getProducer()).toThrow(QueueException)
  })
})

describe('FlowService — onModuleDestroy', () => {
  it('closes the producer when active', async () => {
    // Shutdown closes the active producer exactly once.
    const service = new FlowService(makeConnection(), true)

    await service.onModuleDestroy()

    expect(producerInstances[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('swallows a close rejection', async () => {
    // A failing close must not abort the shutdown sequence.
    const service = new FlowService(makeConnection(), true)
    producerInstances[0]?.close.mockRejectedValue(new Error('close failed'))

    await expect(service.onModuleDestroy()).resolves.toBeUndefined()
  })

  it('is a no-op when inactive', async () => {
    // With no producer there is nothing to close.
    const service = new FlowService(makeConnection(), false)

    await expect(service.onModuleDestroy()).resolves.toBeUndefined()
    expect(producerInstances).toHaveLength(0)
  })
})
