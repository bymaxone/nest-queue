/**
 * @fileoverview Unit tests for how an attempt that threw is classified: failed for good, to be
 * retried, or no failure of the work at all when the processor handed the job back to BullMQ.
 * @layer server/observability
 */

import type { Job } from 'bullmq'
import { failureOutcome } from './job-outcome'

/** The part of a job the classification reads. */
function jobWith(attemptsMade: number, attempts?: number): Job {
  return { attemptsMade, opts: attempts === undefined ? {} : { attempts } } as unknown as Job
}

describe('failureOutcome', () => {
  it('says retried while attempts remain, and failed on the last one', () => {
    expect(failureOutcome(jobWith(0, 3), new Error('x'))).toBe('retried')
    expect(failureOutcome(jobWith(1, 3), new Error('x'))).toBe('retried')
    expect(failureOutcome(jobWith(2, 3), new Error('x'))).toBe('failed')
  })

  it('counts a job with no attempts option as one attempt', () => {
    expect(failureOutcome(jobWith(0), new Error('x'))).toBe('failed')
  })

  it('says failed for an unrecoverable error whatever attempts remain', () => {
    const error = Object.assign(new Error('x'), { name: 'UnrecoverableError' })

    expect(failureOutcome(jobWith(0, 5), error)).toBe('failed')
  })

  it.each(['DelayedError', 'WaitingError', 'WaitingChildrenError', 'RateLimitError'])(
    'reports nothing for %s, which moves the job instead of failing it',
    (name) => {
      expect(failureOutcome(jobWith(0, 3), Object.assign(new Error('x'), { name }))).toBeUndefined()
    },
  )

  it('classifies something that is not an Error by the attempts', () => {
    expect(failureOutcome(jobWith(0, 2), 'text')).toBe('retried')
    expect(failureOutcome(jobWith(1, 2), undefined)).toBe('failed')
  })
})
