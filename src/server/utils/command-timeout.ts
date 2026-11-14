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
    HttpStatus.SERVICE_UNAVAILABLE,
    { operation, timeoutMs },
  )
  if (cause !== undefined) exception.cause = cause
  return exception
}

/**
 * Build the `CONNECTION_TIMEOUT` error a call reports when the connection is down and the owned
 * connection's disabled offline queue refused it at once: no timer ran, so there is no deadline,
 * only the operation and `reason: 'offline'`. A host retries on this code exactly as on a timeout.
 *
 * @param operation - The public call that was refused.
 * @param cause - The error ioredis rejected with, kept for diagnosis.
 */
export function unavailableException(operation: string, cause: unknown): QueueException {
  const exception = new QueueException(
    QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
    HttpStatus.SERVICE_UNAVAILABLE,
    { operation, reason: 'offline' },
  )
  exception.cause = cause
  return exception
}

/**
 * Whether `err` is the rejection ioredis gives a call made while its connection is down and its
 * offline queue is disabled (`Redis.sendCommand` in built/Redis.js). Like the command timeout it is
 * a plain `Error` with no code or class, so the exact message is the only thing to match; a spec
 * triggers the real rejection and pins that text.
 *
 * @param err - The rejection of a Redis call.
 */
export function isOfflineRejection(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === "Stream isn't writeable and enableOfflineQueue options is false"
  )
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
 * Await `work`, reporting an ioredis command timeout, or a call refused because the connection is
 * down, as the documented `CONNECTION_TIMEOUT` and leaving every other outcome untouched.
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
    if (isCommandTimeout(err)) throw timeoutException(operation, commandTimeoutMs(), err)
    throw isOfflineRejection(err) ? unavailableException(operation, err) : err
  }
}
