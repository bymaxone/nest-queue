/**
 * @fileoverview Unit tests for MetricsService. QueueService is mocked and timers
 * are faked so the TTL cache can be exercised deterministically.
 * @layer server/services
 */

import { MetricsService } from './metrics.service'
import type { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { QueueMetrics } from '../../shared/types/queue-metrics.types'

const TTL_MS = 5000

/** Build a metrics snapshot for a queue. */
function snapshot(queue: string): QueueMetrics {
  return {
    queue,
    counts: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 },
    collectedAt: new Date().toISOString(),
  }
}

/** A jest-mock-backed stand-in for QueueService. */
interface MockQueueService {
  getMetrics: jest.Mock
  getCachedQueues: jest.Mock
}

/** Build a QueueService stub returning fresh snapshots and a fixed cache view. */
function makeQueueService(queueNames: string[] = []): MockQueueService {
  return {
    getMetrics: jest.fn((name: string) => Promise.resolve(snapshot(name))),
    getCachedQueues: jest.fn().mockReturnValue(new Map(queueNames.map((n) => [n, {}]))),
  }
}

/** Construct a MetricsService bound to the mock QueueService. */
function makeService(
  qs: MockQueueService,
  enabled = true,
): MetricsService {
  return new MetricsService(qs as unknown as QueueService, enabled, TTL_MS)
}

/** Extract the error code carried by a QueueException response body. */
function codeOf(err: unknown): string {
  return ((err as QueueException).getResponse() as { error: { code: string } }).error.code
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('MetricsService — caching', () => {
  it('fetches and caches on a miss', async () => {
    // The first read delegates to QueueService and stores the result.
    const qs = makeQueueService()
    const service = makeService(qs)

    const metrics = await service.get('email')

    expect(qs.getMetrics).toHaveBeenCalledTimes(1)
    expect(metrics.queue).toBe('email')
  })

  it('returns the cached value on a hit without re-fetching', async () => {
    // A second read within the TTL must not call QueueService again.
    const qs = makeQueueService()
    const service = makeService(qs)

    const first = await service.get('email')
    const second = await service.get('email')

    expect(qs.getMetrics).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('re-fetches after the TTL elapses', async () => {
    // Once the entry expires, the next read fetches fresh metrics.
    const qs = makeQueueService()
    const service = makeService(qs)

    await service.get('email')
    jest.advanceTimersByTime(TTL_MS + 1)
    await service.get('email')

    expect(qs.getMetrics).toHaveBeenCalledTimes(2)
  })

  it('re-fetches at exactly the TTL boundary (expiry is exclusive)', async () => {
    // At the precise expiry instant the entry is already stale, so it re-fetches.
    const qs = makeQueueService()
    const service = makeService(qs)

    await service.get('email')
    jest.advanceTimersByTime(TTL_MS)
    await service.get('email')

    expect(qs.getMetrics).toHaveBeenCalledTimes(2)
  })
})

describe('MetricsService — getAll', () => {
  it('returns metrics for every cached queue', async () => {
    // getAll maps over the queue names currently cached in QueueService.
    const qs = makeQueueService(['email', 'reports'])
    const service = makeService(qs)

    const all = await service.getAll()

    expect(all.map((m) => m.queue)).toEqual(['email', 'reports'])
    expect(qs.getCachedQueues).toHaveBeenCalledTimes(1)
  })
})

describe('MetricsService — invalidate', () => {
  it('drops a single entry so the next read re-fetches', async () => {
    // invalidate(name) removes only that entry.
    const qs = makeQueueService()
    const service = makeService(qs)

    await service.get('email')
    service.invalidate('email')
    await service.get('email')

    expect(qs.getMetrics).toHaveBeenCalledTimes(2)
  })

  it('clears the whole cache when called without a name', async () => {
    // invalidate() empties the cache; both queues re-fetch afterward.
    const qs = makeQueueService()
    const service = makeService(qs)

    await service.get('email')
    await service.get('reports')
    service.invalidate()
    await service.get('email')
    await service.get('reports')

    expect(qs.getMetrics).toHaveBeenCalledTimes(4)
  })

  it('leaves other entries cached when invalidating a single queue', async () => {
    // invalidate('a') must drop only 'a'; 'b' stays a cache hit.
    const qs = makeQueueService()
    const service = makeService(qs)

    await service.get('a')
    await service.get('b')
    service.invalidate('a')
    await service.get('a')
    await service.get('b')

    const bCalls = qs.getMetrics.mock.calls.filter((c) => c[0] === 'b')
    expect(bCalls).toHaveLength(1)
    expect(qs.getMetrics).toHaveBeenCalledTimes(3)
  })
})

describe('MetricsService — disabled', () => {
  it('throws METRICS_DISABLED (503) from get', async () => {
    // A disabled service rejects reads with the typed error.
    const service = makeService(makeQueueService(), false)

    await expect(service.get('email')).rejects.toBeInstanceOf(QueueException)
    await service.get('email').catch((err: unknown) => {
      expect(codeOf(err)).toBe(QUEUE_ERROR_CODES.METRICS_DISABLED)
      expect((err as QueueException).getStatus()).toBe(503)
    })
  })

  it('throws METRICS_DISABLED from getAll', async () => {
    // getAll is guarded the same way as get.
    const service = makeService(makeQueueService(), false)

    await expect(service.getAll()).rejects.toBeInstanceOf(QueueException)
  })

  it('throws METRICS_DISABLED from invalidate', () => {
    // invalidate is guarded too, even though it is synchronous.
    const service = makeService(makeQueueService(), false)

    expect(() => {
      service.invalidate('email')
    }).toThrow(QueueException)
  })
})
