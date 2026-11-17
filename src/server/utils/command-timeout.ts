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
 * @param reason - `offline` for a call refused while the connection is down; `unavailable` for a
 *   startup that ended because Redis could not be reached.
 */
export function unavailableException(
  operation: string,
  cause: unknown,
  reason: 'offline' | 'unavailable' = 'offline',
): QueueException {
  const exception = new QueueException(
    QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
    HttpStatus.SERVICE_UNAVAILABLE,
    { operation, reason },
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

/** What Redis answers a write it refuses because used memory is above `maxmemory` under `noeviction`. */
const OOM_REPLY_PREFIX = 'OOM command not allowed'

/**
 * Whether `err` is Redis refusing a write for lack of memory: a reply that begins with the
 * documented text, or a transaction abort (`EXECABORT`) that carries such a reply among its
 * `previousErrors`. An abort for any other reason, and any other text that merely mentions memory,
 * is not. A spec triggers the real reply against a Redis at its limit and pins the text.
 *
 * @param err - The rejection of a Redis call.
 */
export function isOutOfMemory(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.startsWith(OOM_REPLY_PREFIX)) return true
  const previous = (err as { previousErrors?: unknown }).previousErrors
  return (
    err.message.startsWith('EXECABORT') && Array.isArray(previous) && previous.some(isOutOfMemory)
  )
}

/**
 * What is kept of the error Redis answered with: its name and message, and nothing else. An ioredis
 * reply error carries the command that failed, whose arguments hold the job's data, so keeping the
 * error itself would let `JSON.stringify` or a logger print a payload.
 *
 * @param reply - The error Redis answered with.
 */
function replySummary(reply: unknown): Error {
  const { name, message } = reply as Error
  const summary = new Error(message)
  summary.name = name
  return summary
}

/**
 * Build the `STORAGE_FULL` error a write reports when Redis has no memory left for it. The request
 * is valid and a retry can succeed once memory is freed, so it is a 503; the details carry the
 * operation and the reason only, never Redis's text, which names the server's setting and script.
 *
 * @param operation - The public call that was refused.
 * @param cause - The Redis reply, kept for diagnosis.
 */
export function storageFullException(operation: string, cause: unknown): QueueException {
  const exception = new QueueException(
    QUEUE_ERROR_CODES.STORAGE_FULL,
    HttpStatus.SERVICE_UNAVAILABLE,
    { operation, reason: 'out_of_memory' },
  )
  exception.cause = replySummary(cause)
  return exception
}

/**
 * Await `work`, reporting an ioredis command timeout, or a call refused because the connection is
 * down, as the documented `CONNECTION_TIMEOUT`, a write Redis refused for lack of memory as
 * `STORAGE_FULL`, and leaving every other outcome untouched.
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
    if (isOutOfMemory(err)) throw storageFullException(operation, err)
    throw isOfflineRejection(err) ? unavailableException(operation, err) : err
  }
}
