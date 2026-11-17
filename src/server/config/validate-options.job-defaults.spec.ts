/**
 * @fileoverview Unit tests for the validation of `defaultJobOptions` at module setup. BullMQ takes
 * these values as they come: `NaN` or `Infinity` in a count or a delay fails with a raw Redis error
 * on the first job, and a `count` of `-1` or `1.5` on `removeOnComplete` or `removeOnFail` keeps every
 * job, which removes the retention cap silently. Each field is tried with the six values that
 * matter, and the refusal names the option and never the value.
 * @layer server/config
 */

import { PRIORITY_LIMIT } from 'bullmq'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { MAX_JOB_PRIORITY } from '../constants/default-options'
import { validateOptions } from './validate-options'

/** Options that pass every other check, with `defaultJobOptions` as given. */
function optionsWith(defaultJobOptions: unknown): BymaxQueueModuleOptions {
  return {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions,
  } as BymaxQueueModuleOptions
}

/** The reason validation refused `defaultJobOptions` with, or `undefined` when it accepted them. */
function refusal(defaultJobOptions: unknown): string | undefined {
  try {
    validateOptions(optionsWith(defaultJobOptions))
  } catch (err) {
    const { error } = (err as QueueException).getResponse() as {
      error: { code: string; details: { reason: string } }
    }
    expect(error.code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
    return error.details.reason
  }
  return undefined
}

/** The values no whole-number option may take, and the ones every such option takes. */
const NOT_WHOLE: [string, unknown][] = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['-1', -1],
  ['1.5', 1.5],
  ["'3'", '3'],
  ['null', null],
  ['1e300', 1e300],
  ['2 ** 53', 2 ** 53],
  ['Number.MAX_VALUE', Number.MAX_VALUE],
]
const WHOLE = [0, 1, 3, 1_000_000]

/** Each option that must be a whole number >= 0, as the path it is named by and how to set it. */
const WHOLE_NUMBER_OPTIONS: [string, (value: unknown) => unknown][] = [
  ['defaultJobOptions.attempts', (value) => ({ attempts: value })],
  ['defaultJobOptions.delay', (value) => ({ delay: value })],
  ['defaultJobOptions.priority', (value) => ({ priority: value })],
  ['defaultJobOptions.backoff', (value) => ({ backoff: value })],
  ['defaultJobOptions.backoff.delay', (value) => ({ backoff: { type: 'fixed', delay: value } })],
  ['defaultJobOptions.removeOnComplete', (value) => ({ removeOnComplete: value })],
  ['defaultJobOptions.removeOnComplete.age', (value) => ({ removeOnComplete: { age: value } })],
  ['defaultJobOptions.removeOnComplete.count', (value) => ({ removeOnComplete: { count: value } })],
  ['defaultJobOptions.removeOnFail', (value) => ({ removeOnFail: value })],
  ['defaultJobOptions.removeOnFail.age', (value) => ({ removeOnFail: { age: value } })],
  ['defaultJobOptions.removeOnFail.count', (value) => ({ removeOnFail: { count: value } })],
]

describe('validateOptions — defaultJobOptions', () => {
  describe.each(WHOLE_NUMBER_OPTIONS)('%s', (path, build) => {
    it.each(NOT_WHOLE)('refuses %s and names the option, not the value', (_label, value) => {
      const reason = refusal(build(value))

      expect(reason).toContain(path)
      expect(reason).not.toContain(String(value))
    })

    it.each(WHOLE)('accepts %s', (value) => {
      expect(refusal(build(value))).toBeUndefined()
    })
  })

  it('accepts the largest whole number a double holds exactly where there is no other ceiling', () => {
    const largest = Number.MAX_SAFE_INTEGER
    for (const [path, build] of WHOLE_NUMBER_OPTIONS) {
      if (path !== 'defaultJobOptions.priority')
        expect({ path, r: refusal(build(largest)) }).toEqual({ path, r: undefined })
    }
  })

  it('takes a priority up to the ceiling BullMQ enforces, and refuses one over it', () => {
    expect(MAX_JOB_PRIORITY).toBe(PRIORITY_LIMIT)
    expect(refusal({ priority: MAX_JOB_PRIORITY })).toBeUndefined()
    expect(refusal({ priority: MAX_JOB_PRIORITY + 1 })).toContain('defaultJobOptions.priority')
    expect(refusal({ priority: Number.MAX_SAFE_INTEGER })).toContain('defaultJobOptions.priority')
  })

  it.each([true, false])('accepts %s for removeOnComplete and removeOnFail', (value) => {
    expect(refusal({ removeOnComplete: value, removeOnFail: value })).toBeUndefined()
  })

  it.each([0, 0.5, 1])('accepts a backoff jitter of %s', (jitter) => {
    expect(refusal({ backoff: { type: 'exponential', delay: 1000, jitter } })).toBeUndefined()
  })

  it.each([NaN, Infinity, -0.1, 1.1, 2, '0.5', null])(
    'refuses a backoff jitter of %j',
    (jitter) => {
      const reason = refusal({ backoff: { type: 'exponential', delay: 1000, jitter } })

      expect(reason).toContain('defaultJobOptions.backoff.jitter')
    },
  )

  it('accepts options that set none of them, and the library defaults', () => {
    expect(refusal(undefined)).toBeUndefined()
    expect(refusal({})).toBeUndefined()
    expect(
      refusal({
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000, jitter: 0.5 },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 604_800, count: 5000 },
      }),
    ).toBeUndefined()
  })

  it('leaves the options it does not know to BullMQ', () => {
    expect(refusal({ lifo: true, jobId: 'x', repeat: { every: 1000 } })).toBeUndefined()
  })
})
