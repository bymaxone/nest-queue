/**
 * @fileoverview Unit tests for the options a worker is built with: every option BullMQ reads while it
 * finishes a job and the host did not set is an own `undefined`, so a name nobody set is never looked
 * up on `Object.prototype`.
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
      duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
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

beforeEach(() => {
  built.length = 0
})

describe('WorkerRegistry.register builds the worker with the options BullMQ reads at the end of a job', () => {
  it.each([
    'removeOnComplete',
    'removeOnFail',
    'name',
    'limiter',
    'metrics',
    'maxStartedAttempts',
    'skipLockRenewal',
    'skipStalledCheck',
    'settings',
  ])('holds %s as an own undefined when the host did not set it', (name) => {
    makeRegistry().register({ queueName: 'q', handler: () => Promise.resolve() })

    const options = built[0]?.[2] as object
    expect(Object.hasOwn(options, name)).toBe(true)
    expect((options as Record<string, unknown>)[name]).toBeUndefined()
  })
})
