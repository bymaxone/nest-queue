/**
 * @fileoverview The one place a read of a host's object is allowed to throw. A host hands the
 * library getters, Proxies and class instances, and any read of one can run the host's code, so a
 * read that fails ends in the library's own refusal, `INVALID_OPTIONS`, with the host's error kept
 * as the cause, and never as the raw error of code the library did not write.
 * @layer server/config
 */

import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'

/** A refusal of a module option. */
export function invalidOptions(what: string): QueueException {
  return new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.INTERNAL_SERVER_ERROR, {
    reason: `${what} could not be read`,
  })
}

/** A refusal of a schedule or the template of a scheduler. */
export function invalidRepeat(what: string): QueueException {
  return new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, HttpStatus.BAD_REQUEST, {
    reason: `${what} could not be read`,
  })
}

/** A refusal of a list of jobs for a bulk enqueue. */
export function bulkUnreadable(what: string): QueueException {
  return new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, HttpStatus.BAD_REQUEST, {
    reason: `${what} could not be read`,
  })
}

/**
 * Run `read`, which touches a host's object, and turn what it throws into the library's refusal.
 *
 * @param what - The option or object being read, named in the refusal (never a value).
 * @param read - The read.
 * @param refuse - Builds the refusal for `what`; a refused module option by default.
 * @returns What `read` returns.
 * @throws {QueueException} The refusal, with the host's error as `cause`, when `read` throws.
 */
export function guarded<T>(
  what: string,
  read: () => T,
  refuse: (what: string) => QueueException = invalidOptions,
): T {
  try {
    return read()
  } catch (cause) {
    const refusal = refuse(what)
    Object.defineProperty(refusal, 'cause', { value: cause, configurable: true, writable: true })
    throw refusal
  }
}
