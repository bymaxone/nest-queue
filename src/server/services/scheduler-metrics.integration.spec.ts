/**
 * @fileoverview Cross-feature smoke test: register a cron Job Scheduler
 * idempotently through QueueService, then read cached metrics through
 * MetricsService — proving both services compose over the same queue cache with
 * a mocked BullMQ (no real Redis).
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { QueueService } from './queue.service'
import { MetricsService } from './metrics.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** Minimal mock of the BullMQ Queue used by this smoke test. */
interface MockQueue {
  upsertJobScheduler: jest.Mock
  getJobCounts: jest.Mock
  close: jest.Mock
}

const queueInstances: MockQueue[] = []

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => {
    const instance: MockQueue = {
      upsertJobScheduler: jest.fn().mockResolvedValue({ id: 'repeat:nightly:1' } as Job),
      getJobCounts: jest
        .fn()
        .mockResolvedValue({ waiting: 2, active: 0, completed: 9, failed: 0, delayed: 1, paused: 0 }),
      close: jest.fn().mockResolvedValue(undefined),
    }
    queueInstances.push(instance)
    return instance
  }),
}))

/** Build a ConnectionResolver stub returning a fixed client. */
function makeConnection(): ConnectionResolver {
  return { getClient: jest.fn().mockReturnValue({ id: 'client' }) } as unknown as ConnectionResolver
}

/** Build resolved options with metrics enabled. */
function makeOptions(): ResolvedQueueOptions {
  return {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: { attempts: 3 },
    prefix: 'bull',
    queueOptions: {},
    flows: { enabled: false },
    metrics: { enabled: true, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
  }
}

beforeEach(() => {
  queueInstances.length = 0
})

describe('Schedulers + metrics — cross-feature smoke', () => {
  it('upserts a cron scheduler idempotently, then serves cached metrics', async () => {
    // A single queue backs both the idempotent scheduler upsert and the metrics read.
    const queueService = new QueueService(makeConnection(), makeOptions())
    const metricsService = new MetricsService(queueService, true, 5000)

    await queueService.upsertJobScheduler(
      'cleanup',
      'nightly',
      { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
      { name: 'cleanup', data: { mode: 'soft' } },
    )
    await queueService.upsertJobScheduler('cleanup', 'nightly', { pattern: '0 3 * * *' })

    // Idempotent: the same cached queue handled both upserts (no duplicate queue).
    expect(queueInstances).toHaveLength(1)
    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledTimes(2)

    const metrics = await metricsService.get('cleanup')
    expect(metrics.queue).toBe('cleanup')
    expect(metrics.counts.completed).toBe(9)
    expect(() => new Date(metrics.collectedAt).toISOString()).not.toThrow()

    // The metrics read reuses the same cached queue created during the upsert.
    expect(queueInstances).toHaveLength(1)
  })
})
