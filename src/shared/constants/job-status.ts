/**
 * @fileoverview Canonical job-status constant object.
 * @layer shared/constants
 */

/**
 * Canonical job status constants — use these in business logic instead of
 * hardcoded string literals. Declared `as const` so the literal types survive
 * into the emitted declaration files.
 *
 * @example
 * if (status === JOB_STATUS.FAILED) { retry() }
 */
export const JOB_STATUS = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DELAYED: 'delayed',
  PAUSED: 'paused',
} as const
