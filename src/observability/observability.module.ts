/**
 * @fileoverview Registers the queue's metrics contributor, readiness indicator and tracing observer.
 * Import `BymaxQueueObservabilityModule` next to `BymaxQueueModule`; `@bymax-one/nest-core` finds the
 * contributor and the indicator by their markers, and the tracing observer registers itself on
 * module init.
 * @layer observability
 */

import { Module } from '@nestjs/common'
import { QueueHealthIndicator } from './queue-health.indicator'
import { QueueMetricsContributor } from './queue-metrics.contributor'
import { QueueTracingObserver } from './queue-tracing.observer'

/**
 * The observability of the queue, as one module.
 *
 * @example
 * \@Module({ imports: [BymaxQueueModule.forRoot({ ... }), BymaxQueueObservabilityModule] })
 * export class AppModule {}
 */
@Module({
  providers: [QueueMetricsContributor, QueueHealthIndicator, QueueTracingObserver],
  exports: [QueueMetricsContributor, QueueHealthIndicator, QueueTracingObserver],
})
export class BymaxQueueObservabilityModule {}
