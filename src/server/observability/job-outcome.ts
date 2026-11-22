/**
 * @fileoverview How one attempt of a job ended, for an observer: done, failed for good, or failed and
 * to be run again. BullMQ moves a job on its own for the errors it throws to change the job's state
 * (a delay, a wait for children, a rate limit); those are not failures of the work, so they report
 * nothing.
 * @layer server/observability
 */

import type { Job, JobsOptions } from 'bullmq'
import { handBackOf, memberOf } from '../../shared/hand-back'
import type { JobOutcome } from './queue-observer'

/**
 * Whether the error is BullMQ's `UnrecoverableError`, which fails the job whatever attempts remain.
 * BullMQ recognises it by `instanceof` or by name, and the name is what an error from another realm
 * or a second copy of the package carries, so the name alone is read here.
 */
function isUnrecoverable(error: unknown): boolean {
  return memberOf(error, 'name') === 'UnrecoverableError'
}

/**
 * The options of a job, typed as possibly absent: a job a host built by hand, to call a handler in
 * its own test, may carry none.
 *
 * @param job - The job, as the processor received it.
 */
export function optionsOf(job: Job): JobsOptions | undefined {
  return job.opts
}

/**
 * Whether BullMQ can read what the processor threw. Before it moves a job it reads the `message`, the
 * prototype (for `instanceof`) and the `name` of the error, unguarded, so a `null`, an `undefined`, or
 * a value one of whose reads throws ends in BullMQ's own handling, which emits `error`, leaves the job
 * active and schedules no retry: the attempt has neither been retried nor failed.
 */
function isReadableByBullMq(error: unknown): boolean {
  if (error === null || error === undefined) return false
  try {
    const read = error as { message?: unknown; name?: unknown }
    return [read.message, Object.getPrototypeOf(error), read.name].length > 0
  } catch {
    return false
  }
}

/**
 * Classify the end of one attempt that threw.
 *
 * @param job - The job, as the processor received it; `attemptsMade` counts the attempts before this one.
 * @param error - What the processor threw.
 * @returns `retried` when BullMQ runs the job again, `failed` when it does not, `undefined` for an
 *   error that moves the job instead of failing it, and for one BullMQ cannot read.
 */
export function failureOutcome(job: Job, error: unknown): JobOutcome | undefined {
  if (handBackOf(error) !== undefined || !isReadableByBullMq(error)) return undefined
  if (isUnrecoverable(error)) return 'failed'
  return job.attemptsMade + 1 < (optionsOf(job)?.attempts ?? 1) ? 'retried' : 'failed'
}
