/**
 * @fileoverview How a failed attempt of a job ended, for an observer: to be run again, or failed for
 * good. The answer is read from the move BullMQ makes after the processor threw, not from the job's
 * options, which can promise a retry BullMQ never schedules (a backoff type with no strategy, or a
 * delay of -1). BullMQ makes no such move for the errors it reads as a change of the job's state (a
 * delay, a wait for children, a rate limit), nor for a thrown value it cannot read, so those report
 * nothing.
 * @layer server/observability
 */

import type { Job, JobsOptions } from 'bullmq'
import { memberOf } from '../../shared/hand-back'
import { own, outcomeOf } from '../utils/bounded-wait'
import type { JobOutcome } from './queue-observer'

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
 * Whether BullMQ calls the move again after this error: it retries a lost connection for as long as
 * it lasts, and gives up on any other.
 */
function isConnectionError(error: unknown): boolean {
  const message = memberOf(error, 'message')
  return (
    memberOf(error, 'name') === 'ConnectionClosedError' ||
    message === 'Connection is closed.' ||
    String(message).includes('ECONNREFUSED') ||
    memberOf(error, 'code') === 'ECONNREFUSED'
  )
}

/**
 * Report how BullMQ moves a job whose attempt threw. Call it before the error reaches BullMQ: it
 * gives this job object its own `moveToFailed`, which runs BullMQ's and reads what it did.
 *
 * @param job - The job, as the processor received it, which BullMQ then moves.
 * @param report - Called at most once: `retried` when the move leaves the job unfinished, to be run
 *   again; `failed` when it finishes the job, or when BullMQ gives up on the move and leaves the job
 *   active. Not called when BullMQ makes no move.
 */
export function reportFailedMove(job: Job, report: (outcome: JobOutcome) => void): void {
  const move = Reflect.get<Job, 'moveToFailed'>(job, 'moveToFailed')
  let reported = false
  const once = (outcome: JobOutcome): void => {
    if (reported) return
    reported = true
    report(outcome)
  }
  job.moveToFailed = async (...args) => {
    const moved = await own(outcomeOf(() => Reflect.apply(move, job, args)))
    if (moved.state === 'failed') {
      if (!isConnectionError(moved.v)) once('failed')
      throw moved.v
    }
    once(job.finishedOn === undefined ? 'retried' : 'failed')
    return moved.v
  }
}
