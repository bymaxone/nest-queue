/**
 * @fileoverview Finds what is wrong with the `defaultJobOptions` of a module, at setup, where the
 * mistake costs nothing. BullMQ takes these values as they come: `NaN` or `Infinity` in a count or
 * a delay fails with a raw serialisation error on the first job, and a `count` of `-1` or `1.5` on
 * `removeOnComplete` or `removeOnFail` keeps every job, which removes the cap that keeps Redis
 * bounded without a word.
 * @layer server/utils
 */

import { MAX_JOB_PRIORITY } from '../constants/default-options'

/**
 * Whether `value` is a whole number from 0 up that a double holds exactly, the shape of every count,
 * delay and age here. `Number.isInteger` alone accepts `1e300` and `2 ** 53`, which Redis and JSON do
 * not carry faithfully.
 */
function isWholeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The reason a priority is wrong: a whole number from 0 up to what BullMQ accepts. */
function priorityProblem(path: string, value: unknown): string | undefined {
  return value === undefined || (isWholeNumber(value) && (value as number) <= MAX_JOB_PRIORITY)
    ? undefined
    : `${path} must be a whole number from 0 to ${String(MAX_JOB_PRIORITY)}`
}

/** The reason `value` is not a whole number >= 0, when `value` is set. */
function wholeNumberProblem(path: string, value: unknown): string | undefined {
  return value === undefined || isWholeNumber(value)
    ? undefined
    : `${path} must be a whole number >= 0`
}

/** The reason a `removeOn*` value is wrong: `true`, `false`, a count, or `{ age?, count? }`. */
function retentionProblem(path: string, value: unknown): string | undefined {
  if (value === undefined || typeof value === 'boolean') return undefined
  if (typeof value !== 'object' || value === null) return wholeNumberProblem(path, value)
  const { age, count } = value as { age?: unknown; count?: unknown }
  return wholeNumberProblem(`${path}.age`, age) ?? wholeNumberProblem(`${path}.count`, count)
}

/** The reason a `backoff` is wrong: a delay in milliseconds, or `{ type, delay?, jitter? }`. */
function backoffProblem(path: string, value: unknown): string | undefined {
  if (value === undefined || typeof value !== 'object' || value === null) {
    return wholeNumberProblem(path, value)
  }
  const { delay, jitter } = value as { delay?: unknown; jitter?: unknown }
  const jitterIsValid =
    jitter === undefined || (typeof jitter === 'number' && jitter >= 0 && jitter <= 1)
  return (
    wholeNumberProblem(`${path}.delay`, delay) ??
    (jitterIsValid ? undefined : `${path}.jitter must be a number from 0 to 1`)
  )
}

/**
 * The first problem in `defaultJobOptions`, as a reason that names the option and never its value,
 * or `undefined` when there is none. Options this does not know are BullMQ's to judge.
 *
 * @param defaults - The `defaultJobOptions` of the module options, as given.
 */
export function jobDefaultsProblem(defaults: unknown): string | undefined {
  if (typeof defaults !== 'object' || defaults === null) return undefined
  const o = defaults as Record<string, unknown>
  const base = 'defaultJobOptions'
  return (
    wholeNumberProblem(`${base}.attempts`, o.attempts) ??
    wholeNumberProblem(`${base}.delay`, o.delay) ??
    priorityProblem(`${base}.priority`, o.priority) ??
    backoffProblem(`${base}.backoff`, o.backoff) ??
    retentionProblem(`${base}.removeOnComplete`, o.removeOnComplete) ??
    retentionProblem(`${base}.removeOnFail`, o.removeOnFail)
  )
}
