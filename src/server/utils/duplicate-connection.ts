/**
 * @fileoverview Helper to duplicate an ioredis client for blocking BullMQ roles.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'

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
  // ioredis arms a command deadline only when `commandTimeout` is a number and merges the override
  // over the parent's options with a spread, so an explicit `undefined` clears it. `RedisOptions`
  // does not admit `undefined` under `exactOptionalPropertyTypes`, so the override is built as a
  // plain record, which the parameter accepts without any assertion.
  const override: Record<string, unknown> = {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    commandTimeout: undefined,
  }
  return client.duplicate(override)
}
