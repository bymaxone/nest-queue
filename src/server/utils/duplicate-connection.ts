/**
 * @fileoverview Helper to duplicate an ioredis client for blocking BullMQ roles.
 * @layer server/utils
 */

import type { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { attachClientErrorListener } from './attach-client-error-listener'
import { disconnectUnlessEnded } from './disconnect-unless-ended'
import { guardSentinelConnector } from '../connection/guarded-connector'

/** The clients each library duplicate has made in turn, kept for their release. */
const duplicatesOf = new WeakMap<Redis, Redis[]>()

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
 * The duplicate gets the logging `error` listener here, so it has one for its whole life: BullMQ
 * removes its own from a connection it was handed when it closes, before the library is done with it.
 * Every client the duplicate makes in turn, which is how BullMQ builds its blocking connection,
 * gets the same listener and is released by {@link retireDuplicates}.
 *
 * @param client - The source client (the Queue-role connection).
 * @param logger - Logger that records the duplicate's faults.
 * @param role - What the duplicate is for, used in the log line (e.g. `probe`).
 * @returns A duplicated client suitable for blocking commands.
 */
export function duplicateConnection(client: Redis, logger: Logger, role: string): Redis {
  const duplicate = copyClient(client)
  attachClientErrorListener(duplicate, logger, role)
  keepDuplicates(duplicate, logger, role)
  return duplicate
}

/**
 * End for good the clients a library duplicate made, once whatever used them is closed. BullMQ can
 * still have a reconnect pending on its blocking connection after a forced close, and that call
 * opens the client again, so `connect` is replaced before the client is disconnected.
 *
 * @param client - A client returned by {@link duplicateConnection}.
 * @example
 * retireDuplicates(connection)
 */
export function retireDuplicates(client: Redis): void {
  for (const made of duplicatesOf.get(client) ?? []) {
    made.connect = stayClosed
    disconnectUnlessEnded(made)
  }
}

/** Stands in for `connect` on a retired client: a reconnect still pending ends without opening it. */
async function stayClosed(): Promise<void> {
  // Opens nothing.
}

/**
 * Give every client `client` makes the logging listener, and remember it.
 *
 * @param client - A library duplicate.
 * @param logger - Logger that records the faults.
 * @param role - The role of `client`, which its duplicates share.
 */
function keepDuplicates(client: Redis, logger: Logger, role: string): void {
  const made: Redis[] = []
  // Read, not bound: the call below supplies the client as `this`.
  const duplicate: Redis['duplicate'] = Reflect.get(client, 'duplicate')
  client.duplicate = (...args: Parameters<Redis['duplicate']>): Redis => {
    const next = duplicate.apply(client, args)
    attachClientErrorListener(next, logger, role)
    made.push(next)
    return next
  }
  duplicatesOf.set(client, made)
}

/**
 * The duplicate itself, with the options the blocking roles need.
 *
 * @param client - The source client.
 * @returns A new client; a sentinel one is lazy and has its connector guarded.
 */
function copyClient(client: Redis): Redis {
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
  return guardSentinelClient(client.duplicate({ ...override, lazyConnect: true }))
}

/**
 * Guard the connector of a sentinel client and of every client it duplicates: BullMQ's queue events
 * duplicate the connection they are handed, and ioredis would build that one's connector again
 * without the guard.
 *
 * @param client - A sentinel client built lazy.
 * @returns The same client, whose `duplicate` builds guarded lazy clients in turn.
 */
function guardSentinelClient(client: Redis): Redis {
  guardSentinelConnector(client)
  const duplicate = client.duplicate.bind(client)
  client.duplicate = (override?: Parameters<Redis['duplicate']>[0]): Redis =>
    guardSentinelClient(duplicate({ ...override, lazyConnect: true }))
  return client
}
