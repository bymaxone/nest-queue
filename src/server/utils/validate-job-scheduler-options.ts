/**
 * @fileoverview Structural validation for Job Scheduler repeat options. Cron
 * patterns are NOT parsed here: cron syntax is delegated to BullMQ's bundled
 * parser at registration time, so the library ships no hand-rolled cron regex
 * (incorrect for 6-field patterns and a ReDoS risk) and adds no cron-parser
 * dependency.
 * @layer server/utils
 */

import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Raise the standardized invalid-repeat-options error.
 *
 * @param reason - Human-readable, secret-free explanation of the failure.
 */
function invalid(reason: string): never {
  throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, 400, { reason })
}

/**
 * Normalize an epoch-ms-or-ISO date to epoch milliseconds.
 *
 * @param date - Epoch milliseconds or an ISO-8601 string.
 * @returns The epoch milliseconds, or `NaN` when the string is unparseable.
 */
function toEpochMs(date: number | string): number {
  return typeof date === 'number' ? date : Date.parse(date)
}

/**
 * Validate a Job Scheduler schedule before delegating to BullMQ. Enforces the
 * structural rules — exactly one of `pattern` | `every`, a positive integer
 * `every`, and a future `endDate`. Cron syntax itself is validated by BullMQ
 * (which uses `cron-parser` internally) when the scheduler is upserted, so this
 * function never inspects the cron string directly.
 *
 * @param repeat - The schedule to validate.
 * @throws {QueueException} `INVALID_REPEAT_OPTIONS` (400) when the shape is invalid.
 */
export function validateJobSchedulerOptions(repeat: JobSchedulerRepeatOptions): void {
  const hasPattern = 'pattern' in repeat
  const hasEvery = 'every' in repeat
  if (hasPattern === hasEvery) {
    invalid('exactly one of pattern | every is required')
  }
  if ('every' in repeat && (!Number.isInteger(repeat.every) || repeat.every <= 0)) {
    invalid('every must be a positive integer')
  }
  if (repeat.endDate !== undefined) {
    const endMs = toEpochMs(repeat.endDate)
    if (Number.isNaN(endMs) || endMs <= Date.now()) {
      invalid('endDate must be in the future')
    }
  }
}
