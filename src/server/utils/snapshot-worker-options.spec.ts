/**
 * @fileoverview Unit tests for the copy of a worker's options: what the refusal names, and that the
 * limiter is copied by its own fields even when they are getters of a class.
 * @layer server/utils
 */

import type { QueueException } from '../errors/queue-exception'
import { snapshotWorkerOptions } from './snapshot-worker-options'

describe('snapshotWorkerOptions', () => {
  it('names the worker options when a read throws, and keeps the host error as the cause', () => {
    const boom = new Error('host')
    const options = Object.defineProperty({}, 'concurrency', {
      enumerable: true,
      get: () => {
        throw boom
      },
    })
    let thrown: QueueException | undefined
    try {
      snapshotWorkerOptions(options)
    } catch (error) {
      thrown = error as QueueException
    }

    const body = thrown!.getResponse() as {
      error: { code: string; details: { reason: string } }
    }
    expect(body.error.code).toBe('queue.worker_registration_failed')
    expect(body.error.details.reason).toBe('the worker options could not be read')
    expect(thrown!.cause).toBe(boom)
  })

  it('copies a limiter whose fields are getters of a class', () => {
    class Limiter {
      private readonly numbers = { max: 5, duration: 1000 }
      get max(): number {
        return this.numbers.max
      }
      get duration(): number {
        return this.numbers.duration
      }
    }

    const copy = snapshotWorkerOptions({ limiter: new Limiter() })

    expect(copy.limiter).toMatchObject({ max: 5, duration: 1000 })
  })

  it('returns undefined for options that were not given', () => {
    const given = undefined as undefined | { concurrency?: number }
    const copy = snapshotWorkerOptions(given)

    expect(copy).toBeUndefined()
  })
})
