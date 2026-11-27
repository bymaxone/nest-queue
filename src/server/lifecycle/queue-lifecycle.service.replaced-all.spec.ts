/**
 * @fileoverview Unit tests that the shutdown waits for every worker, events listener and connection
 * to close even when the host replaced `Promise.all` with one that answers at once: a join through
 * the static would return before the workers had closed and report none of them as forced.
 * @layer server/lifecycle
 */

import { Logger } from '@nestjs/common'
import { QueueLifecycle } from './queue-lifecycle.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { ConnectionResolver } from '../services/connection-resolver.service'
import type { FlowService } from '../services/flow.service'
import type { QueueService } from '../services/queue.service'
import type { QueueEventsRegistry } from '../services/queue-events-registry.service'
import type { WorkerRegistry } from '../services/worker-registry.service'

const resolved = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: false },
  metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
  shutdown: { drainTimeoutMs: 5000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
} as ResolvedQueueOptions

/** A closer that settles after `ms` and records that it did. */
function closing(ms: number, closed: string[], name: string): jest.Mock {
  return jest.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          closed.push(name)
          resolve()
        }, ms),
      ),
  )
}

/** A lifecycle with two workers, one events listener and one duplicated connection to close. */
function make(closed: string[]): QueueLifecycle {
  const worker = (name: string): unknown => ({
    pause: jest.fn().mockResolvedValue(undefined),
    close: closing(30, closed, name),
  })
  return new QueueLifecycle(
    {
      getAll: () =>
        new Map([
          ['a', worker('worker-a')],
          ['b', worker('worker-b')],
        ]),
      getConnections: () => new Map(),
    } as unknown as WorkerRegistry,
    {
      getAll: () => new Map([['e', { close: closing(30, closed, 'events') }]]),
      getConnections: () => new Map([['c', { quit: closing(30, closed, 'connection') }]]),
    } as unknown as QueueEventsRegistry,
    {
      getCachedQueues: () => new Map(),
      closeAll: jest.fn().mockResolvedValue(undefined),
    } as unknown as QueueService,
    { close: jest.fn().mockResolvedValue(undefined) } as unknown as FlowService,
    { teardown: jest.fn().mockResolvedValue(undefined) } as unknown as ConnectionResolver,
    resolved,
  )
}

describe('QueueLifecycle shutdown with a replaced Promise.all', () => {
  const original = Promise.all

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    Promise.all = original
    jest.restoreAllMocks()
  })

  it('returns only after every worker, listener and connection has closed', async () => {
    const closed: string[] = []
    const lifecycle = make(closed)
    Promise.all = () => Promise.resolve([])

    await lifecycle.onModuleDestroy()
    Promise.all = original

    expect([...closed].sort()).toEqual(['connection', 'events', 'worker-a', 'worker-b'])
  })
})
