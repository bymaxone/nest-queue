/**
 * @fileoverview Provides a dedicated ioredis client for use with BymaxQueueModule in Mode A.
 * The client keeps ioredis' default retry policy because it serves the Queue/FlowProducer role;
 * the library duplicates it with `maxRetriesPerRequest: null` only for the blocking
 * Worker/QueueEvents connections, so enqueues still fail fast during a Redis outage.
 * @layer infrastructure
 */

import { Module, type DynamicModule } from '@nestjs/common'
import { Redis } from 'ioredis'

/** Injection token for the BullMQ-dedicated ioredis client. */
export const QUEUE_REDIS_CLIENT = Symbol('QUEUE_REDIS_CLIENT')

/** Options for creating the dedicated Redis client. */
interface RedisClientOptions {
  /** Redis connection URL (e.g. `redis://127.0.0.1:6379`). */
  url?: string
  /** Redis host (used when `url` is not provided). */
  host?: string
  /** Redis port (used when `url` is not provided). */
  port?: number
}

/**
 * Provides a dedicated ioredis client suitable for BullMQ (Mode A).
 * The client keeps ioredis' default retry policy because it is used for the
 * Queue/FlowProducer role; the library applies `maxRetriesPerRequest: null`
 * only on the duplicated Worker/QueueEvents connections.
 *
 * @example
 * ```typescript
 * RedisModule.forRoot({ url: process.env['REDIS_URL'] })
 * ```
 */
@Module({})
export class RedisModule {
  /**
   * Create a `RedisModule` that exports a dedicated ioredis client.
   *
   * @param options - Connection options (url or host/port).
   * @returns A dynamic module exporting `QUEUE_REDIS_CLIENT`.
   */
  static forRoot(options: RedisClientOptions): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        {
          provide: QUEUE_REDIS_CLIENT,
          useFactory: (): Redis => {
            if (options.url) {
              return new Redis(options.url)
            }
            return new Redis({
              host: options.host ?? '127.0.0.1',
              port: options.port ?? 6379,
            })
          },
        },
      ],
      exports: [QUEUE_REDIS_CLIENT],
      global: true,
    }
  }
}
