/**
 * @fileoverview Dual-mode Redis connection resolver. Resolves a BYO client
 * (Mode A) or opens a library-owned ioredis with a ready timeout (Mode B), and
 * enforces the per-role `maxRetriesPerRequest` policy.
 * @layer server/services
 */

import { Inject, Injectable } from '@nestjs/common'
import { Redis, type RedisOptions } from 'ioredis'
import { BYMAX_QUEUE_OPTIONS } from '../bymax-queue.constants'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueConnectionMode } from '../interfaces/queue-connection.interface'
import { assertBlockingConnection, isClientUsable } from '../utils/validate-connection'
import { duplicateConnection } from '../utils/duplicate-connection'
import { DEFAULT_CONNECTION_READY_TIMEOUT_MS } from '../constants/default-options'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * The exact options shape ioredis 6's `Redis` constructor accepts.
 *
 * `RedisOptions` declares `replyMapping?: ReplyMappingMode | undefined`, but the
 * constructor overloads intersect it with `{ replyMapping?: ReplyMappingMode }`
 * (no `undefined`) to infer the reply-mapping generic. Under
 * `exactOptionalPropertyTypes` a plain `RedisOptions` value is therefore not
 * assignable to the constructor, so the owned-connection options are built
 * against this narrowed shape. `NonNullable` reconstructs the constructor's
 * requirement from the exported type alone, without reaching for an unexported
 * internal one.
 */
type OwnedRedisOptions = Omit<RedisOptions, 'replyMapping'> & {
  replyMapping?: NonNullable<RedisOptions['replyMapping']>
}

/**
 * Resolves the Queue-role Redis connection and tracks ownership so the lifecycle
 * knows whether to close it on shutdown.
 *
 * - Mode A (BYO): the received client is used as-is for the Queue/FlowProducer
 *   role and never closed; a duplicated probe verifies that the blocking-role
 *   override resolves to `maxRetriesPerRequest: null`.
 * - Mode B (owned): the library opens its own client (URL or options) and waits
 *   for `ready`, closing it on shutdown.
 */
@Injectable()
export class ConnectionResolver {
  /**
   * The resolved Redis client.
   *
   * An ECMAScript private field rather than a TypeScript `private` one, which
   * is erased at runtime: an ioredis instance carries `options.password` as a
   * plain field, so leaving this enumerable would let anything that serializes
   * a service holding this resolver walk into the credentials.
   */
  #client: Redis | undefined

  /** The consumer's module options, which carry the Redis credentials. */
  readonly #options: BymaxQueueModuleOptions

  private mode: QueueConnectionMode | undefined

  constructor(@Inject(BYMAX_QUEUE_OPTIONS) options: BymaxQueueModuleOptions) {
    this.#options = options
  }

  /** Resolve and validate the connection. Call once during module bootstrap. */
  async init(): Promise<void> {
    const cfg = this.#options.connection
    if ('client' in cfg) {
      this.initModeA(cfg.client)
      return
    }
    this.mode = 'mode-b-owned'
    this.#client =
      'url' in cfg
        ? new Redis(cfg.url, this.ownedOptions(cfg.options))
        : new Redis(this.ownedOptions(cfg.options))
    await this.waitReady(
      this.#options.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
    )
  }

  /**
   * Merge the consumer's options with the owned-connection policy
   * (`lazyConnect: false`, so the client connects eagerly and `init` can wait
   * for `ready`) and narrow the result to the shape ioredis 6's constructor
   * accepts. The runtime object is unchanged — the cast only drops the
   * `undefined` that `RedisOptions.replyMapping` carries and the constructor
   * rejects.
   */
  private ownedOptions(options?: Partial<RedisOptions>): OwnedRedisOptions {
    return { ...(options ?? {}), lazyConnect: false } as OwnedRedisOptions
  }

  /** The resolved Queue-role client. */
  getClient(): Redis {
    if (!this.#client) {
      throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, {
        reason: 'not initialized',
      })
    }
    return this.#client
  }

  /** The resolved connection mode. */
  getMode(): QueueConnectionMode {
    if (!this.mode) {
      throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, {
        reason: 'not initialized',
      })
    }
    return this.mode
  }

  /** Whether the library owns (and must close) the connection. */
  isOwned(): boolean {
    return this.mode === 'mode-b-owned'
  }

  /** Close the library-owned connection on shutdown; never touch a BYO client. */
  async teardown(): Promise<void> {
    if (this.isOwned() && this.#client) {
      const client = this.#client
      await client.quit().catch(() => {
        client.disconnect()
      })
    }
  }

  /** Validate and adopt a bring-your-own client for the Queue role. */
  private initModeA(client: Redis): void {
    this.mode = 'mode-a-byo'
    this.#client = client
    if (!isClientUsable(client)) {
      throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, { status: client.status })
    }
    const probe = duplicateConnection(client)
    try {
      assertBlockingConnection(probe)
    } finally {
      probe.disconnect()
    }
  }

  /** Resolve when the owned client reaches `ready`, or reject on timeout/error. */
  private async waitReady(timeoutMs: number): Promise<void> {
    const client = this.getClient()
    if (client.status === 'ready') return
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        client.off('ready', onReady)
        client.off('error', onError)
      }
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new QueueException(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, 500, { timeoutMs }))
      }, timeoutMs)
      client.once('ready', onReady)
      client.once('error', onError)
    })
  }
}
