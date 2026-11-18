/**
 * @fileoverview Unit tests for how a Redis out-of-memory reply is classified: only the exact reply
 * Redis gives a write it refuses under `maxmemory` with `noeviction` becomes `STORAGE_FULL`, and
 * nothing else that merely mentions memory, including a transaction abort that does not carry it.
 * @layer server/utils
 */

import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import {
  errorSummary,
  isOutOfMemory,
  timeoutException,
  unavailableException,
  withCommandTimeoutCode,
} from './command-timeout'
import { runFlowBulk } from './add-flow-trees'

/** A value standing for the job data ioredis keeps in the arguments of the failed command. */
const SENTINEL = 'SENTINEL-job-payload-do-not-serialise'

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
    const cause = replyError(OOM_TEXT, { command: { name: 'evalsha', args: [SENTINEL] } })

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
    // Only the reply's name and message survive: ioredis hangs the command, with the job data in its
    // arguments, on the error, and a serialised exception must not carry it.
    expect(err.cause).toBeInstanceOf(Error)
    expect((err.cause as Error).name).toBe(cause.name)
    expect((err.cause as Error).message).toBe(cause.message)
    expect(JSON.stringify(err)).not.toContain(SENTINEL)
    expect(Object.keys(err.cause as object)).toEqual(['name'])
  })

  it('does not report a transaction abort that carries another reply', async () => {
    const abort = replyError('EXECABORT Transaction discarded because of previous errors.', {
      previousErrors: [replyError('ERR syntax error')],
    })

    await expect(rejection(Promise.reject(abort))).resolves.toBe(abort)
  })
})

describe('the cause of a library error never carries the command of a job', () => {
  /** A Redis reply error as ioredis builds it, with the failed command and the job data in its arguments. */
  function replyWithCommand(message: string): Error {
    return replyError(message, { command: { name: 'evalsha', args: [SENTINEL] } })
  }

  it.each([
    ["READONLY You can't write against a read only replica."],
    ['WRONGTYPE Operation against a key holding the wrong kind of value'],
  ])('keeps only the name and the message of %s', (message) => {
    const reply = replyWithCommand(message)

    const summary = errorSummary(reply) as Error

    expect(summary).not.toBe(reply)
    expect(summary).toBeInstanceOf(Error)
    expect(summary.name).toBe('ReplyError')
    expect(summary.message).toBe(message)
    expect(JSON.stringify(summary)).not.toContain(SENTINEL)
    expect(Object.keys(summary)).not.toContain('command')
  })

  it('keeps an error with no command as it is, and what is not an error as it is', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

    expect(errorSummary(refused)).toBe(refused)
    expect(errorSummary('text')).toBe('text')
    expect(errorSummary(undefined)).toBeUndefined()
  })

  it('applies to the cause of a timeout and of a connection that is down', () => {
    const reply = replyWithCommand('Command timed out')

    expect(JSON.stringify(timeoutException('enqueue', 100, reply).cause)).not.toContain(SENTINEL)
    expect(JSON.stringify(unavailableException('enqueue', reply).cause)).not.toContain(SENTINEL)
    expect((timeoutException('enqueue', 100, reply).cause as Error).message).toBe(
      'Command timed out',
    )
  })

  it('applies to a failed flow batch, whatever the first failure was', async () => {
    const reply = replyWithCommand(
      'WRONGTYPE Operation against a key holding the wrong kind of value',
    )
    const run = runFlowBulk(
      [{ name: 'a', queueName: 'q' }],
      () => Promise.reject(reply),
      'addFlowBulk',
      2,
    )

    const err = await run.done.then(
      () => undefined,
      (e: unknown) => e as QueueException,
    )

    expect(err?.cause).toBeDefined()
    expect(JSON.stringify(err?.cause)).not.toContain(SENTINEL)
  })
})
