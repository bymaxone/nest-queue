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
import { hear, outcomeOf } from '../utils/bounded-wait'
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
 * Wait for a move BullMQ already started, and say how it went. The library's prototype guard does not
 * run here: the move is running, so a refusal could only report an outcome it has not had yet. The
 * promise was given the intrinsic `constructor`, so awaiting it reads nothing a host can replace.
 */
async function readMove(
  moving: Promise<unknown>,
  job: Job,
  report: (outcome: JobOutcome) => void,
): Promise<void> {
  try {
    await moving
  } catch (error) {
    if (!isConnectionError(error)) report('failed')
    return
  }
  report(job.finishedOn === undefined ? 'retried' : 'failed')
}

/**
 * Report how BullMQ moves a job whose attempt threw. Call it before the error reaches BullMQ: it
 * gives this job object its own `moveToFailed`, which hands back the promise of BullMQ's move as it
 * is and reads what that move did.
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
  job.moveToFailed = (...args) => {
    const moving = Reflect.apply(move, job, args)
    // Listened to before BullMQ is, so the observers hear the outcome before BullMQ acts on it.
    hear(moving)
    void outcomeOf(() => readMove(moving, job, once))
    return moving
  }
}
