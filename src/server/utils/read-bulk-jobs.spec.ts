/**
 * @fileoverview Unit tests for the copy of a bulk list: what each refusal says, that an empty list is
 * a list, and that a job without options is copied without an `options` key.
 * @layer server/utils
 */

import type { QueueException } from '../errors/queue-exception'
import { readBulkJobs } from './read-bulk-jobs'

/** The reason of the refusal a read ended in. */
function reasonOf(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return ((error as QueueException).getResponse() as { error: { details: { reason: unknown } } })
      .error.details.reason
  }
  throw new Error('expected a refusal')
}

describe('readBulkJobs', () => {
  it('copies a list of jobs, with no options key for a job that has none', () => {
    const copy = readBulkJobs(
      [
        { name: 'a', data: 1 },
        { name: 'b', data: 2, options: { delay: 5 } },
      ],
      10,
    )

    expect(copy).toStrictEqual([
      { name: 'a', data: 1 },
      { name: 'b', data: 2, options: { delay: 5 } },
    ])
  })

  it('accepts an empty list', () => {
    expect(readBulkJobs([], 10)).toStrictEqual([])
  })

  it('names the list when its length cannot be read', () => {
    const list = new Proxy([], {
      get: (target, key, receiver) => {
        if (key === 'length') throw new Error('host')
        return Reflect.get(target, key, receiver) as unknown
      },
    })

    expect(reasonOf(() => readBulkJobs(list, 10))).toBe('jobs could not be read')
  })

  it.each([NaN, -1, 1.5])('says what is wrong with a length of %s', (length) => {
    expect(reasonOf(() => readBulkJobs({ length } as never, 10))).toBe(
      'jobs must have a whole number length',
    )
  })

  it('names the index and the type of an entry that is not an object', () => {
    expect(reasonOf(() => readBulkJobs([{ name: 'a', data: 1 }, null as never], 10))).toBe(
      'jobs[1] must be an object, received null',
    )
    expect(reasonOf(() => readBulkJobs(['x' as never], 10))).toBe(
      'jobs[0] must be an object, received a string',
    )
  })

  it('names the index of an entry whose getter throws', () => {
    const job = Object.defineProperty({ name: 'a' }, 'data', {
      get: () => {
        throw new Error('host')
      },
    })

    expect(reasonOf(() => readBulkJobs([{ name: 'ok', data: 1 }, job as never], 10))).toBe(
      'jobs[1] could not be read',
    )
  })

  it('names the index of an entry that cannot be fetched', () => {
    const list = new Proxy([{ name: 'a', data: 1 }], {
      get: (target, key, receiver) => {
        if (key === '0') throw new Error('host')
        return Reflect.get(target, key, receiver) as unknown
      },
    })

    expect(reasonOf(() => readBulkJobs(list, 10))).toBe('jobs[0] could not be read')
  })

  it('refuses a batch over the limit, with the limit and the count', () => {
    expect(
      reasonOf(() =>
        readBulkJobs(
          [
            { name: 'a', data: 1 },
            { name: 'b', data: 2 },
          ],
          1,
        ),
      ),
    ).toBe('batch size exceeds limit')
  })
})
