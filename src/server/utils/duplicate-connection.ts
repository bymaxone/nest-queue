/**
 * @fileoverview Helper to duplicate an ioredis client for blocking BullMQ roles.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'
import { guardSentinelConnector } from '../connection/guarded-connector'

/**
 * Duplicate an ioredis client for use by a Worker or QueueEvents instance. The
 * duplicate inherits all options but forces `maxRetriesPerRequest: null`, which
 * BullMQ requires on the blocking connections it uses for `BRPOPLPUSH` /
 * `BZPOPMIN` / `BLMOVE`, and drops the producer's fail-fast policy: a blocking command outlasts
 * any command deadline, and the worker loop has to ride out a reconnect on a live offline queue.
 *
 * A client in sentinel mode builds its own connector, which a duplicate would build again without
 * the guard, so the duplicate is built lazy, its connector is guarded, and it connects on its first
 * command or `connect()`, as BullMQ does.
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
  // A client that carries no options is not one ioredis built, so it has no sentinels to guard.
  const options = client.options as typeof client.options | undefined
  if (!options?.sentinels) return client.duplicate(override)
  return guardSentinelConnector(client.duplicate({ ...override, lazyConnect: true }))
}
