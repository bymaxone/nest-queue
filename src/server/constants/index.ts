/**
 * @fileoverview Barrel for the server-side constants.
 * @layer barrel
 */

export {
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from './default-options'
export { QUEUE_ERROR_CODES, QUEUE_ERROR_MESSAGES } from './error-codes'
export type { QueueErrorCode } from './error-codes'
