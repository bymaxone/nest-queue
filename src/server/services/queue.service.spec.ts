/**
 * @fileoverview Unit tests for the base QueueService.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
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
  upsertJobScheduler: jest.Mock
  removeJobScheduler: jest.Mock
  getJobSchedulers: jest.Mock
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
      upsertJobScheduler: jest.fn(),
      removeJobScheduler: jest.fn(),
      getJobSchedulers: jest.fn(),
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

describe('QueueService — deduplication passthrough', () => {
  /** Assert enqueue forwards the given options object to Queue.add unchanged. */
  async function expectForwarded(options: Parameters<QueueService['enqueue']>[3]): Promise<void> {
    const { service } = makeService()
    service.getOrCreateQueue('search')
    queueInstances[0]?.add.mockResolvedValue({ id: '1' } as Job)

    await service.enqueue('search', 'reindex', { term: 'shoes' }, options)

    expect(queueInstances[0]?.add).toHaveBeenCalledWith('reindex', { term: 'shoes' }, options)
  }

  it('forwards Simple deduplication unchanged', async () => {
    // Simple mode: { id } collapses until the in-flight job settles.
    await expectForwarded({ deduplication: { id: 'reindex:shoes' } })
  })

  it('forwards Throttle deduplication unchanged', async () => {
    // Throttle mode: { id, ttl } ignores duplicates within the window.
    await expectForwarded({ deduplication: { id: 'reindex:shoes', ttl: 5_000 } })
  })

  it('forwards Debounce deduplication unchanged', async () => {
    // Debounce mode: keep latest data and reset the TTL per duplicate.
    await expectForwarded({
      deduplication: { id: 'reindex:shoes', ttl: 5_000, extend: true, replace: true },
    })
  })

  it('forwards keep-last-if-active deduplication unchanged', async () => {
    // keep-last-if-active: store latest while a job runs, then run one follow-up.
    await expectForwarded({ deduplication: { id: 'reindex:shoes', keepLastIfActive: true } })
  })

  it('treats jobId and deduplication as independent options', async () => {
    // Both can be set together; the library applies no transformation.
    await expectForwarded({ jobId: 'job-1', deduplication: { id: 'reindex:shoes' } })
  })

  it('forwards a bare jobId without any deduplication key', async () => {
    // jobId alone (idempotent insert) does not imply a deduplication key.
    await expectForwarded({ jobId: 'job-1' })
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

describe('QueueService — job schedulers', () => {
  it('upserts a cron scheduler with default template name and data', async () => {
    // A pattern schedule defaults name to the schedulerId and data to {}.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    const job = { id: 'repeat:nightly:1' } as Job
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(job)

    const result = await service.upsertJobScheduler('cleanup', 'nightly', { pattern: '0 3 * * *' })

    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledWith(
      'nightly',
      { pattern: '0 3 * * *' },
      { name: 'nightly', data: {} },
    )
    expect(result).toBe(job)
  })

  it('forwards an explicit template name, data, and opts', async () => {
    // A provided template overrides the defaults and includes opts when set.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)

    await service.upsertJobScheduler(
      'cleanup',
      'nightly',
      { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
      { name: 'cleanup', data: { mode: 'soft' }, opts: { priority: 5 } },
    )

    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledWith(
      'nightly',
      { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
      { name: 'cleanup', data: { mode: 'soft' }, opts: { priority: 5 } },
    )
  })

  it('upserts an interval scheduler', async () => {
    // An `every` schedule is forwarded unchanged.
    const { service } = makeService()
    service.getOrCreateQueue('monitoring')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)

    const result = await service.upsertJobScheduler('monitoring', 'heartbeat', { every: 60_000 })

    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledWith(
      'heartbeat',
      { every: 60_000 },
      { name: 'heartbeat', data: {} },
    )
    expect(result).toBeUndefined()
  })

  it('is idempotent — a second call reuses the same queue', async () => {
    // Re-registering the same schedulerId hits the cached queue, not a new one.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)

    await service.upsertJobScheduler('cleanup', 'nightly', { every: 1000 })
    await service.upsertJobScheduler('cleanup', 'nightly', { every: 2000 })

    expect(queueConstructorArgs).toHaveLength(1)
    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid schedule before touching the queue', async () => {
    // Structural validation runs first, so BullMQ is never called for a bad schedule.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')

    await expect(
      service.upsertJobScheduler('cleanup', 'nightly', { every: 0 }),
    ).rejects.toBeInstanceOf(QueueException)
    expect(queueInstances[0]?.upsertJobScheduler).not.toHaveBeenCalled()
  })

  it('rethrows a cron parse failure as INVALID_REPEAT_OPTIONS (400)', async () => {
    // BullMQ parses the cron string; a parse failure becomes a typed 400.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockRejectedValue(new Error('Invalid cron expression'))

    await expect(
      service.upsertJobScheduler('cleanup', 'nightly', { pattern: 'not a cron' }),
    ).rejects.toBeInstanceOf(QueueException)
    await service.upsertJobScheduler('cleanup', 'nightly', { pattern: 'not a cron' }).catch((err: unknown) => {
      const body = (err as QueueException).getResponse() as { error: { code: string } }
      expect(body.error.code).toBe(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS)
      expect((err as QueueException).getStatus()).toBe(400)
    })
  })

  it('removes a scheduler and returns the boolean result', async () => {
    // removeJobScheduler forwards to BullMQ and returns its boolean.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.removeJobScheduler.mockResolvedValue(true)

    await expect(service.removeJobScheduler('cleanup', 'nightly')).resolves.toBe(true)
    expect(queueInstances[0]?.removeJobScheduler).toHaveBeenCalledWith('nightly')
  })

  it('lists schedulers with default pagination', async () => {
    // getJobSchedulers defaults the page window and ascending order.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.getJobSchedulers.mockResolvedValue([])

    await service.getJobSchedulers('cleanup')

    expect(queueInstances[0]?.getJobSchedulers).toHaveBeenCalledWith(0, 50, true)
  })

  it('lists schedulers with explicit pagination', async () => {
    // Explicit pagination and order are forwarded unchanged.
    const { service } = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.getJobSchedulers.mockResolvedValue([])

    await service.getJobSchedulers('cleanup', 5, 25, false)

    expect(queueInstances[0]?.getJobSchedulers).toHaveBeenCalledWith(5, 25, false)
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
