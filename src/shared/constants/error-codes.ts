/**
 * @fileoverview Stable error-code catalog emitted by the library, plus the
 * derived code union. Single source of truth, re-exported by the server barrel.
 * @layer shared/constants
 */

/**
 * Stable, transport-independent error codes emitted through `QueueException`.
 * Declared `as const` so each value keeps its literal type in the emitted
 * declaration files.
 *
 * @example
 * if (error.code === QUEUE_ERROR_CODES.JOB_NOT_FOUND) { return null }
 */
export const QUEUE_ERROR_CODES = {
  CONNECTION_INVALID: 'queue.connection_invalid',
  CONNECTION_REQUIRES_NULL_RETRIES: 'queue.connection_requires_null_retries',
  CONNECTION_TIMEOUT: 'queue.connection_timeout',
  QUEUE_NOT_FOUND: 'queue.queue_not_found',
  JOB_NOT_FOUND: 'queue.job_not_found',
  INVALID_JOB_DATA: 'queue.invalid_job_data',
  INVALID_REPEAT_OPTIONS: 'queue.invalid_repeat_options',
  DUPLICATE_PROCESSOR: 'queue.duplicate_processor',
  FLOW_DISABLED: 'queue.flow_disabled',
  METRICS_DISABLED: 'queue.metrics_disabled',
  SHUTDOWN_TIMEOUT_EXCEEDED: 'queue.shutdown_timeout_exceeded',
  BULK_ENQUEUE_FAILED: 'queue.bulk_enqueue_failed',
  WORKER_REGISTRATION_FAILED: 'queue.worker_registration_failed',
  INVALID_OPTIONS: 'queue.invalid_options',
} as const

/** Union of every value in {@link QUEUE_ERROR_CODES}. */
export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES]
