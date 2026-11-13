/**
 * @fileoverview Helper to duplicate an ioredis client for blocking BullMQ roles.
 * @layer server/utils
 */

import type { Redis, RedisOptions } from 'ioredis'

/**
 * Duplicate an ioredis client for use by a Worker or QueueEvents instance. The
 * duplicate inherits all options but forces `maxRetriesPerRequest: null`, which
 * BullMQ requires on the blocking connections it uses for `BRPOPLPUSH` /
 * `BZPOPMIN` / `BLMOVE`, and drops the producer's fail-fast policy: a blocking command outlasts
 * any command deadline, and the worker loop has to ride out a reconnect on a live offline queue.
 *
 * @param client - The source client (the Queue-role connection).
 * @returns A duplicated client suitable for blocking commands.
 */
export function duplicateConnection(client: Redis): Redis {
  // ioredis only skips the deadline when the key is not a number, and merges overrides with a
  // spread, so an explicit `undefined` clears it; its type does not admit that under
  // `exactOptionalPropertyTypes`, hence the cast.
  const override = {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    commandTimeout: undefined,
  } as unknown as RedisOptions
  return client.duplicate(override)
}
