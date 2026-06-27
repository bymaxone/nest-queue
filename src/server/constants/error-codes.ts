/**
 * @fileoverview Server-side error-code re-exports plus the human-readable
 * message catalog keyed by code.
 * @layer server/constants
 */

import { QUEUE_ERROR_CODES } from '../../shared/constants/error-codes'

export { QUEUE_ERROR_CODES } from '../../shared/constants/error-codes'
export type { QueueErrorCode } from '../../shared/constants/error-codes'

/**
 * Human-readable messages keyed by error code — mirrors the specification's
 * error catalog. Every value of {@link QUEUE_ERROR_CODES} has an entry.
 */
export const QUEUE_ERROR_MESSAGES: Record<string, string> = {
  [QUEUE_ERROR_CODES.CONNECTION_INVALID]: 'Invalid Redis connection configuration',
  [QUEUE_ERROR_CODES.CONNECTION_REQUIRES_NULL_RETRIES]:
    'Worker connection must have maxRetriesPerRequest=null',
  [QUEUE_ERROR_CODES.CONNECTION_TIMEOUT]: 'Redis connection timeout',
  [QUEUE_ERROR_CODES.QUEUE_NOT_FOUND]: 'Queue not found',
  [QUEUE_ERROR_CODES.JOB_NOT_FOUND]: 'Job not found',
  [QUEUE_ERROR_CODES.INVALID_JOB_DATA]: 'Invalid job data',
  [QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS]: 'Invalid repeat options',
  [QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR]:
    'Multiple processor decorators target the same queue',
  [QUEUE_ERROR_CODES.FLOW_DISABLED]: 'Flow support is disabled',
  [QUEUE_ERROR_CODES.METRICS_DISABLED]: 'Metrics support is disabled',
  [QUEUE_ERROR_CODES.SHUTDOWN_TIMEOUT_EXCEEDED]: 'Shutdown timeout exceeded',
  [QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED]: 'Bulk enqueue failed',
  [QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED]: 'Failed to register worker',
  [QUEUE_ERROR_CODES.INVALID_OPTIONS]: 'Invalid module options',
}
