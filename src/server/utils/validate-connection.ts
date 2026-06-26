/**
 * @fileoverview Assertions over ioredis clients used by the resolver.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Assert that a DUPLICATED Worker/QueueEvents connection honors
 * `maxRetriesPerRequest: null`. BullMQ requires `null` on blocking connections
 * and throws at construction otherwise. The Queue/FlowProducer connection is NOT
 * checked here — it keeps ioredis' default retries so enqueue fails fast during
 * a Redis outage. Called on the duplicated probe to fail fast when a client
 * wrapper prevents the `duplicate()` override from taking effect.
 *
 * @param client - The duplicated probe connection to validate.
 * @throws QueueException with code `CONNECTION_REQUIRES_NULL_RETRIES` when the
 *   override was ignored.
 */
export function assertBlockingConnection(client: Redis): void {
  const actualValue = (client.options as { maxRetriesPerRequest?: number | null } | undefined)
    ?.maxRetriesPerRequest
  if (actualValue !== null) {
    throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_REQUIRES_NULL_RETRIES, 500, {
      actualValue: actualValue ?? null,
      expectedValue: null,
    })
  }
}

/**
 * Returns `true` when the client is ready or connecting — both states BullMQ
 * tolerates when handed an existing connection.
 *
 * @param client - The client to inspect.
 */
export function isClientUsable(client: Redis): boolean {
  return client.status === 'ready' || client.status === 'connecting'
}
