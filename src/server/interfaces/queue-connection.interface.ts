/**
 * @fileoverview Dual-mode Redis connection configuration contract.
 * @layer server/interfaces
 */

import type { Redis, RedisOptions } from 'ioredis'

/**
 * Connection configuration — Mode A (bring your own client) or Mode B
 * (library-owned), discriminated by the presence of `client`, `url`, or
 * `options`. The three arms are mutually exclusive.
 *
 * Mode A: the caller passes a `Redis` already configured for BullMQ (typically
 * obtained from `@bymax-one/nest-cache`). The library uses it AS-IS for the
 * Queue and FlowProducer role and never closes it; Worker/QueueEvents roles get
 * a duplicated connection forced to `maxRetriesPerRequest: null`.
 *
 * Mode B: the library opens its own `ioredis` from a URL or options object. The
 * Queue/FlowProducer connection keeps ioredis' default retries (so enqueue
 * fails fast during a Redis outage); the library closes it on shutdown.
 *
 * @example Mode A
 * const config: QueueConnectionConfig = { client: queueRedis }
 * @example Mode B (url)
 * const config: QueueConnectionConfig = { url: 'redis://localhost:6379', options: { db: 1 } }
 * @example Mode B (options only)
 * const config: QueueConnectionConfig = { options: { host: 'localhost', port: 6379, db: 1 } }
 */
export type QueueConnectionConfig =
  | { client: Redis; ownsConnection?: false }
  | { url: string; options?: Partial<RedisOptions> }
  | { options: RedisOptions }

/** Internal discriminator the ConnectionResolver uses to tag the active mode. */
export type QueueConnectionMode = 'mode-a-byo' | 'mode-b-owned'
