/**
 * @fileoverview Unit tests for the cause reported when WorkerRegistry cannot construct a BullMQ
 * Worker. BullMQ `Worker` is mocked so no real Redis connection is needed; the cases live apart
 * from the main registry spec to keep each file under the size limit.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import type { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

jest.mock('bullmq', () => ({ Worker: jest.fn() }))

/** A minimal fake Redis whose `duplicate()` yields a stub the registry can disconnect. */
function fakeConnection(): ConnectionResolver {
  const redis = {
    duplicate: jest
      .fn()
      .mockReturnValue({ status: 'ready', disconnect: jest.fn(), quit: jest.fn() }),
  } as unknown as Redis
  return { getClient: jest.fn().mockReturnValue(redis) } as unknown as ConnectionResolver
}

/** Resolved options for the registry under test. */
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
  }
}

/** A minimal job handler used as the process function. */
function noopHandler(_job: Job): Promise<unknown> {
  return Promise.resolve(undefined)
}

/** Read the structured details out of the QueueException the operation throws. */
function detailsOf(run: () => unknown): Record<string, unknown> {
  try {
    run()
  } catch (err) {
    return (
      (err as QueueException).getResponse() as { error: { details: Record<string, unknown> } }
    ).error.details
  }
  throw new Error('expected the operation to throw')
}

/** Make the next Worker construction throw a null-prototype value. */
function throwNullPrototypeOnce(): void {
  const { Worker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
  Worker.mockImplementationOnce(() => {
    const cause: unknown = Object.create(null) // renders with neither String() nor a message
    throw cause
  })
}

describe('WorkerRegistry — failure cause', () => {
  it('reports a null-prototype constructor throw as a typed exception, not a TypeError', () => {
    // String(Object.create(null)) throws, so describing the cause must not depend on it: the
    // registration failure has to reach the caller as the typed exception, not as a TypeError.
    throwNullPrototypeOnce()
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const details = detailsOf(() => registry.register({ queueName: 'email', handler: noopHandler }))
    expect(details.queueName).toBe('email')
    expect(details.cause).toBe('unknown error')
  })

  it('reports a null-prototype sandboxed constructor throw as a typed exception', () => {
    // The sandboxed path shares the rule: a cause String() cannot render still yields the exception.
    throwNullPrototypeOnce()
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const details = detailsOf(() =>
      registry.registerSandboxed({ queueName: 'sb', processorFile: '/tmp/p.js' }),
    )
    expect(details.queueName).toBe('sb')
    expect(details.cause).toBe('unknown error')
  })
})
