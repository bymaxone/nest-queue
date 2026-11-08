/**
 * @fileoverview Persistent `error` listener for the Redis clients this library constructs or
 * duplicates itself.
 * @layer server/utils
 */

import type { Logger } from '@nestjs/common'
import { describeError } from './describe-error'

/** The slice of an ioredis client this helper needs. */
interface ErrorEmitter {
  on(event: 'error', listener: (err: unknown) => void): unknown
}

/**
 * What went wrong, for a log line: the error's message, or, when it has none, its name and code.
 *
 * Node reports a refused connection to a host with two addresses as an `AggregateError` whose
 * `message` is empty and whose `code` is `ECONNREFUSED`. Only the message, the name and the code
 * are read: the nested errors name addresses, and a connection URL can carry credentials.
 */
function describeClientError(err: unknown): string {
  const message = describeError(err)
  if (message !== '') return message
  try {
    const { name, code } = err as { name?: unknown; code?: unknown }
    const label = typeof name === 'string' && name !== '' ? name : 'unknown error'
    return typeof code === 'string' ? `${label} [${code}]` : label
  } catch {
    return 'unknown error'
  }
}

/**
 * Attach a listener that logs every `error` a Redis client emits, for the client's whole life.
 *
 * ioredis writes `[ioredis] Unhandled error event: ...` to raw stderr each time a client emits
 * `error` with no listener registered, one line per reconnect attempt. That output bypasses the
 * module's logger during exactly the outage the logs exist for. A listener that is removed once
 * the client is ready (as a startup race removes its own) leaves every later outage in that state.
 *
 * Only clients the library creates and owns get this. A client the host supplies is the host's:
 * how it reports its own faults is the host's decision, and a second logger on it would speak for
 * an application that never asked.
 *
 * Every error is logged, with no throttling or de-duplication, which is how nest-cache forwards
 * the same event from its own client.
 *
 * @param client - A Redis client the library constructed or duplicated.
 * @param logger - Logger that records the fault.
 * @param role - What the connection is for, used in the log line (e.g. `owned`).
 * @example
 * attachClientErrorListener(client, this.logger, 'owned')
 */
export function attachClientErrorListener(
  client: ErrorEmitter,
  logger: Logger,
  role: string,
): void {
  // `emit('error', value)` accepts any value, so the listener must not assume an `Error`: a throw
  // inside it escapes `emit` to the client's caller.
  client.on('error', (err: unknown) => {
    logger.error(`Redis connection (${role}) emitted an error: ${describeClientError(err)}`)
  })
}
