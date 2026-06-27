/**
 * @fileoverview Unit tests for QueueEventsRegistry. BullMQ `QueueEvents` is
 * mocked so no real Redis connection is needed.
 * @layer server/services
 */

import { QueueEventsRegistry } from './queue-events-registry.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { Redis } from 'ioredis'

/** Track instances created by the mocked constructor. */
const createdQueueEvents: MockQueueEventsInstance[] = []

interface MockQueueEventsInstance {
  close: jest.MockedFunction<() => Promise<void>>
}

jest.mock('bullmq', () => ({
  QueueEvents: jest.fn().mockImplementation(() => {
    const instance: MockQueueEventsInstance = {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    }
    createdQueueEvents.push(instance)
    return instance
  }),
}))

function fakeRedis(): Redis {
  return {
    duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
  } as unknown as Redis
}

function fakeConnection(redis?: Redis): ConnectionResolver {
  return {
    getClient: jest.fn<Redis, []>().mockReturnValue(redis ?? fakeRedis()),
  } as unknown as ConnectionResolver
}

beforeEach(() => {
  createdQueueEvents.length = 0
})

describe('QueueEventsRegistry.getOrCreate', () => {
  it('creates a QueueEvents on first call and returns it', () => {
    // First call must instantiate and cache a QueueEvents for the queue.
    const registry = new QueueEventsRegistry(fakeConnection())
    const qe = registry.getOrCreate('email')
    expect(qe).toBeDefined()
    expect(createdQueueEvents).toHaveLength(1)
  })

  it('constructs QueueEvents with the duplicated connection', () => {
    // The QueueEvents must be bound to the library-duplicated connection (blocking
    // SUBSCRIBE needs maxRetriesPerRequest: null), not an empty/default options bag.
    const { QueueEvents: MockQueueEvents } = jest.requireMock<{ QueueEvents: jest.Mock }>('bullmq')
    const redis = fakeRedis()
    const registry = new QueueEventsRegistry(fakeConnection(redis))
    registry.getOrCreate('email')
    const dup = (redis.duplicate as jest.Mock).mock.results[0]!.value as unknown
    expect(MockQueueEvents).toHaveBeenCalledWith('email', { connection: dup })
  })

  it('disconnects the duplicated connection when QueueEvents constructor throws (no leak)', () => {
    // A failed QueueEvents construction must not leave a dangling Redis connection.
    const { QueueEvents: MockQueueEvents } = jest.requireMock<{
      QueueEvents: jest.Mock
    }>('bullmq')
    MockQueueEvents.mockImplementationOnce(() => {
      throw new Error('subscribe failed')
    })
    const redis = fakeRedis()
    const registry = new QueueEventsRegistry(fakeConnection(redis))
    expect(() => registry.getOrCreate('email')).toThrow('subscribe failed')
    const dupResult = (redis.duplicate as jest.Mock).mock.results[0]!.value as {
      disconnect: jest.Mock
    }
    expect(dupResult.disconnect).toHaveBeenCalledTimes(1)
  })

  it('returns the same instance on subsequent calls (idempotent)', () => {
    // Idempotency is critical — no second Redis connection must be opened.
    const registry = new QueueEventsRegistry(fakeConnection())
    const first = registry.getOrCreate('email')
    const second = registry.getOrCreate('email')
    expect(first).toBe(second)
    expect(createdQueueEvents).toHaveLength(1)
  })

  it('creates separate instances for different queues', () => {
    // Each queue requires its own QueueEvents (and its own Redis connection).
    const registry = new QueueEventsRegistry(fakeConnection())
    const emailQe = registry.getOrCreate('email')
    const smsQe = registry.getOrCreate('sms')
    expect(emailQe).not.toBe(smsQe)
    expect(createdQueueEvents).toHaveLength(2)
  })
})

describe('QueueEventsRegistry.list / getAll', () => {
  it('list returns the names of queues with an open QueueEvents', () => {
    // list() surfaces which queues currently have a QueueEvents connection.
    const registry = new QueueEventsRegistry(fakeConnection())
    registry.getOrCreate('email')
    registry.getOrCreate('sms')
    expect(registry.list()).toEqual(expect.arrayContaining(['email', 'sms']))
  })

  it('getAll returns a ReadonlyMap of all QueueEvents', () => {
    // getAll() is used by the shutdown orchestrator.
    const registry = new QueueEventsRegistry(fakeConnection())
    registry.getOrCreate('email')
    const map = registry.getAll()
    expect(map.size).toBe(1)
    expect(map.has('email')).toBe(true)
  })
})

describe('QueueEventsRegistry.getConnections', () => {
  it('exposes the duplicated connection opened per queue', () => {
    // The shutdown orchestrator closes exactly these library-created connections.
    const registry = new QueueEventsRegistry(fakeConnection())
    registry.getOrCreate('email')
    registry.getOrCreate('sms')
    const connections = registry.getConnections()
    expect(connections.size).toBe(2)
    expect(connections.has('email')).toBe(true)
    expect(connections.has('sms')).toBe(true)
  })

  it('returns an empty map before any QueueEvents are created', () => {
    // With nothing observed there are no library-created connections to close.
    const registry = new QueueEventsRegistry(fakeConnection())
    expect(registry.getConnections().size).toBe(0)
  })
})
