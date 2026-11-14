/**
 * @fileoverview The Queue-role connection is torn down with what is left of the one shutdown
 * budget (`shutdown.drainTimeoutMs`, counted from the start of the drain), and never less than
 * the grace a force close gets, so a healthy Redis can still answer the quit.
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

/** Options with a one-minute shutdown budget. */
const resolved = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: false },
  metrics: { enabled: false, cacheTtlMs: 5000 },
  shutdown: { drainTimeoutMs: 60_000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
} as ResolvedQueueOptions

/** A lifecycle with nothing to drain, and the spy the connection's teardown is. */
function make(): { lifecycle: QueueLifecycle; teardown: jest.Mock } {
  const teardown = jest.fn().mockResolvedValue(undefined)
  const lifecycle = new QueueLifecycle(
    { getAll: () => new Map(), getConnections: () => new Map() } as unknown as WorkerRegistry,
    { getAll: () => new Map(), getConnections: () => new Map() } as unknown as QueueEventsRegistry,
    {
      getCachedQueues: () => new Map(),
      closeAll: jest.fn().mockResolvedValue(undefined),
    } as unknown as QueueService,
    { close: jest.fn().mockResolvedValue(undefined) } as unknown as FlowService,
    { teardown } as unknown as ConnectionResolver,
    resolved,
  )
  return { lifecycle, teardown }
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('QueueLifecycle — the budget the connection teardown gets', () => {
  it('passes what is left of the shutdown budget', async () => {
    const { lifecycle, teardown } = make()

    await lifecycle.onModuleDestroy()
    jest.setSystemTime(Date.now() + 20_000)
    await lifecycle.onApplicationShutdown()

    expect(teardown).toHaveBeenCalledWith(40_000)
  })

  it('passes a grace of one second once the budget is spent', async () => {
    const { lifecycle, teardown } = make()

    await lifecycle.onModuleDestroy()
    jest.setSystemTime(Date.now() + 90_000)
    await lifecycle.onApplicationShutdown()

    expect(teardown).toHaveBeenCalledWith(1000)
  })

  it('counts the budget from now when the drain never started', async () => {
    const { lifecycle, teardown } = make()

    await lifecycle.onApplicationShutdown()

    expect(teardown).toHaveBeenCalledWith(60_000)
  })
})
