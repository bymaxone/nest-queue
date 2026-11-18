/**
 * @fileoverview The Prometheus metrics of the queue, registered on the registry `@bymax-one/nest-core`
 * serves: how many attempts ended and how, how long they ran, and how deep each queue is. Labels come
 * from closed sets (the queue name the host configured, the outcome, the state); no job id, name or
 * data is ever a label.
 * @layer observability
 */

import { BymaxMetricsContributor } from '@bymax-one/nest-core/metrics'
import type { IMetricsContributor, MetricsRegistry } from '@bymax-one/nest-core/metrics'
import { Inject, Injectable } from '@nestjs/common'
import { Counter, Gauge, Histogram } from 'prom-client'
import { MetricsService, QueueObserverRegistry } from '@bymax-one/nest-queue'

/** The job states the depth gauge reports. */
const DEPTH_STATES = ['waiting', 'active', 'delayed', 'failed'] as const

/**
 * Registers `bymax_queue_jobs_total`, `bymax_queue_job_duration_seconds` and `bymax_queue_depth`.
 * The first two are fed by the attempts this process runs; the depth is read from
 * {@link MetricsService}, whose cache bounds how often a scrape reaches Redis, and is empty while
 * the module's `metrics` option is off.
 *
 * @example
 * \@Module({
 *   imports: [BymaxQueueModule.forRoot({ ... }), BymaxQueueObservabilityModule],
 * })
 * export class AppModule {}
 */
@BymaxMetricsContributor()
@Injectable()
export class QueueMetricsContributor implements IMetricsContributor {
  /**
   * @param observers - Where the queue reports how each attempt ended.
   * @param metrics - The cached snapshot of the queues' counts.
   */
  constructor(
    @Inject(QueueObserverRegistry) private readonly observers: QueueObserverRegistry,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /**
   * Create the collectors on `registry` and start feeding them.
   *
   * @param registry - The registry `@bymax-one/nest-core` serves.
   */
  registerMetrics(registry: MetricsRegistry): void {
    const jobs = new Counter({
      name: 'bymax_queue_jobs_total',
      help: 'Attempts of a job that ended, by queue and outcome (completed, failed, retried).',
      labelNames: ['queue', 'outcome'],
      registers: [registry],
    })
    const duration = new Histogram({
      name: 'bymax_queue_job_duration_seconds',
      help: 'Time a processor ran for one attempt of a job, by queue.',
      labelNames: ['queue'],
      registers: [registry],
    })
    this.observers.register({
      jobFinished: ({ queue, outcome, durationSeconds }) => {
        jobs.labels(queue, outcome).inc()
        duration.labels(queue).observe(durationSeconds)
      },
    })
    const metrics = this.metrics
    new Gauge({
      name: 'bymax_queue_depth',
      help: 'Jobs in a queue by state (waiting, active, delayed, failed), from the cached snapshot.',
      labelNames: ['queue', 'state'],
      registers: [registry],
      async collect(): Promise<void> {
        this.reset()
        const snapshots = await metrics.getAll().catch(() => [])
        for (const { queue, counts } of snapshots) {
          for (const state of DEPTH_STATES) this.labels(queue, state).set(counts[state])
        }
      },
    })
  }
}
