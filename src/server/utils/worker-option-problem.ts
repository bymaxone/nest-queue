/**
 * @fileoverview The checks a worker's tunable options must pass before a BullMQ `Worker` is built.
 * @layer server/utils
 */

import { MAX_WORKER_CONCURRENCY } from '../constants/default-options'
import type { WorkerOptions } from '../interfaces/worker-options.interface'
import { MAX_TIMER_DELAY_MS } from './timer-delay'

/**
 * The shortest `lockDuration` and `stalledInterval` accepted. BullMQ renews a job's lock at half
 * of `lockDuration`, so below one second the renewal falls inside ordinary event-loop delay and a
 * busy process loses locks it still holds, which stalls and re-runs live jobs; a shorter
 * `stalledInterval` only makes every worker sweep Redis for stalled jobs more than once a second.
 */
const WORKER_TIMER_MIN_MS = 1000

/** What a refusal reports: the reason and the value that caused it. */
interface OptionProblem {
  reason: string
  actual: number
  [detail: string]: unknown
}

/** The refusal for a whole number `value` outside `[min, max]`, or for a non-whole one. */
function countProblem(
  name: string,
  value: number,
  min: number,
  max: number,
): OptionProblem | undefined {
  if (!Number.isInteger(value)) return { reason: `${name} must be a whole number`, actual: value }
  if (value < min) return { reason: `${name} must be >= ${String(min)}`, actual: value }
  if (value > max) return { reason: `${name} must be <= ${String(max)}`, actual: value }
  return undefined
}

/** The refusal for a timer option outside the supported range, or undefined. */
function timerProblem(name: string, value: number | undefined): OptionProblem | undefined {
  if (value === undefined) return undefined
  if (Number.isInteger(value) && value >= WORKER_TIMER_MIN_MS && value <= MAX_TIMER_DELAY_MS) {
    return undefined
  }
  return {
    reason: `${name} must be a whole number from ${String(WORKER_TIMER_MIN_MS)} to ${String(MAX_TIMER_DELAY_MS)}`,
    actual: value,
  }
}

/**
 * The first problem in a worker's tunable options, or undefined when they are all acceptable.
 *
 * @param opts - The caller-supplied options (may be undefined).
 * @returns The reason and the offending value, in the shape of the exception details.
 */
export function workerOptionProblem(opts?: WorkerOptions): OptionProblem | undefined {
  if (opts === undefined) return undefined
  const { concurrency, limiter, lockDuration, stalledInterval } = opts
  return (
    (concurrency === undefined
      ? undefined
      : countProblem('concurrency', concurrency, 1, MAX_WORKER_CONCURRENCY)) ??
    (limiter === undefined
      ? undefined
      : (countProblem('limiter.max', limiter.max, 1, Number.POSITIVE_INFINITY) ??
        countProblem('limiter.duration', limiter.duration, 1, Number.POSITIVE_INFINITY))) ??
    timerProblem('lockDuration', lockDuration) ??
    timerProblem('stalledInterval', stalledInterval)
  )
}
