/**
 * @fileoverview Bound on the index window a listing call may ask BullMQ for.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { MAX_JOBS_PAGE_SIZE } from '../constants/default-options'

/**
 * Refuse a listing window that is not a bounded range of integers: BullMQ reads `-1` as "to the
 * end", so an open window returns every entry in one reply.
 *
 * @param operation - The public method name, used in the reason.
 * @param start - First index, inclusive.
 * @param end - Last index, inclusive.
 * @throws {QueueException} `INVALID_OPTIONS` (400) when the window is unbounded or malformed.
 */
export function assertPageWindow(operation: string, start: number, end: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end - start >= MAX_JOBS_PAGE_SIZE
  ) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.BAD_REQUEST, {
      reason: `${operation} needs integers with 0 <= start <= end and at most ${String(MAX_JOBS_PAGE_SIZE)} jobs per call`,
    })
  }
}
