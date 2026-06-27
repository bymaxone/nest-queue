/**
 * @fileoverview Health controller — exposes a `/health` endpoint with queue metrics.
 * Demonstrates MetricsService and QueueService usage to surface queue depth and throughput.
 * @layer presentation
 */

import { Controller, Get } from '@nestjs/common'
import { QueueService, MetricsService } from '@bymax-one/nest-queue'
import type { QueueMetrics } from '@bymax-one/nest-queue/shared'

/** Aggregated health response shape. */
interface HealthResponse {
  /** Overall health status. */
  status: 'ok' | 'degraded'
  /** Per-queue metrics snapshot. */
  queues: Record<string, QueueMetrics>
}

/** Queue names monitored by this endpoint. */
const MONITORED_QUEUES = ['email', 'orders', 'payments'] as const

/**
 * Exposes queue health information for observability and load-balancer checks.
 *
 * @example
 * ```
 * GET /health
 * → { "status": "ok", "queues": { "email": { "counts": { ... }, ... } } }
 * ```
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly queueService: QueueService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Return a snapshot of queue metrics for all monitored queues.
   *
   * @returns An object with an `ok` or `degraded` status and per-queue metrics.
   */
  @Get()
  async getHealth(): Promise<HealthResponse> {
    // Ensure each monitored queue is registered in QueueService before fetching metrics
    for (const name of MONITORED_QUEUES) {
      this.queueService.getOrCreateQueue(name)
    }

    // getAll() returns metrics for all queues currently cached in QueueService
    const allMetrics = await this.metrics.getAll()

    const queues: Record<string, QueueMetrics> = {}
    let totalWaiting = 0
    for (const m of allMetrics) {
      queues[m.queue] = m
      totalWaiting += m.counts.waiting
    }

    // Consider the service degraded when any queue has more than 1 000 waiting jobs
    const status: 'ok' | 'degraded' = totalWaiting > 1_000 ? 'degraded' : 'ok'

    return { status, queues }
  }
}
