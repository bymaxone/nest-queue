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
