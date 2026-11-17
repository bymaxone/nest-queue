/**
 * @fileoverview The job ids a queue cannot hold because BullMQ already keeps one of its own
 * structures under the same Redis key. A job is stored at `<prefix>:<queue>:<jobId>`, so the id
 * `active` lands on the key of the active list; BullMQ checks neither, and the queue is corrupted
 * or the job is never queued.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import { QueueKeys } from 'bullmq'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'

/** Any prefix and name do: only what follows `<prefix>:<name>:` in each key is read. */
const STEM = 'p:q:'

/**
 * Every suffix BullMQ gives a queue key, read from `QueueKeys` of the installed BullMQ so that a
 * key a later version adds is refused without an edit here.
 */
export const RESERVED_JOB_IDS: ReadonlySet<string> = new Set(
  Object.values(new QueueKeys('p').getKeys('q'))
    .filter((key) => key.startsWith(STEM) && key.length > STEM.length)
    .map((key) => key.slice(STEM.length)),
)

/**
 * Whether a job id collides with a key BullMQ keeps for the queue itself.
 *
 * @param jobId - The id a caller chose for a job.
 * @returns `true` when the id is one of the queue's own key names.
 */
export function isReservedJobId(jobId: string): boolean {
  return RESERVED_JOB_IDS.has(jobId)
}

/**
 * Refuse a custom job id that collides with a key BullMQ keeps for the queue, without echoing it:
 * the id often comes from request data. An absent id passes, since BullMQ then generates one.
 *
 * @param jobId - The custom id of a job, when the caller gave one.
 * @param field - The option the id came from, named in the refusal: `jobId` or `parent.id`.
 * @throws {QueueException} `INVALID_JOB_ID` (400) with `{ field }` for a reserved id.
 */
export function assertJobIdAllowed(jobId: string | undefined, field = 'jobId'): void {
  // Stryker disable next-line ConditionalExpression: equivalent — `Set.has(undefined)` is false, so dropping the presence check changes nothing observable; it states that an absent id passes and narrows the type
  if (jobId !== undefined && isReservedJobId(jobId)) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_JOB_ID, HttpStatus.BAD_REQUEST, { field })
  }
}
