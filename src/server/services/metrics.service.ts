/**
 * @fileoverview MetricsService — an opt-in, in-memory TTL cache over
 * `QueueService.getMetrics`. Delegates one direction (Metrics → Queue) so there
 * is no circular dependency. Guarded: throws `METRICS_DISABLED` (503) unless
 * `metrics.enabled` was set.
 * @layer server/services
 */

import { Injectable } from '@nestjs/common'
import type { QueueMetrics } from '../../shared/types/queue-metrics.types'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

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

  constructor(
    private readonly queueService: QueueService,
    private readonly enabled: boolean,
    private readonly ttlMs: number,
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
    const metrics = await this.queueService.getMetrics(queueName)
    this.cache.set(queueName, { metrics, expiresAt: Date.now() + this.ttlMs })
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
   * Invalidate the cache for `queueName`, or the whole cache when omitted.
   *
   * @param queueName - The queue entry to drop; omit to clear everything.
   * @throws {QueueException} `METRICS_DISABLED` (503) when metrics are disabled.
   */
  invalidate(queueName?: string): void {
    this.ensureEnabled()
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
      throw new QueueException(QUEUE_ERROR_CODES.METRICS_DISABLED, 503)
    }
  }
}
