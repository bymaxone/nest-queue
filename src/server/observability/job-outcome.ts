/**
 * @fileoverview How one attempt of a job ended, for an observer: done, failed for good, or failed and
 * to be run again. BullMQ moves a job on its own for the errors it throws to change the job's state
 * (a delay, a wait for children, a rate limit); those are not failures of the work, so they report
 * nothing.
 * @layer server/observability
 */

import type { Job, JobsOptions } from 'bullmq'
import type { JobOutcome } from './queue-observer'

/** What a processor says when it hands the job back to BullMQ instead of finishing or failing it. */
export type HandBack = 'delayed' | 'waiting_children' | 'rate_limited' | 'waiting'

/** The message of BullMQ's `RateLimitError`, which its worker reads a manual rate limit by. */
const RATE_LIMIT_MESSAGE = 'bullmq:rateLimitExceeded'

/** The names BullMQ's worker reads as control flow, and what each one means. */
const HAND_BACKS: Readonly<Record<string, HandBack>> = {
  DelayedError: 'delayed',
  WaitingChildrenError: 'waiting_children',
  WaitingError: 'waiting',
}

/**
 * Whether a processor's error hands the job back to BullMQ, decided the way BullMQ's worker decides
 * it in `handleFailed`: a rate limit by its message, the others by the name of the error (which is
 * also how a second copy of the package is recognised). A spec pins the message and the names to
 * BullMQ's own classes. An error BullMQ does not read as control flow is a failure of the work.
 *
 * @param error - What the processor threw.
 * @returns What the processor handed back, or `undefined` for a failure.
 * @example
 * handBackOf(new DelayedError()) // 'delayed'
 * handBackOf(new Error('boom')) // undefined
 */
export function handBackOf(error: unknown): HandBack | undefined {
  // BullMQ reads the message first and the name after it, and each read is guarded on its own, so a
  // member that throws, or a value that has none (`null`), never hides the other one.
  if (memberOf(error, 'message') === RATE_LIMIT_MESSAGE) return 'rate_limited'
  const name = memberOf(error, 'name')
  return typeof name === 'string' && Object.hasOwn(HAND_BACKS, name) ? HAND_BACKS[name] : undefined
}

/**
 * A member of what a processor threw. Reading it can itself throw (a getter), and that must never
 * replace the processor's own error, so an unreadable member reads as absent.
 */
function memberOf(error: unknown, key: 'name' | 'message'): unknown {
  try {
    return (error as Record<string, unknown>)[key]
  } catch {
    // An unreadable member is absent.
  }
  return undefined
}

/** Whether the error is BullMQ's `UnrecoverableError`, which fails the job whatever attempts remain. */
function isUnrecoverable(error: unknown): boolean {
  try {
    return error instanceof Error && memberOf(error, 'name') === 'UnrecoverableError'
  } catch {
    // A rejection whose prototype chain throws on `instanceof` is not an unrecoverable error.
  }
  return false
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
 * Classify the end of one attempt that threw.
 *
 * @param job - The job, as the processor received it; `attemptsMade` counts the attempts before this one.
 * @param error - What the processor threw.
 * @returns `retried` when BullMQ runs the job again, `failed` when it does not, `undefined` for an
 *   error that moves the job instead of failing it.
 */
export function failureOutcome(job: Job, error: unknown): JobOutcome | undefined {
  if (handBackOf(error) !== undefined) return undefined
  if (isUnrecoverable(error)) return 'failed'
  return job.attemptsMade + 1 < (optionsOf(job)?.attempts ?? 1) ? 'retried' : 'failed'
}
