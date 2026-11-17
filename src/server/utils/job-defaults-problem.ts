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
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** The reason a priority is wrong: a whole number from 0 up to what BullMQ accepts. */
function priorityProblem(path: string, value: unknown): string | undefined {
  return value === undefined || (isWholeNumber(value) && (value as number) <= MAX_JOB_PRIORITY)
    ? undefined
    : `${path} must be a whole number from 0 to ${String(MAX_JOB_PRIORITY)}, received ${received(value)}`
}

/**
 * What was received, for a refusal: a finite number as it is, `null`, or only the type of anything
 * else, never any other value, which can come from a request or a file and may be a secret.
 */
function received(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : 'a number that is not finite'
  if (Array.isArray(value)) return 'an array'
  const type = typeof value
  return type === 'object' ? 'an object' : `a ${type}`
}

/** The reason `value` is not a whole number >= 0, when `value` is set. */
function wholeNumberProblem(path: string, value: unknown): string | undefined {
  return value === undefined || isWholeNumber(value)
    ? undefined
    : `${path} must be a whole number >= 0, received ${received(value)}`
}

/** The reason a `removeOn*` value is wrong: `true`, `false`, a count, or `{ age?, count? }`. */
function retentionProblem(path: string, value: unknown): string | undefined {
  if (typeof value === 'boolean') return undefined
  if (Array.isArray(value))
    return `${path} must be true, false, a number or an object, received an array`
  if (typeof value !== 'object' || value === null) return wholeNumberProblem(path, value)
  const { age, count } = value as { age?: unknown; count?: unknown }
  return wholeNumberProblem(`${path}.age`, age) ?? wholeNumberProblem(`${path}.count`, count)
}

/** The reason a `backoff` is wrong: a delay in milliseconds, or `{ type, delay?, jitter? }`. */
function backoffProblem(path: string, value: unknown): string | undefined {
  if (Array.isArray(value)) return `${path} must be a number or an object, received an array`
  if (typeof value !== 'object' || value === null) {
    return wholeNumberProblem(path, value)
  }
  const { delay, jitter } = value as { delay?: unknown; jitter?: unknown }
  const jitterIsValid =
    jitter === undefined || (typeof jitter === 'number' && jitter >= 0 && jitter <= 1)
  return (
    wholeNumberProblem(`${path}.delay`, delay) ??
    (jitterIsValid
      ? undefined
      : `${path}.jitter must be a number from 0 to 1, received ${received(jitter)}`)
  )
}

/**
 * The first problem in `defaultJobOptions`, as a reason that names the option and what it received (a
 * finite number as it is, `null`, or only the type of anything else), or `undefined` when there is none. Options
 * this does not know are BullMQ's to judge.
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
