/**
 * @fileoverview Unit tests for QueueLifecycle. Every BullMQ resource and
 * registry is mocked so the ordered shutdown protocol, the bounded drain, the
 * conditional queue drain, and the swallowed-error behavior can be exercised
 * without a real Redis.
 * @layer server/lifecycle
 */

import { Logger } from '@nestjs/common'
import type { Queue, QueueEvents, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { QueueLifecycle } from './queue-lifecycle.service'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { ConnectionResolver } from '../services/connection-resolver.service'
import type { FlowService } from '../services/flow.service'
import type { QueueService } from '../services/queue.service'
import type { WorkerRegistry } from '../services/worker-registry.service'
import type { QueueEventsRegistry } from '../services/queue-events-registry.service'

/** Records the relative order in which teardown steps fire. */
const order: string[] = []

/** Build resolved options with the shutdown knobs under test. */
function makeResolved(shutdown?: Partial<ResolvedQueueOptions['shutdown']>): ResolvedQueueOptions {
  return {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: {},
    prefix: 'bull',
    queueOptions: {},
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 5000, drainOnShutdown: false, ...shutdown },
    connectionReadyTimeoutMs: 10000,
  }
}

/** A worker mock whose `close` distinguishes graceful (`close()`) from force (`close(true)`). */
function makeWorker(close: jest.Mock): Worker {
  return { close } as unknown as Worker
}

/** A queue-events mock with a controllable `close`. */
function makeQueueEvents(close: jest.Mock): QueueEvents {
  return { close } as unknown as QueueEvents
}

/** A queue mock with controllable `close` and `drain`. */
function makeQueue(close: jest.Mock, drain: jest.Mock): Queue {
  return { close, drain } as unknown as Queue
}

/** A duplicated-connection mock with controllable `quit` and `disconnect`. */
function makeConnection(quit: jest.Mock, disconnect: jest.Mock): Redis {
  return { quit, disconnect } as unknown as Redis
}

/** Assemble a QueueLifecycle over the supplied collaborators. */
function makeLifecycle(args: {
  workers?: ReadonlyMap<string, Worker>
  workerConnections?: ReadonlyMap<string, Redis>
  events?: ReadonlyMap<string, QueueEvents>
  eventConnections?: ReadonlyMap<string, Redis>
  queues?: ReadonlyMap<string, Queue>
  flowDestroy?: jest.Mock
  connectionDestroy?: jest.Mock
  resolved?: ResolvedQueueOptions
}): {
  lifecycle: QueueLifecycle
  flowDestroy: jest.Mock
  connectionDestroy: jest.Mock
} {
  const flowDestroy = args.flowDestroy ?? jest.fn().mockResolvedValue(undefined)
  const connectionDestroy = args.connectionDestroy ?? jest.fn().mockResolvedValue(undefined)

  const workers = {
    getAll: () => args.workers ?? new Map<string, Worker>(),
    getConnections: () => args.workerConnections ?? new Map<string, Redis>(),
  } as unknown as WorkerRegistry
  const events = {
    getAll: () => args.events ?? new Map<string, QueueEvents>(),
    getConnections: () => args.eventConnections ?? new Map<string, Redis>(),
  } as unknown as QueueEventsRegistry
  const queues = {
    getCachedQueues: () => args.queues ?? new Map<string, Queue>(),
  } as unknown as QueueService
  const flow = { onModuleDestroy: flowDestroy } as unknown as FlowService
  const connection = { onModuleDestroy: connectionDestroy } as unknown as ConnectionResolver

  const lifecycle = new QueueLifecycle(
    workers,
    events,
    queues,
    flow,
    connection,
    args.resolved ?? makeResolved(),
  )
  return { lifecycle, flowDestroy, connectionDestroy }
}

let warnSpy: jest.SpyInstance

beforeEach(() => {
  order.length = 0
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

describe('QueueLifecycle.onModuleDestroy — happy path', () => {
  it('runs the teardown steps in the documented order', async () => {
    // workers → queue-events → duplicated connections → flow → queues → connection.
    const workerClose = jest.fn().mockImplementation(() => {
      order.push('worker')
      return Promise.resolve()
    })
    const eventsClose = jest.fn().mockImplementation(() => {
      order.push('events')
      return Promise.resolve()
    })
    const workerQuit = jest.fn().mockImplementation(() => {
      order.push('worker-conn')
      return Promise.resolve('OK')
    })
    const eventQuit = jest.fn().mockImplementation(() => {
      order.push('event-conn')
      return Promise.resolve('OK')
    })
    const queueClose = jest.fn().mockImplementation(() => {
      order.push('queue')
      return Promise.resolve()
    })
    const queueDrain = jest.fn().mockResolvedValue(undefined)
    const flowDestroy = jest.fn().mockImplementation(() => {
      order.push('flow')
      return Promise.resolve()
    })
    const connectionDestroy = jest.fn().mockImplementation(() => {
      order.push('connection')
      return Promise.resolve()
    })

    const { lifecycle } = makeLifecycle({
      workers: new Map([['email', makeWorker(workerClose)]]),
      workerConnections: new Map([['email', makeConnection(workerQuit, jest.fn())]]),
      events: new Map([['email', makeQueueEvents(eventsClose)]]),
      eventConnections: new Map([['email', makeConnection(eventQuit, jest.fn())]]),
      queues: new Map([['email', makeQueue(queueClose, queueDrain)]]),
      flowDestroy,
      connectionDestroy,
    })

    await lifecycle.onModuleDestroy()

    expect(order).toEqual([
      'worker',
      'events',
      'worker-conn',
      'event-conn',
      'flow',
      'queue',
      'connection',
    ])
    expect(workerClose).toHaveBeenCalledWith()
    expect(queueDrain).not.toHaveBeenCalled()
  })

  it('is a no-op-safe sweep when nothing was registered', async () => {
    // Empty registries must complete without throwing and still tear down the connection.
    const { lifecycle, connectionDestroy } = makeLifecycle({})
    await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined()
    expect(connectionDestroy).toHaveBeenCalledTimes(1)
  })
})

describe('QueueLifecycle.onModuleDestroy — bounded drain', () => {
  it('force-closes a worker that exceeds the drain budget and continues teardown', async () => {
    // A graceful close that never resolves must be force-closed after the timeout.
    jest.useFakeTimers()
    const close = jest.fn().mockImplementation((force?: boolean) =>
      force === true ? Promise.reject(new Error('force failed')) : new Promise<void>(() => undefined),
    )
    const connectionDestroy = jest.fn().mockResolvedValue(undefined)
    const { lifecycle } = makeLifecycle({
      workers: new Map([['slow', makeWorker(close)]]),
      connectionDestroy,
      resolved: makeResolved({ drainTimeoutMs: 5000 }),
    })

    const pending = lifecycle.onModuleDestroy()
    await jest.advanceTimersByTimeAsync(5000)
    await pending
    // Flush the fire-and-forget force-close rejection handler.
    await Promise.resolve()

    expect(close).toHaveBeenCalledWith()
    expect(close).toHaveBeenCalledWith(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(QUEUE_ERROR_CODES.SHUTDOWN_TIMEOUT_EXCEEDED),
    )
    expect(connectionDestroy).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('treats a rejected graceful close as a forced worker without timing out', async () => {
    // A close() that rejects immediately is escalated to a force-close on the same path.
    const close = jest.fn().mockImplementation((force?: boolean) =>
      force === true ? Promise.resolve() : Promise.reject(new Error('graceful close failed')),
    )
    const { lifecycle } = makeLifecycle({
      workers: new Map([['email', makeWorker(close)]]),
    })

    await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledWith(true)
  })
})

describe('QueueLifecycle.onModuleDestroy — conditional drain', () => {
  it('drains every cached queue when drainOnShutdown is enabled', async () => {
    // drainOnShutdown removes waiting/delayed jobs; the swallowed drain error is tolerated.
    const queueClose = jest.fn().mockResolvedValue(undefined)
    const queueDrain = jest.fn().mockRejectedValue(new Error('drain failed'))
    const { lifecycle } = makeLifecycle({
      queues: new Map([['email', makeQueue(queueClose, queueDrain)]]),
      resolved: makeResolved({ drainOnShutdown: true }),
    })

    await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined()
    expect(queueDrain).toHaveBeenCalledTimes(1)
    expect(queueClose).toHaveBeenCalledTimes(1)
  })
})

describe('QueueLifecycle.onModuleDestroy — error resilience', () => {
  it('swallows failures from every teardown step and disconnects on a failed quit', async () => {
    // One failing step must never abort the rest of the ordered sequence.
    const workerClose = jest.fn().mockResolvedValue(undefined)
    const eventsClose = jest.fn().mockRejectedValue(new Error('events close failed'))
    const workerDisconnect = jest.fn()
    const workerQuit = jest.fn().mockRejectedValue(new Error('quit failed'))
    const queueClose = jest.fn().mockRejectedValue(new Error('queue close failed'))
    const queueDrain = jest.fn().mockResolvedValue(undefined)
    const flowDestroy = jest.fn().mockRejectedValue(new Error('flow close failed'))
    const connectionDestroy = jest.fn().mockRejectedValue(new Error('connection teardown failed'))

    const { lifecycle } = makeLifecycle({
      workers: new Map([['email', makeWorker(workerClose)]]),
      workerConnections: new Map([['email', makeConnection(workerQuit, workerDisconnect)]]),
      events: new Map([['email', makeQueueEvents(eventsClose)]]),
      queues: new Map([['email', makeQueue(queueClose, queueDrain)]]),
      flowDestroy,
      connectionDestroy,
    })

    await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined()
    expect(eventsClose).toHaveBeenCalledTimes(1)
    expect(workerDisconnect).toHaveBeenCalledTimes(1)
    expect(flowDestroy).toHaveBeenCalledTimes(1)
    expect(queueClose).toHaveBeenCalledTimes(1)
    expect(connectionDestroy).toHaveBeenCalledTimes(1)
  })
})
