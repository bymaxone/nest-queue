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

/** The type of a value, in words, and never the value: `null`, `an array`, `an object` or `a <typeof>`. */
export function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const type = typeof value
  return type === 'object' ? 'an object' : `a ${type}`
}

/**
 * What was received, for a refusal: a finite number as it is, `null`, or only the type of anything
 * else, never any other value, which can come from a request or a file and may be a secret.
 */
export function received(value: unknown): string {
  if (Number.isFinite(value)) return String(value)
  return typeof value === 'number' ? 'a number that is not finite' : kindOf(value)
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

/**
 * The reason a backoff `type` has no strategy behind it. BullMQ builds in `fixed` and `exponential`;
 * any other needs a `backoffStrategy` on the worker, which `WorkerRegistry` does not pass on, and
 * without one BullMQ cannot move the failed job and leaves it active.
 */
function backoffTypeProblem(path: string, type: unknown): string | undefined {
  if (type === 'fixed' || type === 'exponential') return undefined
  const given = type === undefined ? 'none' : received(type)
  return `${path} must be 'fixed' or 'exponential', received ${given}`
}

/** The reason a `backoff` is wrong: a delay in milliseconds, or `{ type, delay?, jitter? }`. */
function backoffProblem(path: string, value: unknown): string | undefined {
  if (Array.isArray(value)) return `${path} must be a number or an object, received an array`
  if (typeof value !== 'object' || value === null) return wholeNumberProblem(path, value)
  const { type, delay, jitter } = value as { type?: unknown; delay?: unknown; jitter?: unknown }
  const jitterIsValid =
    jitter === undefined || (typeof jitter === 'number' && jitter >= 0 && jitter <= 1)
  return (
    wholeNumberProblem(`${path}.delay`, delay) ??
    (jitterIsValid
      ? undefined
      : `${path}.jitter must be a number from 0 to 1, received ${received(jitter)}`) ??
    backoffTypeProblem(`${path}.type`, type)
  )
}

/**
 * The first problem in a set of job options, as a reason that names the option by `path` and what it
 * received (a finite number as it is, `null`, or only the type of anything else), or `undefined` when
 * there is none. The module's `defaultJobOptions` and the options of one job go through the same
 * check. Options this does not know are BullMQ's to judge.
 *
 * @param options - The job options, as given.
 * @param path - What to call them in a reason, such as `defaultJobOptions` or `flow.children[0].opts`.
 */
export function jobOptionsProblem(options: unknown, path: string): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const o = options as Record<string, unknown>
  return (
    wholeNumberProblem(`${path}.attempts`, o.attempts) ??
    wholeNumberProblem(`${path}.delay`, o.delay) ??
    priorityProblem(`${path}.priority`, o.priority) ??
    backoffProblem(`${path}.backoff`, o.backoff) ??
    retentionProblem(`${path}.removeOnComplete`, o.removeOnComplete) ??
    retentionProblem(`${path}.removeOnFail`, o.removeOnFail)
  )
}
