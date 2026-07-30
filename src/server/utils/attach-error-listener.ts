/**
 * @fileoverview Fallback `error` listener for the BullMQ emitters this library
 * constructs on the consumer's behalf.
 * @layer server/utils
 */

import type { Logger } from '@nestjs/common'

/** The slice of an emitter this helper needs — `Worker` and `QueueEvents` both satisfy it. */
interface ErrorEmitter {
  on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Attach a fallback `error` listener to a BullMQ emitter.
 *
 * `Worker` and `QueueEvents` extend Node's `EventEmitter`, where emitting
 * `'error'` with **no listener registered throws** rather than being delivered.
 * These emitters are created by the library, not by the consumer, so a transient
 * Redis fault — a dropped connection, a command still in flight when the socket
 * closes — would surface as an uncaught exception in an application that never
 * asked for the emitter in the first place.
 *
 * This listener makes the emission survivable. It does not take the event away
 * from the consumer: `EventEmitter` delivers to every registered listener, so an
 * `@OnWorkerEvent('error')` or `@OnQueueEvent('error')` handler still runs
 * alongside it and stays the place to put real handling.
 *
 * @param emitter - The BullMQ `Worker` or `QueueEvents` instance.
 * @param logger - Logger that records the fault.
 * @param kind - Emitter kind, used in the log line (e.g. `Worker`).
 * @param queueName - Queue the emitter belongs to.
 * @example
 * attachDefaultErrorListener(worker, this.logger, 'Worker', 'email')
 */
export function attachDefaultErrorListener(
  emitter: ErrorEmitter,
  logger: Logger,
  kind: string,
  queueName: string,
): void {
  emitter.on('error', (err: Error) => {
    logger.error(`${kind} for queue "${queueName}" emitted an error: ${err.message}`)
  })
}
