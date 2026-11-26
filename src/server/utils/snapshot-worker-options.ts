/**
 * @fileoverview One read of the options a host hands to a worker registration. They are the host's:
 * a getter can answer differently the second time, the limiter can be an object that changes, and
 * any read can throw. The options are copied once, before a connection is opened, so what is
 * checked is what the BullMQ `Worker` is built from.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import { guarded } from '../config/guarded-read'
import { readByName } from '../config/read-by-name'
import { readKeysOf } from '../config/snapshot-options'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import type { WorkerOptions } from '../interfaces/worker-options.interface'

/** Every option of the library's `WorkerOptions`, held to that type by the compiler. */
const WORKER_OPTION_TABLE = {
  concurrency: true,
  limiter: true,
  autorun: true,
  lockDuration: true,
  stalledInterval: true,
  jobTimeoutMs: true,
} as const satisfies Record<keyof WorkerOptions, true>
const WORKER_OPTION_KEYS: readonly string[] = Object.keys(WORKER_OPTION_TABLE)

/** A refusal of worker options the library cannot read. */
function unreadable(what: string): QueueException {
  return new QueueException(
    QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
    HttpStatus.INTERNAL_SERVER_ERROR,
    { reason: `${what} could not be read` },
  )
}

/**
 * Copy the options of one worker registration, each read once, and the limiter with them.
 *
 * @param options - The options as the host gave them.
 * @param extraKeys - Names beyond the base options to read by name, such as `useWorkerThreads` of a
 *   sandboxed worker, which a class getter or a non-enumerable field would otherwise hide.
 * @returns A plain copy, or `options` itself when it is not an object, for validation to judge.
 * @throws {QueueException} `WORKER_REGISTRATION_FAILED`, with the host's error as the cause, when a read throws.
 */
export function snapshotWorkerOptions<T extends WorkerOptions | undefined>(
  options: T,
  ...extraKeys: readonly string[]
): T {
  return guarded(
    'the worker options',
    () => {
      const copy = readKeysOf(options as Record<string, unknown> | undefined, [
        ...WORKER_OPTION_KEYS,
        ...extraKeys,
      ])
      if (typeof copy === 'object' && 'limiter' in copy) {
        copy.limiter = readKeysOf(copy.limiter, ['max', 'duration'])
      }
      return copy as T
    },
    unreadable,
  )
}

/**
 * Read the named fields of the configuration of one worker registration, each once, under a guard.
 *
 * @param config - The configuration as the host gave it.
 * @param keys - The names to read.
 * @returns The value of each name, in order, `undefined` for one the host did not give.
 * @throws {QueueException} `WORKER_REGISTRATION_FAILED`, with the host's error as the cause, when a read throws.
 */
export function readWorkerConfig(config: object, keys: readonly string[]): unknown[] {
  return guarded(
    'the worker configuration',
    () => keys.map((key) => readByName(config, key)),
    unreadable,
  )
}
