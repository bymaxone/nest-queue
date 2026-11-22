/**
 * @fileoverview One read of the list of jobs a host passes to a bulk enqueue. The list is the
 * host's: a subclass of `Array` can answer `map` or the iterator with something else, a Proxy or a
 * getter can answer a second read differently, and any read can throw. The list is copied by index,
 * its length read once and bounded, each job read once, so what is checked is what BullMQ is sent.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import { bulkUnreadable, guarded } from '../config/guarded-read'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import type { BulkJob } from '../interfaces/queue-job-data.interface'
import { kindOf } from './job-defaults-problem'

/** Refuse with the library's own code and a reason that names the list and the type, never a value. */
function refuse(reason: string, extra: Record<string, unknown> = {}): never {
  throw new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, HttpStatus.BAD_REQUEST, {
    reason,
    ...extra,
  })
}

/**
 * Copy a list of jobs by index, once, under a guard.
 *
 * @param jobs - The list as the host gave it.
 * @param limit - The most jobs one batch may hold.
 * @returns A plain array of `{ name, data, options }`, each field read once.
 * @throws {QueueException} `BULK_ENQUEUE_FAILED` (400) for a length that is not a whole number, a
 *   batch over `limit`, an entry that is not an object, or a read that throws (the host's error is the cause).
 */
export function readBulkJobs<T>(jobs: readonly BulkJob<T>[], limit: number): BulkJob<T>[] {
  const length = guarded('jobs', () => jobs.length, bulkUnreadable)
  if (!Number.isSafeInteger(length) || length < 0) {
    refuse('jobs must have a whole number length')
  }
  if (length > limit) refuse('batch size exceeds limit', { limit, received: length })
  const copy: BulkJob<T>[] = []
  for (let index = 0; index < length; index += 1) {
    const where = `jobs[${String(index)}]`
    const job: unknown = guarded(where, () => jobs[index], bulkUnreadable)
    if (typeof job !== 'object' || job === null)
      refuse(`${where} must be an object, received ${kindOf(job)}`)
    copy.push(
      guarded(
        where,
        () => {
          const entry = job as BulkJob<T>
          const { name, data, options } = entry
          return options === undefined ? { name, data } : { name, data, options }
        },
        bulkUnreadable,
      ),
    )
  }
  return copy
}
