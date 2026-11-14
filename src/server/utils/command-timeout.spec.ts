/**
 * @fileoverview Unit tests for the ioredis command-timeout translation.
 * @layer server/utils
 */

import { createServer } from 'node:net'
import { Redis } from 'ioredis'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { isCommandTimeout, timeoutException, withCommandTimeoutCode } from './command-timeout'

/** The code, status and details of a QueueException. */
function describeException(err: unknown): { code: string; details: unknown; status: number } {
  const exception = err as QueueException
  const { error } = exception.getResponse() as { error: { code: string; details: unknown } }
  return { code: error.code, details: error.details, status: exception.getStatus() }
}

describe('isCommandTimeout', () => {
  it('recognises the rejection ioredis gives a command that got no reply', () => {
    expect(isCommandTimeout(new Error('Command timed out'))).toBe(true)
  })

  it.each([
    ['another message', new Error('Connection is closed.')],
    ['the message with more text', new Error('Command timed out while idle')],
    ['the message in another case', new Error('command timed out')],
    ['a string with the message', 'Command timed out'],
    ['an object with the message', { message: 'Command timed out' }],
    ['null', null],
    ['undefined', undefined],
  ])('leaves %s alone', (_label, err) => {
    expect(isCommandTimeout(err)).toBe(false)
  })
})

describe('the installed ioredis', () => {
  // The match is on the message, so a release that rewords it must fail here and not silently
  // stop the translation.
  it('rejects a command that gets no reply with exactly the text this library matches', async () => {
    const server = createServer((socket) => socket.on('error', () => undefined))
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    const client = new Redis({
      host: '127.0.0.1',
      port,
      commandTimeout: 100,
      enableReadyCheck: false,
      protocol: 2,
      disableClientInfo: true,
      retryStrategy: () => null,
    })

    const err = await client.get('key').catch((e: unknown) => e)

    expect((err as Error).message).toBe('Command timed out')
    expect(isCommandTimeout(err)).toBe(true)
    client.disconnect()
    server.close()
  })
})

describe('timeoutException', () => {
  it('is a CONNECTION_TIMEOUT naming the operation and the deadline', () => {
    expect(describeException(timeoutException('enqueue', 5000))).toStrictEqual({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation: 'enqueue', timeoutMs: 5000 },
      status: 500,
    })
  })

  it('keeps the original error as its cause, and has none when none is given', () => {
    const cause = new Error('Command timed out')

    expect(timeoutException('getJob', 1, cause).cause).toBe(cause)
    // No cause given means no `cause` property at all, not one holding `undefined`.
    expect('cause' in timeoutException('getJob', 1)).toBe(false)
  })
})

describe('withCommandTimeoutCode', () => {
  it('returns the value of a call that succeeds, without reading the deadline', async () => {
    const deadline = jest.fn().mockReturnValue(5000)

    await expect(withCommandTimeoutCode('getJob', deadline, Promise.resolve('job'))).resolves.toBe(
      'job',
    )
    expect(deadline).not.toHaveBeenCalled()
  })

  it('reports a command timeout as CONNECTION_TIMEOUT with the cause kept', async () => {
    const cause = new Error('Command timed out')

    const err = await withCommandTimeoutCode('getJob', () => 5000, Promise.reject(cause)).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(QueueException)
    expect(describeException(err)).toStrictEqual({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { operation: 'getJob', timeoutMs: 5000 },
      status: 500,
    })
    expect((err as QueueException).cause).toBe(cause)
  })

  it('rethrows any other failure as it is', async () => {
    const failure = new Error('WRONGTYPE Operation against a key')

    await expect(
      withCommandTimeoutCode('getJob', () => 5000, Promise.reject(failure)),
    ).rejects.toBe(failure)
  })
})
