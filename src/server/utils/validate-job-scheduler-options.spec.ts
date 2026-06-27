/**
 * @fileoverview Unit tests for the Job Scheduler structural validator.
 * @layer server/utils
 */

import { validateJobSchedulerOptions } from './validate-job-scheduler-options'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'

const HOUR_MS = 3_600_000

/** Run the validator inside a block body so the expectation receives a void thunk. */
function run(repeat: JobSchedulerRepeatOptions): () => void {
  return (): void => {
    validateJobSchedulerOptions(repeat)
  }
}

/** Extract the error code carried by a QueueException response body. */
function codeOf(err: unknown): string {
  return ((err as QueueException).getResponse() as { error: { code: string } }).error.code
}

describe('validateJobSchedulerOptions — valid schedules', () => {
  it('accepts a 5-field cron pattern', () => {
    // The validator delegates cron syntax to BullMQ, so a well-formed 5-field pattern passes.
    expect(run({ pattern: '0 3 * * *' })).not.toThrow()
  })

  it('accepts a 6-field (seconds) cron pattern', () => {
    // A 6-field pattern must not be rejected (a naive regex would wrongly reject it).
    expect(run({ pattern: '*/30 * * * * *' })).not.toThrow()
  })

  it('accepts an interval schedule', () => {
    // A positive integer interval is valid.
    expect(run({ every: 5000 })).not.toThrow()
  })

  it('accepts a future endDate as epoch milliseconds', () => {
    // A future numeric endDate is valid.
    expect(run({ every: 5000, endDate: Date.now() + HOUR_MS })).not.toThrow()
  })

  it('accepts a future endDate as an ISO string', () => {
    // A future ISO endDate is parsed and accepted.
    const future = new Date(Date.now() + HOUR_MS).toISOString()
    expect(run({ pattern: '0 3 * * *', endDate: future })).not.toThrow()
  })
})

describe('validateJobSchedulerOptions — invalid schedules', () => {
  it('rejects when both pattern and every are present', () => {
    // The schedule must be exactly one kind.
    const repeat = { pattern: '0 3 * * *', every: 5000 } as unknown as JobSchedulerRepeatOptions
    expect(run(repeat)).toThrow(QueueException)
  })

  it('rejects when neither pattern nor every is present', () => {
    // An empty schedule is meaningless and carries the typed 400 error.
    const repeat = {} as unknown as JobSchedulerRepeatOptions
    try {
      validateJobSchedulerOptions(repeat)
      throw new Error('expected a throw')
    } catch (err) {
      expect(codeOf(err)).toBe(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS)
      expect((err as QueueException).getStatus()).toBe(400)
    }
  })

  it('rejects a zero interval', () => {
    // `every` must be strictly positive.
    expect(run({ every: 0 })).toThrow(QueueException)
  })

  it('rejects a negative interval', () => {
    // A negative interval is invalid.
    expect(run({ every: -1 })).toThrow(QueueException)
  })

  it('rejects a non-integer interval', () => {
    // Fractional milliseconds are not a valid cadence.
    expect(run({ every: 1.5 })).toThrow(QueueException)
  })

  it('rejects a past endDate', () => {
    // BullMQ rejects a past endDate; the lib rejects it earlier with a clear reason.
    expect(run({ every: 5000, endDate: Date.now() - HOUR_MS })).toThrow(QueueException)
  })

  it('rejects an unparseable endDate string', () => {
    // A malformed date string cannot be a valid future stop time.
    expect(run({ pattern: '0 3 * * *', endDate: 'not-a-date' })).toThrow(QueueException)
  })
})

/** Read the failing reason out of a thrown QueueException. */
function reasonOf(repeat: JobSchedulerRepeatOptions): string {
  try {
    validateJobSchedulerOptions(repeat)
  } catch (err) {
    return ((err as QueueException).getResponse() as { error: { details: { reason: string } } })
      .error.details.reason
  }
  throw new Error('expected a throw')
}

describe('validateJobSchedulerOptions — error reasons and boundaries', () => {
  it('explains a missing or ambiguous schedule', () => {
    // The reason names the exactly-one-of rule for both shapes.
    expect(reasonOf({} as unknown as JobSchedulerRepeatOptions)).toBe(
      'exactly one of pattern | every is required',
    )
    expect(reasonOf({ pattern: '0 3 * * *', every: 5000 })).toBe(
      'exactly one of pattern | every is required',
    )
  })

  it('explains an invalid interval', () => {
    // A non-positive / non-integer interval reports the positive-integer rule.
    expect(reasonOf({ every: 0 })).toBe('every must be a positive integer')
    expect(reasonOf({ every: 1.5 })).toBe('every must be a positive integer')
  })

  it('explains an invalid endDate', () => {
    // Both a past and an unparseable endDate report the future-date rule.
    expect(reasonOf({ every: 5000, endDate: Date.now() - HOUR_MS })).toBe(
      'endDate must be in the future',
    )
    expect(reasonOf({ pattern: '0 3 * * *', endDate: 'not-a-date' })).toBe(
      'endDate must be in the future',
    )
  })

  it('rejects an endDate exactly equal to now (must be strictly in the future)', () => {
    // The boundary is inclusive of "now" as invalid: endMs <= now must reject.
    const fixedNow = 1_900_000_000_000
    const spy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow)
    try {
      expect(reasonOf({ every: 5000, endDate: fixedNow })).toBe('endDate must be in the future')
    } finally {
      spy.mockRestore()
    }
  })

  it('accepts an endDate one millisecond in the future', () => {
    // Just past "now" is valid — proving the comparison is not off by one.
    const fixedNow = 1_900_000_000_000
    const spy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow)
    try {
      expect(run({ every: 5000, endDate: fixedNow + 1 })).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})
