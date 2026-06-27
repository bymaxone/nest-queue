/**
 * @fileoverview Unit tests for the base QueueService.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { BulkJob } from '../interfaces/queue-job-data.interface'

/** A jest-mock-backed stand-in for a BullMQ Queue. */
interface MockQueue {
  add: jest.Mock
  addBulk: jest.Mock
  getJob: jest.Mock
  getJobs: jest.Mock
  getJobCounts: jest.Mock
  pause: jest.Mock
  resume: jest.Mock
  clean: jest.Mock
  close: jest.Mock
}

const queueInstances: MockQueue[] = []
const queueConstructorArgs: unknown[][] = []

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args: unknown[]) => {
    queueConstructorArgs.push(args)
    const instance: MockQueue = {
      add: jest.fn(),
      addBulk: jest.fn(),
      getJob: jest.fn(),
      getJobs: jest.fn(),
      getJobCounts: jest.fn(),
      pause: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
      clean: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    }
    queueInstances.push(instance)
    return instance
  }),
}))

const fakeClient = { id: 'queue-client' }

/** Build a ConnectionResolver stub returning a fixed client. */
function makeConnection(): ConnectionResolver {
  return { getClient: jest.fn().mockReturnValue(fakeClient) } as unknown as ConnectionResolver
}

/** Build resolved options for the service under test. */
function makeOptions(): ResolvedQueueOptions {
  return {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: { attempts: 3 },
    prefix: 'bull',
    queueOptions: { streams: { events: { maxLen: 5 } } },
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
  }
}

/** Construct a fresh service with mocked collaborators. */
function makeService(): { service: QueueService; connection: ConnectionResolver } {
  const connection = makeConnection()
  return { service: new QueueService(connection, makeOptions()), connection }
}

beforeEach(() => {
  queueInstances.length = 0
  queueConstructorArgs.length = 0
})

describe('QueueService — queue cache', () => {
  it('creates a queue with the merged module defaults', () => {
    // The first call builds the queue with connection, prefix, and merged options.
    const { service } = makeService()
    service.getOrCreateQueue('email')

    expect(queueConstructorArgs).toHaveLength(1)
    const [name, opts] = queueConstructorArgs[0] as [string, Record<string, unknown>]
    expect(name).toBe('email')
    expect(opts.connection).toBe(fakeClient)
    expect(opts.prefix).toBe('bull')
    expect(opts.defaultJobOptions).toEqual({ attempts: 3 })
    expect(opts.streams).toEqual({ events: { maxLen: 5 } })
  })

  it('returns the cached instance on the second call', () => {
    // A repeated name must not construct a second Queue.
    const { service } = makeService()
    const first = service.getOrCreateQueue('email')
    const second = service.getOrCreateQueue('email')

    expect(first).toBe(second)
    expect(queueConstructorArgs).toHaveLength(1)
  })

  it('applies per-queue overrides on top of the defaults', () => {
    // Overrides win over module-level queue options.
    const { service } = makeService()
    service.getOrCreateQueue('reports', { streams: { events: { maxLen: 99 } } })

    const [, opts] = queueConstructorArgs[0] as [string, Record<string, unknown>]
    expect(opts.streams).toEqual({ events: { maxLen: 99 } })
  })
})

describe('QueueService — enqueue', () => {
  it('delegates enqueue to Queue.add with name, data, and options', async () => {
    // enqueue is a thin, typed wrapper over Queue.add.
    const { service } = makeService()
    const job = { id: '1' } as Job
    service.getOrCreateQueue('email')
    queueInstances[0]?.add.mockResolvedValue(job)

    const result = await service.enqueue('email', 'send', { to: 'a@b.com' }, { priority: 5 })

    expect(queueInstances[0]?.add).toHaveBeenCalledWith('send', { to: 'a@b.com' }, { priority: 5 })
    expect(result).toBe(job)
  })
})

describe('QueueService — enqueueBulk', () => {
  it('delegates to Queue.addBulk mapping per-job options to BullMQ `opts`', async () => {
    // Each descriptor is forwarded with its options under the `opts` key BullMQ reads.
    const { service } = makeService()
    const created = [{ id: '1' }, { id: '2' }] as Job[]
    service.getOrCreateQueue('email')
    queueInstances[0]?.addBulk.mockResolvedValue(created)
    const jobs: BulkJob[] = [
      { name: 'a', data: { x: 1 }, options: { priority: 5 } },
      { name: 'b', data: { y: 2 } },
    ]

    const result = await service.enqueueBulk('email', jobs)

    expect(queueInstances[0]?.addBulk).toHaveBeenCalledWith([
      { name: 'a', data: { x: 1 }, opts: { priority: 5 } },
      { name: 'b', data: { y: 2 } },
    ])
    expect(result).toBe(created)
  })

  it('throws BULK_ENQUEUE_FAILED when the batch exceeds the size cap', async () => {
    // The bound guards against a self-inflicted Redis-memory spike.
    const { service } = makeService()
    const jobs: BulkJob[] = Array.from({ length: 1001 }, () => ({ name: 'a', data: {} }))

    await expect(service.enqueueBulk('email', jobs)).rejects.toBeInstanceOf(QueueException)
  })

  it('wraps an addBulk failure in a QueueException', async () => {
    // Underlying failures surface as a typed exception with the cause message.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    queueInstances[0]?.addBulk.mockRejectedValue(new Error('redis down'))

    await expect(
      service.enqueueBulk('email', [{ name: 'a', data: {} }]),
    ).rejects.toBeInstanceOf(QueueException)
  })
})

describe('QueueService — inspection', () => {
  it('returns the job when found', async () => {
    // getJob returns the BullMQ job as-is when present.
    const { service } = makeService()
    const job = { id: '1' } as Job
    service.getOrCreateQueue('email')
    queueInstances[0]?.getJob.mockResolvedValue(job)

    await expect(service.getJob('email', '1')).resolves.toBe(job)
  })

  it('returns null when the job is absent', async () => {
    // A missing job resolves to null rather than throwing.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    queueInstances[0]?.getJob.mockResolvedValue(undefined)

    await expect(service.getJob('email', 'missing')).resolves.toBeNull()
  })

  it('passes the status as an array with default pagination', async () => {
    // getJobs wraps the status and defaults the page window to [0, 50].
    const { service } = makeService()
    service.getOrCreateQueue('email')
    queueInstances[0]?.getJobs.mockResolvedValue([])

    await service.getJobs('email', 'waiting')

    expect(queueInstances[0]?.getJobs).toHaveBeenCalledWith(['waiting'], 0, 50)
  })

  it('forwards an explicit pagination window', async () => {
    // Custom start/end values reach BullMQ unchanged.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    queueInstances[0]?.getJobs.mockResolvedValue([])

    await service.getJobs('email', 'failed', 10, 20)

    expect(queueInstances[0]?.getJobs).toHaveBeenCalledWith(['failed'], 10, 20)
  })
})

describe('QueueService — metrics', () => {
  it('returns counts and an ISO timestamp', async () => {
    // getMetrics returns the documented snapshot shape.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    const counts = { waiting: 1, active: 2, completed: 3, failed: 4, delayed: 5, paused: 6 }
    queueInstances[0]?.getJobCounts.mockResolvedValue(counts)

    const metrics = await service.getMetrics('email')

    expect(queueInstances[0]?.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    )
    expect(metrics.queue).toBe('email')
    expect(metrics.counts).toEqual(counts)
    expect(() => new Date(metrics.collectedAt).toISOString()).not.toThrow()
  })
})

describe('QueueService — control', () => {
  it('pauses and resumes a queue', async () => {
    // Control helpers delegate to the BullMQ queue.
    const { service } = makeService()
    service.getOrCreateQueue('email')

    await service.pauseQueue('email')
    await service.resumeQueue('email')

    expect(queueInstances[0]?.pause).toHaveBeenCalledTimes(1)
    expect(queueInstances[0]?.resume).toHaveBeenCalledTimes(1)
  })

  it('cleans with the BullMQ argument order', async () => {
    // cleanQueue mirrors clean(grace, limit, type) and returns removed ids.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    queueInstances[0]?.clean.mockResolvedValue(['1', '2'])

    const removed = await service.cleanQueue('email', 60000, 100, 'completed')

    expect(queueInstances[0]?.clean).toHaveBeenCalledWith(60000, 100, 'completed')
    expect(removed).toEqual(['1', '2'])
  })

  it('cleans without an explicit status', async () => {
    // The status argument is optional and may be omitted.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    queueInstances[0]?.clean.mockResolvedValue([])

    await service.cleanQueue('email', 1000, 0)

    expect(queueInstances[0]?.clean).toHaveBeenCalledWith(1000, 0, undefined)
  })
})

describe('QueueService — cache view and shutdown', () => {
  it('exposes a read-only cache view', () => {
    // getCachedQueues returns the live map for inspection.
    const { service } = makeService()
    service.getOrCreateQueue('email')

    expect(service.getCachedQueues().size).toBe(1)
    expect(service.getCachedQueues().has('email')).toBe(true)
  })

  it('closes every cached queue and clears the cache on destroy', async () => {
    // Shutdown closes all queues and empties the cache.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    service.getOrCreateQueue('reports')

    await service.onModuleDestroy()

    expect(queueInstances[0]?.close).toHaveBeenCalledTimes(1)
    expect(queueInstances[1]?.close).toHaveBeenCalledTimes(1)
    expect(service.getCachedQueues().size).toBe(0)
  })

  it('swallows per-queue close errors during destroy', async () => {
    // A failing close must not abort the shutdown of the remaining queues.
    const { service } = makeService()
    service.getOrCreateQueue('email')
    service.getOrCreateQueue('reports')
    queueInstances[0]?.close.mockRejectedValue(new Error('close failed'))

    await expect(service.onModuleDestroy()).resolves.toBeUndefined()
    expect(queueInstances[1]?.close).toHaveBeenCalledTimes(1)
    expect(service.getCachedQueues().size).toBe(0)
  })
})
