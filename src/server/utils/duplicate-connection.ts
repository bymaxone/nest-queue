/**
 * @fileoverview Helper to duplicate an ioredis client for blocking BullMQ roles.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'

/**
 * Duplicate an ioredis client for use by a Worker or QueueEvents instance. The
 * duplicate inherits all options but forces `maxRetriesPerRequest: null`, which
 * BullMQ requires on the blocking connections it uses for `BRPOPLPUSH` /
 * `BZPOPMIN` / `BLMOVE`.
 *
 * @param client - The source client (the Queue-role connection).
 * @returns A duplicated client suitable for blocking commands.
 */
export function duplicateConnection(client: Redis): Redis {
  return client.duplicate({ maxRetriesPerRequest: null })
}
