/**
 * @fileoverview Unit tests for how a failed attempt is counted, from the move BullMQ makes after the
 * processor threw, and for the reader that says whether a rejection hands the job back to BullMQ.
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
import { handBackOf } from '../../shared/hand-back'
import { optionsOf, reportFailedMove } from './job-outcome'
import type { JobOutcome } from './queue-observer'

/** BullMQ's own test for an error after which it makes the move again. */
const { isNotConnectionError } = jest.requireActual<{
  isNotConnectionError: (error: Error) => boolean
}>('../../../node_modules/bullmq/dist/cjs/utils')

/** What the move of one job did, call by call, and what was reported of it. */
function hooked(move: (this: Job, ...args: unknown[]) => Promise<unknown>): {
  job: Job
  reported: JobOutcome[]
  run: () => Promise<unknown>
} {
  const job = { moveToFailed: move } as unknown as Job
  const reported: JobOutcome[] = []
  reportFailedMove(job, (outcome) => reported.push(outcome))
  return { job, reported, run: () => job.moveToFailed(new Error('boom'), 'token', true) }
}

/** A move that leaves the job unfinished, as one to a delayed or waiting state does. */
const requeue = (): Promise<unknown> => Promise.resolve(undefined)

/** A move that finishes the job, as one to the failed set does. */
function finish(this: Job): Promise<unknown> {
  this.finishedOn = 1
  return Promise.resolve(undefined)
}

describe('reportFailedMove', () => {
  it('reports nothing until the job is moved', () => {
    expect(hooked(requeue).reported).toEqual([])
  })

  it('reports retried for a move that leaves the job unfinished', async () => {
    const { run, reported } = hooked(requeue)

    await run()

    expect(reported).toEqual(['retried'])
  })

  it('reports failed for a move that finishes the job', async () => {
    const { run, reported } = hooked(finish)

    await run()

    expect(reported).toEqual(['failed'])
  })

  it('runs the move on the job, with the arguments given, and answers what it answers', async () => {
    const next = ['data', 'id', 0, 0]
    const calls: unknown[] = []
    const { job } = hooked(function (this: Job, ...args) {
      calls.push([this, ...args])
      return Promise.resolve(next)
    })
    const error = new Error('boom')

    await expect(job.moveToFailed(error, 'token', true)).resolves.toBe(next)

    expect(calls).toEqual([[job, error, 'token', true]])
  })

  it('reports failed when BullMQ gives up on the move, and rethrows its error', async () => {
    const lost = new Error('Missing lock for job 1. moveToFailed')
    const { run, reported } = hooked(() => Promise.reject(lost))

    await expect(run()).rejects.toBe(lost)

    expect(reported).toEqual(['failed'])
  })

  it('hands back the promise of the move itself, so BullMQ waits for the move and nothing else', () => {
    const moving = Promise.resolve(undefined)
    const { run } = hooked(() => moving)

    expect(run()).toBe(moving)
  })

  it('gives the move the intrinsic constructor, so no await of it reads the prototype', () => {
    const moving = Promise.resolve(undefined)
    const { run } = hooked(() => moving)
    void run()

    expect(Object.getOwnPropertyDescriptor(moving, 'constructor')?.value).toBe(Promise)
  })

  it('leaves no rejection unheard when the report throws', async () => {
    const job = { moveToFailed: requeue } as unknown as Job
    reportFailedMove(job, () => {
      throw new Error('the report failed')
    })

    await expect(job.moveToFailed(new Error('boom'), 'token')).resolves.toBeUndefined()
    await new Promise((resolve) => setImmediate(resolve))
  })

  it.each([
    ['the message of a closed connection', new Error('Connection is closed.')],
    [
      'the name of a closed connection',
      Object.assign(new Error('x'), { name: 'ConnectionClosedError' }),
    ],
    ['a refused connection in the message', new Error('connect ECONNREFUSED 127.0.0.1:6379')],
    ['a refused connection in the code', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })],
  ])('waits for the next move after %s, which BullMQ retries', async (_label, lost) => {
    let calls = 0
    const { run, reported } = hooked(() => {
      calls += 1
      return calls === 1 ? Promise.reject(lost) : Promise.resolve(undefined)
    })

    await expect(run()).rejects.toBe(lost)
    expect(reported).toEqual([])
    await run()

    expect(reported).toEqual(['retried'])
  })

  it.each([
    new Error('Connection is closed.'),
    new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
  ])('reads %s as BullMQ does', (error) => {
    expect(isNotConnectionError(error)).toBe(false)
  })

  it('reports one outcome for a job moved twice', async () => {
    const { run, reported } = hooked(requeue)

    await run()
    await run()

    expect(reported).toEqual(['retried'])
  })
})

describe('optionsOf', () => {
  it('reads the options of a job, absent on one built by hand', () => {
    const opts = { attempts: 2 }

    expect(optionsOf({ opts } as unknown as Job)).toBe(opts)
    expect(optionsOf({} as Job)).toBeUndefined()
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
  })

  it('reads a hand-back name when the message throws', () => {
    expect(handBackOf(throwing('message', { name: 'DelayedError' }))).toBe('delayed')
  })
})

describe('handBackOf — how it reads a rejection', () => {
  it('reads a rate limit by its message and the others by name, as BullMQ does', () => {
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
    ['null', null],
    ['undefined', undefined],
  ])('reads %s as a failure of the work', (_label, error) => {
    expect(handBackOf(error)).toBeUndefined()
  })

  it.each(['name', 'message'] as const)(
    'reads an error whose %s getter throws as a failure',
    (member) => {
      const error = Object.defineProperty(new Error('x'), member, {
        get: () => {
          throw new Error('getter failed')
        },
      })

      expect(handBackOf(error)).toBeUndefined()
    },
  )
})
