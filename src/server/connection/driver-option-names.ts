/**
 * @fileoverview The option names ioredis reads off the options object it was given. ioredis merges
 * the options of a client into an ordinary object it makes itself and then reads names we did not set
 * from it, so a key planted on `Object.prototype` would be found there. Giving the options an own key
 * for every name, `undefined` where the host gave none, shadows what is planted: `undefined` is what
 * an absent option is to the driver.
 * @layer server/connection
 */

import type { RedisOptions } from 'ioredis'

/** Every key of the options of a client; a name ioredis adds fails the type check here. */
const TYPED_OPTION_NAMES = {
  Connector: true,
  autoPipeliningIgnoredCommands: true,
  autoResendUnfulfilledCommands: true,
  autoResubscribe: true,
  blockingTimeout: true,
  blockingTimeoutGrace: true,
  clientInfoTag: true,
  commandQueue: true,
  commandTimeout: true,
  connectTimeout: true,
  connectionName: true,
  db: true,
  disableClientInfo: true,
  disconnectTimeout: true,
  enableAutoPipelining: true,
  enableOfflineQueue: true,
  enableReadyCheck: true,
  enableTLSForSentinelMode: true,
  failoverDetector: true,
  family: true,
  himportFieldsets: true,
  host: true,
  keepAlive: true,
  keyPrefix: true,
  lazyConnect: true,
  maxLoadingRetryTime: true,
  maxRetriesPerRequest: true,
  monitor: true,
  name: true,
  natMap: true,
  noDelay: true,
  offlineQueue: true,
  password: true,
  path: true,
  port: true,
  preferredSlaves: true,
  protocol: true,
  readOnly: true,
  reconnectOnError: true,
  replyMapping: true,
  retryStrategy: true,
  role: true,
  scripts: true,
  sentinelCommandTimeout: true,
  sentinelMaxConnections: true,
  sentinelPassword: true,
  sentinelReconnectStrategy: true,
  sentinelRetryStrategy: true,
  sentinelTLS: true,
  sentinelUsername: true,
  sentinels: true,
  showFriendlyErrorStack: true,
  socketTimeout: true,
  stringNumbers: true,
  tls: true,
  updateSentinels: true,
  username: true,
} as const satisfies Record<keyof RedisOptions, true>

/** The names ioredis reads and does not type. */
const UNTYPED_OPTION_NAMES = ['timeout'] as const

/** Every option name of a client. */
export const DRIVER_OPTION_NAMES: readonly string[] = [
  ...Object.keys(TYPED_OPTION_NAMES),
  ...UNTYPED_OPTION_NAMES,
].sort()

/**
 * Copy options into an object with no prototype that holds every driver option name as an own key,
 * `undefined` for each one the options leave out.
 *
 * @param options - The options built for ioredis.
 * @returns The options over an own `undefined` for every driver option name.
 */
export function withOwnKeys<T extends object>(options: T): T {
  const copy = Object.create(null) as Record<string, unknown>
  for (const name of DRIVER_OPTION_NAMES) copy[name] = undefined
  return Object.assign(copy, options)
}
