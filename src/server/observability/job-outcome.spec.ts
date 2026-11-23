/**
 * @fileoverview Unit tests for how an attempt that threw is classified: failed for good, to be
 * retried, or no failure of the work at all when the processor handed the job back to BullMQ.
 * @layer server/observability
 */

import {
  DelayedError,
  RATE_LIMIT_ERROR,
  RateLimitError,
  WaitingChildrenError,
  WaitingError,
} from 'bullmq'
import type { Job } from 'bullmq'
import { runInNewContext } from 'node:vm'
import { handBackOf } from '../../shared/hand-back'
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

  it('says failed for an unrecoverable error built in another realm, which BullMQ reads by name', () => {
    // `instanceof Error` is false for an error from a vm context or a second copy of the package.
    const foreign: unknown = runInNewContext(
      "const e = new Error('x'); e.name = 'UnrecoverableError'; e",
    )

    expect(foreign instanceof Error).toBe(false)
    expect(failureOutcome(jobWith(0, 5), foreign)).toBe('failed')
    expect(failureOutcome(jobWith(0, 5), { name: 'UnrecoverableError' })).toBe('failed')
  })

  it.each(['DelayedError', 'WaitingError', 'WaitingChildrenError'])(
    'reports nothing for an error named %s, which BullMQ reads as moving the job',
    (name) => {
      expect(failureOutcome(jobWith(0, 3), Object.assign(new Error('x'), { name }))).toBeUndefined()
    },
  )

  it.each([
    ['DelayedError', new DelayedError()],
    ['WaitingError', new WaitingError()],
    ['WaitingChildrenError', new WaitingChildrenError()],
    ['RateLimitError', new RateLimitError()],
  ])('reports nothing for the real %s of BullMQ', (_name, error) => {
    expect(failureOutcome(jobWith(0, 3), error)).toBeUndefined()
    expect(failureOutcome(jobWith(2, 3), error)).toBeUndefined()
  })

  it('reads a control-flow error the way BullMQ does: a rate limit by its message, the others by name', () => {
    // BullMQ's worker does not fail a job whose error carries the name, so neither does the count.
    expect(failureOutcome(jobWith(0, 3), new Error(RATE_LIMIT_ERROR))).toBeUndefined()
    expect(handBackOf(new Error(RATE_LIMIT_ERROR))).toBe('rate_limited')
    expect(handBackOf(Object.assign(new Error('x'), { name: 'WaitingChildrenError' }))).toBe(
      'waiting_children',
    )
    expect(handBackOf({ name: 'DelayedError' })).toBe('delayed')
  })

  it.each([
    ['a name that only contains one', Object.assign(new Error('x'), { name: 'MyDelayedError' })],
    ['a message that only mentions one', new Error('DelayedError')],
    ['a string', 'DelayedError'],
    [
      'a name that is a key every object inherits',
      Object.assign(new Error('x'), { name: 'toString' }),
    ],
    ['a name that is not a string', { name: 5 }],
    ['a name that only prints as one', { name: ['DelayedError'] }],
    ['a name that is the constructor', Object.assign(new Error('x'), { name: 'constructor' })],
    ['an object with no name', {}],
  ])('counts %s as a failure of the work', (_label, error) => {
    expect(handBackOf(error)).toBeUndefined()
    expect(failureOutcome(jobWith(2, 3), error)).toBe('failed')
  })

  it('classifies a thrown string by the attempts', () => {
    // `null` and `undefined` are not here: BullMQ cannot read them, see "an error BullMQ cannot read".
    expect(failureOutcome(jobWith(0, 2), 'text')).toBe('retried')
    expect(failureOutcome(jobWith(1, 2), 'text')).toBe('failed')
  })
})

describe('handBackOf — pinned to BullMQ', () => {
  it('matches what BullMQ itself throws and reads, so a rename there fails here', () => {
    expect(RATE_LIMIT_ERROR).toBe('bullmq:rateLimitExceeded')
    expect(handBackOf(new DelayedError())).toBe('delayed')
    expect(handBackOf(new WaitingChildrenError())).toBe('waiting_children')
    expect(handBackOf(new WaitingError())).toBe('waiting')
    expect(handBackOf(new RateLimitError())).toBe('rate_limited')
  })
})

describe('failureOutcome — an error whose members throw when read', () => {
  const hostile = (member: 'name' | 'message'): Error =>
    Object.defineProperty(new Error('x'), member, {
      get: () => {
        throw new Error('getter failed')
      },
    })

  it.each(['name', 'message'] as const)(
    'reads an error whose %s getter throws as no hand-back and no outcome, and never throws',
    (member) => {
      const error = hostile(member)

      // BullMQ reads both members of the error unguarded, so such an error leaves the job active (measured):
      // neither `failed` nor `retried` is true of the attempt.
      expect(handBackOf(error)).toBeUndefined()
      expect(failureOutcome(jobWith(2, 3), error)).toBeUndefined()
      expect(failureOutcome(jobWith(0, 3), error)).toBeUndefined()
    },
  )
})

describe('handBackOf — a member that throws does not hide the other', () => {
  const throwing = (member: 'name' | 'message', rest: object): Error =>
    Object.defineProperty(Object.assign(new Error('x'), rest), member, {
      get: () => {
        throw new Error('getter failed')
      },
    })

  it('reads the rate-limit message when the name throws, as BullMQ does', () => {
    const error = throwing('name', { message: RATE_LIMIT_ERROR })

    expect(handBackOf(error)).toBe('rate_limited')
    expect(failureOutcome(jobWith(0, 3), error)).toBeUndefined()
  })

  it('reads a hand-back name when the message throws', () => {
    expect(handBackOf(throwing('message', { name: 'DelayedError' }))).toBe('delayed')
  })

  it('does not take an Error whose prototype chain throws on instanceof for an unrecoverable one', () => {
    const hostile = new Proxy(new Error('x'), {
      getPrototypeOf: () => {
        throw new Error('trap failed')
      },
    })

    // BullMQ runs `instanceof` on the error before it moves the job, so this one leaves the job
    // active and unclassified, measured against a real Redis: nothing is retried and nothing fails.
    expect(failureOutcome(jobWith(0, 3), hostile)).toBeUndefined()
  })
})

describe('failureOutcome — an error BullMQ cannot read', () => {
  // Measured against a real Redis with attempts: 3. For each of these BullMQ throws inside its own
  // failure handling, emits `error` twice, leaves the job active with `attemptsMade` 0 and schedules
  // no retry, so neither `retried` nor `failed` is true of the attempt; a plain error is retried
  // twice and fails on the third, and a thrown string does the same.
  const unreadable: [string, () => unknown][] = [
    ['null', () => null],
    ['undefined', () => undefined],
    [
      'an error whose message getter throws',
      () =>
        Object.defineProperty(new Error('x'), 'message', {
          get: () => {
            throw new Error('getter')
          },
        }),
    ],
    [
      'an error whose name getter throws',
      () =>
        Object.defineProperty(new Error('x'), 'name', {
          get: () => {
            throw new Error('getter')
          },
        }),
    ],
    [
      'an error whose prototype lookup throws',
      () =>
        new Proxy(new Error('x'), {
          getPrototypeOf: () => {
            throw new Error('trap')
          },
        }),
    ],
  ]

  it.each(unreadable)('reports no outcome for %s while attempts remain', (_label, make) => {
    expect(failureOutcome(jobWith(0, 3), make())).toBeUndefined()
  })

  it.each(unreadable)('reports no outcome for %s on the last attempt', (_label, make) => {
    expect(failureOutcome(jobWith(2, 3), make())).toBeUndefined()
  })

  it('still says retried for a thrown string, which BullMQ retries', () => {
    expect(failureOutcome(jobWith(0, 3), 'plain string')).toBe('retried')
  })
})
