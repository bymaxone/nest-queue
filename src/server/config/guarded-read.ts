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

/**
 * Run `read`, which touches a host's object, and turn what it throws into the library's refusal.
 *
 * @param what - The option or object being read, named in the refusal (never a value).
 * @param read - The read.
 * @returns What `read` returns.
 * @throws {QueueException} `INVALID_OPTIONS`, with the host's error as `cause`, when `read` throws.
 */
export function guarded<T>(what: string, read: () => T): T {
  try {
    return read()
  } catch (cause) {
    const refusal = new QueueException(
      QUEUE_ERROR_CODES.INVALID_OPTIONS,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        reason: `${what} could not be read`,
      },
    )
    Object.defineProperty(refusal, 'cause', { value: cause, configurable: true, writable: true })
    throw refusal
  }
}
