/**
 * @fileoverview Provides a dedicated ioredis client for use with BymaxQueueModule in Mode A.
 * This module creates a Redis connection with `maxRetriesPerRequest: null` so it is compatible
 * with BullMQ worker and queue-events connections that require blocking semantics.
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
 * The client is created with `maxRetriesPerRequest: null` so it satisfies
 * the per-role connection policy required by BullMQ workers.
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
              return new Redis(options.url, { maxRetriesPerRequest: null })
            }
            return new Redis({
              host: options.host ?? '127.0.0.1',
              port: options.port ?? 6379,
              maxRetriesPerRequest: null,
            })
          },
        },
      ],
      exports: [QUEUE_REDIS_CLIENT],
      global: true,
    }
  }
}
