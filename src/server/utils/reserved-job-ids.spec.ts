/**
 * @fileoverview Unit tests for the set of job ids BullMQ's own keys already use. The set is read from
 * `QueueKeys`, so the first block compares it with the key map of the installed BullMQ and a
 * BullMQ upgrade that adds a key fails here instead of corrupting a queue.
 * @layer server/utils
 */

import { QueueKeys } from 'bullmq'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { RESERVED_JOB_IDS, assertJobIdAllowed, isReservedJobId } from './reserved-job-ids'

/** What each key of a queue is called after the `<prefix>:<queue>:` stem, read from BullMQ directly. */
function suffixesOf(prefix: string, queueName: string): string[] {
  const stem = `${prefix}:${queueName}:`
  return Object.values(new QueueKeys(prefix).getKeys(queueName))
    .filter((key) => key.startsWith(stem) && key.length > stem.length)
    .map((key) => key.slice(stem.length))
}

describe('RESERVED_JOB_IDS', () => {
  it('holds every key suffix of the installed BullMQ, whatever the prefix and queue name', () => {
    // A different prefix and queue name than any default, so a hard-coded stem would not match.
    expect([...RESERVED_JOB_IDS].sort()).toEqual(suffixesOf('other-prefix', 'my:queue').sort())
  })

  it('is not empty, so an empty derivation cannot pass the comparison above', () => {
    expect(RESERVED_JOB_IDS.size).toBeGreaterThanOrEqual(15)
    expect(RESERVED_JOB_IDS.has('active')).toBe(true)
    expect(RESERVED_JOB_IDS.has('id')).toBe(true)
  })
})

describe('isReservedJobId', () => {
  it.each([...suffixesOf('bull', 'q')])('reports %s as reserved', (id) => {
    expect(isReservedJobId(id)).toBe(true)
  })

  it('lets an absent id through', () => {
    expect(isReservedJobId(undefined)).toBe(false)
  })

  it.each(['job-1', 'dlq-x', 'ACTIVE', 'active ', 'metrics', 'idx', ''])(
    'lets %j through',
    (id) => {
      expect(isReservedJobId(id)).toBe(false)
    },
  )
})

describe('assertJobIdAllowed', () => {
  it.each([...suffixesOf('bull', 'q')])('refuses %s with a 400 that names only the field', (id) => {
    let thrown: unknown
    try {
      assertJobIdAllowed(id)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(QueueException)
    const exception = thrown as QueueException
    expect(exception.getStatus()).toBe(400)
    expect(exception.getResponse()).toEqual({
      error: {
        code: QUEUE_ERROR_CODES.INVALID_JOB_ID,
        message: expect.any(String) as unknown,
        details: { field: 'jobId' },
      },
    })
    expect(JSON.stringify(exception.getResponse())).not.toContain(`"${id}"`)
  })

  it.each([undefined, 'job-1', 'dlq-x'])('accepts %j', (id) => {
    expect(() => {
      assertJobIdAllowed(id)
    }).not.toThrow()
  })
})
