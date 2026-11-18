/**
 * @fileoverview How one attempt of a job ended, for an observer: done, failed for good, or failed and
 * to be run again. BullMQ moves a job on its own for the errors it throws to change the job's state
 * (a delay, a wait for children, a rate limit); those are not failures of the work, so they report
 * nothing.
 * @layer server/observability
 */

import type { Job } from 'bullmq'
import type { JobOutcome } from './queue-observer'

/** The errors a processor throws to hand the job back to BullMQ, which is not a failure of the work. */
const STATE_CHANGE_ERRORS: ReadonlySet<string> = new Set([
  'DelayedError',
  'WaitingError',
  'WaitingChildrenError',
  'RateLimitError',
])

/**
 * Classify the end of one attempt that threw.
 *
 * @param job - The job, as the processor received it; `attemptsMade` counts the attempts before this one.
 * @param error - What the processor threw.
 * @returns `retried` when BullMQ runs the job again, `failed` when it does not, `undefined` for an
 *   error that moves the job instead of failing it.
 */
export function failureOutcome(job: Job, error: unknown): JobOutcome | undefined {
  const name = error instanceof Error ? error.name : ''
  if (STATE_CHANGE_ERRORS.has(name)) return undefined
  if (name === 'UnrecoverableError') return 'failed'
  return job.attemptsMade + 1 < (job.opts.attempts ?? 1) ? 'retried' : 'failed'
}
