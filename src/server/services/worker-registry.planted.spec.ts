/**
 * @fileoverview Unit tests for the configuration object a host hands to `register`: a key planted on
 * the root prototype is not one of its values, so a worker is built from what the host gave.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { WorkerRegistry } from './worker-registry.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

const built: unknown[][] = []

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    built.push(args)
    return Object.assign(new EventEmitter(), { close: jest.fn().mockResolvedValue(undefined) })
  }),
}))

/** A registry over a stub connection. */
function makeRegistry(): WorkerRegistry {
  const connection = {
    getClient: jest.fn().mockReturnValue({
      duplicate: jest
        .fn()
        .mockReturnValue({ status: 'ready', on: jest.fn(), disconnect: jest.fn() }),
    }),
  } as unknown as ConnectionResolver
  const options = {
    connection: { url: 'redis://localhost:6379' },
    prefix: 'bull',
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
    commandTimeoutMs: 5000,
    enqueueTimeoutMs: 10000,
  } as unknown as ResolvedQueueOptions
  return new WorkerRegistry(connection, options)
}

/** Run `body` with `key` planted on the root prototype, and take it off again whatever happens. */
function withPlanted<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

beforeEach(() => {
  built.length = 0
})

describe('WorkerRegistry.register does not take a planted key for the configuration’s own', () => {
  it('builds the worker without a planted options object', () => {
    withPlanted('options', { concurrency: 7 }, () => {
      makeRegistry().register({ queueName: 'q', handler: () => Promise.resolve() })
    })

    expect((built[0]?.[2] as { concurrency?: number }).concurrency).not.toBe(7)
  })
})
