/**
 * @fileoverview Dual-mode Redis connection resolver. Resolves a BYO client
 * (Mode A) or opens a library-owned ioredis with a ready timeout (Mode B), and
 * enforces the per-role `maxRetriesPerRequest` policy.
 * @layer server/services
 */

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { Redis, type RedisOptions } from 'ioredis'
import { BYMAX_QUEUE_OPTIONS } from '../bymax-queue.constants'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueConnectionMode } from '../interfaces/queue-connection.interface'
import { assertBlockingConnection, isClientUsable } from '../utils/validate-connection'
import { attachClientErrorListener } from '../utils/attach-client-error-listener'
import { duplicateConnection } from '../utils/duplicate-connection'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
} from '../constants/default-options'
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
  readonly #logger = new Logger(ConnectionResolver.name)

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

  /** The wait for `ready` that every caller shares while the client is not ready. */
  #pendingReady: Promise<void> | undefined

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
    // Before the first await, and for good: the startup race below removes its own listener once
    // the client is ready, and a client with none prints every later outage to raw stderr.
    attachClientErrorListener(this.#client, this.#logger, 'owned')
    try {
      await this.waitReady(
        this.#options.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
      )
    } catch (cause) {
      // The client keeps reconnecting on its own until it is closed, and nothing else holds a
      // reference to it once startup has failed: close it here, or it outlives the failed boot.
      this.#client.disconnect()
      throw cause
    }
  }

  /**
   * Merge the consumer's options with the owned-connection policy
   * (`lazyConnect: false`, so the client connects eagerly and `init` can wait
   * for `ready`; a command deadline, so a frozen Redis fails a call in seconds; and no offline
   * queue, so a call made during an outage fails at once instead of buffering without bound —
   * each only where the consumer has not chosen a value) and narrow the result to the shape ioredis 6's constructor
   * accepts. The runtime object is unchanged — the cast only drops the
   * `undefined` that `RedisOptions.replyMapping` carries and the constructor
   * rejects.
   */
  private ownedOptions(options?: Partial<RedisOptions>): OwnedRedisOptions {
    return {
      commandTimeout: this.#options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      ...(options ?? {}),
      lazyConnect: false,
    } as OwnedRedisOptions
  }

  /** The resolved Queue-role client. */
  getClient(): Redis {
    if (!this.#client) {
      throw new QueueException(
        QUEUE_ERROR_CODES.CONNECTION_INVALID,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          reason: 'not initialized',
        },
      )
    }
    return this.#client
  }

  /** The resolved connection mode. */
  getMode(): QueueConnectionMode {
    if (!this.mode) {
      throw new QueueException(
        QUEUE_ERROR_CODES.CONNECTION_INVALID,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          reason: 'not initialized',
        },
      )
    }
    return this.mode
  }

  /** Whether the library owns (and must close) the connection. */
  isOwned(): boolean {
    return this.mode === 'mode-b-owned'
  }

  /**
   * Settle when the client can take a command. While it is still connecting or reconnecting, every
   * caller shares one wait on its `ready` event, so a health check that polls through a long outage
   * adds one listener set to the client, not one per call, and gives it back when Redis returns. A
   * lazy client (`wait`) connects on its first command and a finished one (`end`) never becomes
   * ready, so both are left for the call itself.
   */
  awaitReady(): Promise<void> {
    const client = this.getClient()
    if (!WAITING_STATUSES.has(client.status)) return Promise.resolve()
    this.#pendingReady ??= new Promise<void>((resolve) => {
      client.once('ready', () => {
        this.#pendingReady = undefined
        resolve()
      })
    })
    return this.#pendingReady
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
      throw new QueueException(
        QUEUE_ERROR_CODES.CONNECTION_INVALID,
        HttpStatus.INTERNAL_SERVER_ERROR,
        { status: client.status },
      )
    }
    if (client.options.maxRetriesPerRequest === null) {
      this.#logger.warn(
        'The shared client has maxRetriesPerRequest: null, so a producer call made while Redis is ' +
          'unreachable waits for as long as the outage lasts; enqueue is bounded by ' +
          'enqueueTimeoutMs, other QueueService calls are not. Give the client a finite limit to ' +
          'fail fast.',
      )
    }
    const probe = duplicateConnection(client)
    attachClientErrorListener(probe, this.#logger, 'probe')
    try {
      assertBlockingConnection(probe)
    } finally {
      probe.disconnect()
    }
  }

  /**
   * Resolve when the owned client reaches `ready`. A connection error while the client is still
   * reconnecting does not end the wait — a Redis that restarts during a deploy refuses connections
   * for a moment first — so the budget does. The two exceptions are an answer from the server that
   * waiting cannot change (a refused credential) and a client that has stopped reconnecting; both
   * reject at once. The rejection carries the last error's code and never its message, which can
   * name the host.
   */
  private async waitReady(timeoutMs: number): Promise<void> {
    const client = this.getClient()
    if (client.status === 'ready') return
    await new Promise<void>((resolve, reject) => {
      let lastErrorCode: string | undefined
      const details = (extra: Record<string, unknown>): Record<string, unknown> =>
        lastErrorCode === undefined ? extra : { ...extra, lastErrorCode }
      const cleanup = (): void => {
        clearTimeout(timer)
        client.off('ready', onReady)
        client.off('error', onError)
        client.off('end', onEnd)
      }
      const fail = (code: string, extra: Record<string, unknown>): void => {
        cleanup()
        reject(new QueueException(code, HttpStatus.INTERNAL_SERVER_ERROR, details(extra)))
      }
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (err: unknown): void => {
        lastErrorCode = startupErrorCode(err)
        if (isReplyError(err)) fail(QUEUE_ERROR_CODES.CONNECTION_INVALID, {})
      }
      const onEnd = (): void => {
        fail(QUEUE_ERROR_CODES.CONNECTION_INVALID, {})
      }
      const timer = setTimeout(() => {
        fail(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, { timeoutMs })
      }, timeoutMs)
      client.once('ready', onReady)
      client.on('error', onError)
      client.once('end', onEnd)
    })
  }
}

/** The client statuses in which a call would wait for the connection: it is not ready yet. */
const WAITING_STATUSES: ReadonlySet<string> = new Set([
  'connecting',
  'connect',
  'reconnecting',
  'close',
])

/** True for an error the server answered with (`WRONGPASS`, `NOAUTH`, ...), as opposed to a socket fault. */
function isReplyError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ReplyError'
  )
}

/**
 * The value-free code of a startup error: a socket error's `code` (`ECONNREFUSED`), or the leading
 * token of a server reply (`WRONGPASS`). Never the message, which can name the host or the user.
 */
function startupErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (typeof code === 'string') return code
  if (isReplyError(err) && typeof message === 'string') return /^[A-Z][A-Z0-9_]*/.exec(message)?.[0]
  return undefined
}
