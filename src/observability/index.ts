/**
 * @fileoverview The optional `@bymax-one/nest-queue/observability` entry: Prometheus metrics,
 * a readiness indicator and OpenTelemetry spans for the queue. It needs the optional peers
 * `@bymax-one/nest-core`, `prom-client` and `@opentelemetry/api`.
 * @layer observability
 */

export { BymaxQueueObservabilityModule } from './observability.module'
export { QueueMetricsContributor } from './queue-metrics.contributor'
export { QueueHealthIndicator, QUEUE_HEALTH_INDICATOR_NAME } from './queue-health.indicator'
export { QueueTracingObserver } from './queue-tracing.observer'
