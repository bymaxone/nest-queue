/**
 * @fileoverview Public entry point for the server subpath — the NestJS module,
 * services, tokens, errors, and convenience type re-exports.
 * @layer barrel
 */

// Root module
export { BymaxQueueModule } from './bymax-queue.module'

// Injection tokens
export {
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_REDIS_CLIENT,
  BYMAX_QUEUE_CONNECTION_MODE,
  BYMAX_QUEUE_RESOLVED_OPTIONS,
} from './bymax-queue.constants'

// Public services
export { QueueService } from './services/queue.service'
export { ConnectionResolver } from './services/connection-resolver.service'

// Public interface types
export type {
  BymaxQueueModuleOptions,
  BymaxQueueModuleAsyncOptions,
  BymaxQueueOptionsFactory,
} from './interfaces/queue-module-options.interface'
export type {
  QueueConnectionConfig,
  QueueConnectionMode,
} from './interfaces/queue-connection.interface'
export type { WorkerOptions } from './interfaces/worker-options.interface'
export type {
  ProcessorMetadata,
  ProcessHandlerMetadata,
  QueueEventListenerMetadata,
} from './interfaces/processor-metadata.interface'
export type { BulkJob } from './interfaces/queue-job-data.interface'

// Errors and constants
export { QueueException } from './errors/queue-exception'
export { QUEUE_ERROR_CODES, QUEUE_ERROR_MESSAGES } from './constants/error-codes'
export type { QueueErrorCode } from './constants/error-codes'
export {
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from './constants/default-options'

// BullMQ convenience type re-exports
export type { Job, JobsOptions, Queue, Worker, QueueEvents } from 'bullmq'

// Shared re-exports
export type { JobStatus } from '../shared/types/job-status.types'
export type { QueueMetrics } from '../shared/types/queue-metrics.types'
export type { JobSchedulerRepeatOptions } from '../shared/types/job-scheduler-options.types'
export { JOB_STATUS } from '../shared/constants/job-status'
