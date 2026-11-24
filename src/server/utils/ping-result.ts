/**
 * @fileoverview The answer of a readiness ping, built from objects with no prototype. A promise
 * resolved with an ordinary object reads its `then` off `Object.prototype`, where a planted one
 * would answer in the library's place; an object that has no prototype has nowhere to inherit one
 * from.
 * @layer server/utils
 */

import type { QueueConnectionMode } from '../interfaces/queue-connection.interface'

/** The object constructor, taken when this module loaded. */
const create = Object.create

/** What a readiness ping reports: whether Redis answered, and the connection mode it was asked through. */
export interface PingResult {
  readonly status: 'up' | 'down'
  readonly details: { readonly mode: QueueConnectionMode }
}

/**
 * Build the result of a ping.
 *
 * @param up - Whether Redis answered in time.
 * @param mode - The connection mode of the client that was pinged.
 */
export function pingResult(up: boolean, mode: QueueConnectionMode): PingResult {
  const details = create(null) as { mode: QueueConnectionMode }
  details.mode = mode
  const result = create(null) as { status: 'up' | 'down'; details: typeof details }
  result.status = up ? 'up' : 'down'
  result.details = details
  return result
}
