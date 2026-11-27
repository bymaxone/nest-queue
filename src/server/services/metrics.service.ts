/**
 * @fileoverview MetricsService — an opt-in, in-memory TTL cache over
 * `QueueService.getMetrics`. Delegates one direction (Metrics → Queue) so there
 * is no circular dependency. Guarded: throws `METRICS_DISABLED` (503) unless
 * `metrics.enabled` was set.
 * @layer server/services
 */

import { HttpStatus, Injectable } from '@nestjs/common'
import type { QueueMetrics } from '../../shared/types/queue-metrics.types'
import type { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { DEFAULT_METRICS_COLLECT_TIMEOUT_MS } from '../constants/default-options'
import { assertPrototypeClean } from '../connection/prototype-guard'
import { own, startWait } from '../utils/bounded-wait'

/** A cached metrics snapshot together with its absolute expiry timestamp. */
interface CacheEntry {
  /** The cached snapshot. */
  metrics: QueueMetrics
  /** Epoch milliseconds after which the entry is stale. */
  expiresAt: number
}

/**
 * Opt-in in-memory TTL cache over `QueueService.getMetrics`. A per-second
 * `/health` poll reads from the cache instead of hammering Redis. The cache
 * delegates to `QueueService` in a single direction, so there is no circular
 * dependency. Every method throws `METRICS_DISABLED` (503) when metrics are not
 * enabled.
 *
 * @example Health check pattern (consumer side — `@nestjs/terminus`, not a dependency here)
 *   @Injectable()
 *   class QueueHealthIndicator extends HealthIndicator {
 *     constructor(private readonly metrics: MetricsService) { super() }
 *     async isHealthy(key: string): Promise<HealthIndicatorResult> {
 *       const all = await this.metrics.getAll()
 *       const stuck = all.filter((m) => m.counts.active > 100 || m.counts.failed > 1000)
 *       return this.getStatus(key, stuck.length === 0, { stuck: stuck.map((m) => m.queue) })
 *     }
 *   }
 */
@Injectable()
export class MetricsService {
  private readonly cache = new Map<string, CacheEntry>()
  /** The read of every queue that `getAllWithinBound` calls share while it is in flight. */
  private pending: Promise<readonly QueueMetrics[]> | undefined
  /** Counts the calls to `invalidate`, so that a read begun before one is not cached after it. */
  private generation = 0

  constructor(
    private readonly queueService: QueueService,
    private readonly enabled: boolean,
    private readonly ttlMs: number,
    private readonly collectTimeoutMs: number = DEFAULT_METRICS_COLLECT_TIMEOUT_MS,
  ) {}

  /**
   * Return cached metrics for `queueName`, or fetch fresh (and cache them) on a
   * miss or after expiry.
   *
   * @param queueName - Target queue.
   * @returns The current metrics snapshot.
   * @throws {QueueException} `METRICS_DISABLED` (503) when metrics are disabled.
   */
  async get(queueName: string): Promise<QueueMetrics> {
    this.ensureEnabled()
    const entry = this.cache.get(queueName)
    if (entry && entry.expiresAt > Date.now()) {
      return entry.metrics
    }
    const begun = this.generation
    const metrics = await this.queueService.getMetrics(queueName)
    if (begun === this.generation) {
      this.cache.set(queueName, { metrics, expiresAt: Date.now() + this.ttlMs })
    }
    return metrics
  }

  /**
   * Return a metrics snapshot for every queue currently cached in `QueueService`.
   *
   * @returns Metrics for all known queues.
   * @throws {QueueException} `METRICS_DISABLED` (503) when metrics are disabled.
   */
  async getAll(): Promise<readonly QueueMetrics[]> {
    this.ensureEnabled()
    const names = Array.from(this.queueService.getCachedQueues().keys())
    return Promise.all(names.map((name) => this.get(name)))
  }

  /**
   * Return what {@link MetricsService.getAll} returns if it answers within
   * `metrics.collectTimeoutMs`, and an empty list otherwise, for a caller with a deadline of its
   * own such as a metrics scrape. Calls made while a read is in flight wait for that read instead
   * of starting another. A read that outlives the bound goes on and fills the cache, unless
   * {@link MetricsService.invalidate} was called since it began.
   *
   * @returns Metrics for all known queues, or none when the bound passed first.
   * @throws {QueueException} `METRICS_DISABLED` (503) when metrics are disabled.
   * @throws The error of the read, when it fails within the bound.
   * @example
   * const snapshots = await metrics.getAllWithinBound()
   */
  async getAllWithinBound(): Promise<readonly QueueMetrics[]> {
    this.ensureEnabled()
    this.pending ??= this.readAll()
    const wait = startWait(this.pending, this.collectTimeoutMs, { unref: true })
    try {
      assertPrototypeClean()
      const outcome = await wait.result
      if (outcome.state === 'failed') throw outcome.v
      return outcome.state === 'done' ? outcome.v : []
    } finally {
      wait.release()
    }
  }

  /** Read every queue, and stop being the read in flight once it has ended. */
  private async readAll(): Promise<readonly QueueMetrics[]> {
    try {
      return await own(this.getAll())
    } finally {
      this.pending = undefined
    }
  }

  /**
   * Invalidate the cache for `queueName`, or the whole cache when omitted. A read in flight, of any
   * queue, still answers whoever waits for it, and caches nothing. A
   * {@link MetricsService.getAllWithinBound} call made afterwards may wait for a shared read begun
   * before this one, and answer with what it read.
   *
   * @param queueName - The queue entry to drop; omit to clear everything.
   * @throws {QueueException} `METRICS_DISABLED` (503) when metrics are disabled.
   */
  invalidate(queueName?: string): void {
    this.ensureEnabled()
    this.generation += 1
    if (queueName === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(queueName)
  }

  /**
   * Guard every operation behind the opt-in flag.
   *
   * @throws {QueueException} `METRICS_DISABLED` (503) when metrics are disabled.
   */
  private ensureEnabled(): void {
    if (!this.enabled) {
      throw new QueueException(QUEUE_ERROR_CODES.METRICS_DISABLED, HttpStatus.SERVICE_UNAVAILABLE)
    }
  }
}
