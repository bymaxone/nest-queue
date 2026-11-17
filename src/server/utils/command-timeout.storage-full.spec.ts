/**
 * @fileoverview Unit tests for how a Redis out-of-memory reply is classified: only the exact reply
 * Redis gives a write it refuses under `maxmemory` with `noeviction` becomes `STORAGE_FULL`, and
 * nothing else that merely mentions memory, including a transaction abort that does not carry it.
 * @layer server/utils
 */

import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { isOutOfMemory, withCommandTimeoutCode } from './command-timeout'

/** The reply Redis 7 gives a script that writes while used memory is above `maxmemory`. */
const OOM_TEXT =
  "OOM command not allowed when used memory > 'maxmemory'. script: d961aae0df158b3c2887dd8eb7c285294be16d24, on @user_script:478."

/** An error with the name ioredis gives a Redis error reply. */
function replyError(message: string, extra: object = {}): Error {
  return Object.assign(new Error(message), { name: 'ReplyError' }, extra)
}

/** What a call rejects with, as an exception. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await withCommandTimeoutCode('enqueue', () => 5000, work)
  } catch (err) {
    return err
  }
  throw new Error('the call did not reject')
}

describe('isOutOfMemory', () => {
  it('recognizes the reply a refused write gets, with or without the script suffix', () => {
    expect(isOutOfMemory(replyError(OOM_TEXT))).toBe(true)
    expect(
      isOutOfMemory(replyError("OOM command not allowed when used memory > 'maxmemory'.")),
    ).toBe(true)
  })

  it('recognizes a transaction abort only when the reply it carries is the out-of-memory one', () => {
    const oom = replyError(OOM_TEXT)
    const abort = (previousErrors: unknown): Error =>
      replyError('EXECABORT Transaction discarded because of previous errors.', { previousErrors })

    expect(isOutOfMemory(abort([oom]))).toBe(true)
    expect(isOutOfMemory(abort([replyError('ERR syntax error')]))).toBe(false)
    // One OOM reply among others is enough, and the abort text has to be the abort's.
    expect(isOutOfMemory(abort([replyError('ERR syntax error'), oom]))).toBe(true)
    expect(isOutOfMemory(replyError('ERR something else', { previousErrors: [oom] }))).toBe(false)
    expect(isOutOfMemory(abort(undefined))).toBe(false)
    expect(isOutOfMemory(abort('OOM command not allowed'))).toBe(false)
  })

  it.each([
    'Out of memory',
    "ERR OOM command not allowed when used memory > 'maxmemory'",
    'oom command not allowed when used memory',
    'Command timed out',
    'MISCONF Redis is configured to save RDB snapshots',
  ])('leaves %j alone', (message) => {
    expect(isOutOfMemory(replyError(message))).toBe(false)
  })

  it.each([undefined, null, OOM_TEXT, { message: OOM_TEXT }, 42])(
    'leaves the non-error %j alone',
    (value) => {
      expect(isOutOfMemory(value)).toBe(false)
    },
  )
})

describe('withCommandTimeoutCode — out of memory', () => {
  it('reports it as STORAGE_FULL (503) with only the operation and the reason, keeping the cause', async () => {
    const cause = replyError(OOM_TEXT)

    const err = (await rejection(Promise.reject(cause))) as QueueException

    expect(err).toBeInstanceOf(QueueException)
    expect(err.getStatus()).toBe(503)
    expect(err.getResponse()).toEqual({
      error: {
        code: QUEUE_ERROR_CODES.STORAGE_FULL,
        message: expect.any(String) as unknown,
        details: { operation: 'enqueue', reason: 'out_of_memory' },
      },
    })
    expect(JSON.stringify(err.getResponse())).not.toMatch(/maxmemory|script|user_script/)
    expect(err.cause).toBe(cause)
  })

  it('does not report a transaction abort that carries another reply', async () => {
    const abort = replyError('EXECABORT Transaction discarded because of previous errors.', {
      previousErrors: [replyError('ERR syntax error')],
    })

    await expect(rejection(Promise.reject(abort))).resolves.toBe(abort)
  })
})
