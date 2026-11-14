/**
 * @fileoverview Turns ioredis's command-timeout rejection into the library's documented timeout
 * error.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Build the `CONNECTION_TIMEOUT` error a producer or inspection call reports when Redis does not
 * answer in time, carrying the operation and the deadline that passed.
 *
 * @param operation - The public call that timed out.
 * @param timeoutMs - The deadline that passed, in milliseconds.
 * @param cause - The error that ended the wait, kept for diagnosis.
 */
export function timeoutException(
  operation: string,
  timeoutMs: number,
  cause?: unknown,
): QueueException {
  const exception = new QueueException(
    QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
    HttpStatus.INTERNAL_SERVER_ERROR,
    { operation, timeoutMs },
  )
  if (cause !== undefined) exception.cause = cause
  return exception
}

/**
 * Whether `err` is the rejection ioredis gives a command that got no reply within its
 * `commandTimeout`. ioredis (6.0.0, `Command.setTimeout` in built/Command.js) rejects with a plain
 * `Error` whose message is exactly `Command timed out`, with no code or class, so the message is the
 * only thing to match; any other error is left alone. A spec triggers a real command timeout and
 * pins that text, so an ioredis release that rewords it fails there.
 *
 * @param err - The rejection of a Redis call.
 */
export function isCommandTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'Command timed out'
}

/**
 * Await `work`, reporting an ioredis command timeout as the documented `CONNECTION_TIMEOUT` and
 * leaving every other outcome untouched.
 *
 * @param operation - The public call being made.
 * @param commandTimeoutMs - Reads the command deadline in force on the connection, in milliseconds;
 *   called only when a command timed out.
 * @param work - The pending Redis call.
 */
export async function withCommandTimeoutCode<T>(
  operation: string,
  commandTimeoutMs: () => number,
  work: Promise<T>,
): Promise<T> {
  try {
    return await work
  } catch (err) {
    throw isCommandTimeout(err) ? timeoutException(operation, commandTimeoutMs(), err) : err
  }
}
