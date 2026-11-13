/**
 * @fileoverview Unit tests for `WorkerRegistry.unregister`. BullMQ `Worker` is mocked so no real
 * Redis connection is needed.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** Minimal mock of the BullMQ Worker instance returned by the mocked constructor. */
type MockWorkerInstance = EventEmitter & {
  close: jest.MockedFunction<() => Promise<void>>
}

/** Instances created by the mocked constructor, so tests can inspect them. */
const createdWorkers: MockWorkerInstance[] = []

// Backed by a real EventEmitter, like BullMQ's `Worker`, so an unlistened `error` behaves as in
// production.
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    }) as MockWorkerInstance
    createdWorkers.push(instance)
    return instance
  }),
}))

/** A fake Redis whose `duplicate()` returns a stub with `quit`/`disconnect`. */
function fakeRedis(): Redis {
  return {
    duplicate: jest.fn().mockImplementation(() => ({
      status: 'ready',
      disconnect: jest.fn(),
      quit: jest.fn<Promise<string>, []>().mockResolvedValue('OK'),
    })),
  } as unknown as Redis
}

/** Build a `ConnectionResolver` stub with a controllable `getClient`. */
function fakeConnection(redis?: Redis): ConnectionResolver {
  return {
    getClient: jest.fn<Redis, []>().mockReturnValue(redis ?? fakeRedis()),
  } as unknown as ConnectionResolver
}

/** Build resolved options for the registry under test. */
function makeOptions(): ResolvedQueueOptions {
  return {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: { attempts: 3 },
    prefix: 'bull',
    queueOptions: {},
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
    commandTimeoutMs: 5000,
    enqueueTimeoutMs: 10000,
  }
}

/** A minimal job handler used as the process function. */
function noopHandler(_job: Job): Promise<unknown> {
  return Promise.resolve(undefined)
}

beforeEach(() => {
  createdWorkers.length = 0
})

describe('WorkerRegistry.unregister', () => {
  it('closes the worker, releases its connection, and removes it from the map', async () => {
    // unregister must close(), quit the duplicated connection, and drop the entry.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    const [worker] = createdWorkers
    const conn = registry.getConnections().get('email') as unknown as { quit: jest.Mock }
    await registry.unregister('email')
    expect(worker?.close).toHaveBeenCalledTimes(1)
    expect(conn.quit).toHaveBeenCalledTimes(1)
    expect(registry.list()).not.toContain('email')
    expect(registry.getConnections().has('email')).toBe(false)
  })

  it('hard-disconnects the connection when its quit handshake fails', async () => {
    // A failed graceful quit must fall back to disconnect so a socket never leaks.
    const failingConn = {
      status: 'ready',
      quit: jest.fn<Promise<string>, []>().mockRejectedValue(new Error('quit failed')),
      disconnect: jest.fn(),
    }
    const redis = { duplicate: jest.fn().mockReturnValue(failingConn) } as unknown as Redis
    const registry = new WorkerRegistry(fakeConnection(redis), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    await registry.unregister('email')
    expect(failingConn.quit).toHaveBeenCalledTimes(1)
    expect(failingConn.disconnect).toHaveBeenCalledTimes(1)
  })

  // A worker whose close throws is gone either way; its socket and its registry entry must not stay.
  it('still releases the connection and drops the entry when close() throws, then rethrows', async () => {
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    const [worker] = createdWorkers
    worker?.close.mockRejectedValueOnce(new Error('close failed'))
    const conn = registry.getConnections().get('email') as unknown as { quit: jest.Mock }

    await expect(registry.unregister('email')).rejects.toThrow('close failed')

    expect(conn.quit).toHaveBeenCalledTimes(1)
    expect(registry.list()).not.toContain('email')
    expect(registry.getConnections().has('email')).toBe(false)
  })

  it('is a no-op for an unknown queue name', async () => {
    // Unregistering a non-existent queue must not throw.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    await expect(registry.unregister('nonexistent')).resolves.toBeUndefined()
  })
})
