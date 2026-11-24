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
  DISCONNECT_TIMEOUT_MS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from '../constants/default-options'
import { withOwnKeys } from '../connection/driver-option-names'
import { GuardedConnector, guardSentinelConnector } from '../connection/guarded-connector'
import { assertPrototypeClean } from '../connection/prototype-guard'
import { startWait } from '../utils/bounded-wait'
import { pingResult, type PingResult } from '../utils/ping-result'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { disconnectUnlessEnded } from '../utils/disconnect-unless-ended'
import { quitWithin } from '../utils/quit-within'
import { isCommandTimeout, unavailableException } from '../utils/command-timeout'
import { logEvent, QUEUE_LOG_EVENTS, reportRefusal, writeLog } from '../utils/log-event'

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
    assertPrototypeClean()
    const cfg = this.#options.connection
    if ('client' in cfg) {
      this.initModeA(cfg.client)
      return
    }
    this.mode = 'mode-b-owned'
    const sentinel = Boolean(cfg.options?.sentinels)
    this.#client =
      'url' in cfg
        ? new Redis(cfg.url, this.ownedOptions(cfg.options))
        : new Redis(this.ownedOptions(cfg.options))
    // ioredis starts the first connect inside its constructor, before a wrap is possible, so a
    // sentinel client is built lazy, wrapped, and connected here.
    if (sentinel) guardSentinelConnector(this.#client)
    // Before the first await, and for good: the startup race below removes its own listener once
    // the client is ready, and a client with none prints every later outage to raw stderr.
    attachClientErrorListener(this.#client, this.#logger, 'owned')
    if (sentinel) this.#client.connect().catch(() => undefined)
    try {
      await this.waitReady(
        this.#options.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
      )
    } catch (cause) {
      // The client keeps reconnecting on its own until it is closed, and nothing else holds a
      // reference to it once startup has failed: close it here, or it outlives the failed boot.
      disconnectUnlessEnded(this.#client)
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
    const sentinel = Boolean(options?.sentinels)
    return withOwnKeys({
      commandTimeout: this.#options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      disconnectTimeout: DISCONNECT_TIMEOUT_MS,
      ...(options ?? {}),
      // After the host's options, so a `Connector` of the host's cannot remove the guard. A sentinel
      // client builds its own connector, which is guarded after it is built, and takes none.
      Connector: sentinel ? undefined : GuardedConnector,
      lazyConnect: sentinel,
    }) as OwnedRedisOptions
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
      // `end` means ioredis will not reconnect: release the waiters so the call itself reports the
      // failure, instead of leaving them to their deadline.
      const release = (): void => {
        client.off('ready', release)
        client.off('end', release)
        this.#pendingReady = undefined
        resolve()
      }
      client.on('ready', release)
      client.on('end', release)
    })
    return this.#pendingReady
  }

  /**
   * Close the library-owned connection on shutdown; never touch a BYO client. The quit is bounded:
   * against a frozen Redis it would otherwise wait for the client's own command deadline, which a
   * derived backend may have raised.
   *
   * @param timeoutMs - The longest the quit may take. Default: the shutdown drain budget.
   */
  async teardown(timeoutMs: number = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.isOwned() && this.#client) await quitWithin(this.#client, timeoutMs, this.#logger)
  }

  /**
   * Ping Redis for a readiness check, inside a bound. It never rejects once the connection is
   * initialised: a ping that fails, is unanswered at the bound or after `signal` aborts, or is run
   * under a prototype the guard refuses (logged), reports `down`.
   *
   * @param timeoutMs - The longest the ping may take, in milliseconds.
   * @param signal - Aborted when the caller stops waiting.
   * @returns `up` when Redis answered in time, `down` otherwise, with the connection mode.
   */
  async ping(timeoutMs: number, signal?: AbortSignal): Promise<PingResult> {
    const mode = this.getMode()
    let up = false
    try {
      assertPrototypeClean()
      const wait = startWait(this.getClient().ping(), timeoutMs, signal ? { signal } : {})
      try {
        assertPrototypeClean()
        up = (await wait.result).state === 'done'
      } finally {
        wait.release()
      }
    } catch (error) {
      reportRefusal(this.#logger, error, 'health')
    }
    return pingResult(up, mode)
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
      writeLog(
        this.#logger,
        'warn',
        logEvent(
          QUEUE_LOG_EVENTS.UNBOUNDED_RETRIES,
          'The shared client has maxRetriesPerRequest: null, so a command issued while Redis is ' +
            'unreachable stays queued in the client for as long as the outage lasts. QueueService calls ' +
            'are bounded by enqueueTimeoutMs and the caller is released, but the command is not ' +
            'cancelled. Give the client a finite limit to fail fast.',
        ),
      )
    }
    const probe = duplicateConnection(client)
    attachClientErrorListener(probe, this.#logger, 'probe')
    try {
      assertBlockingConnection(probe)
    } finally {
      disconnectUnlessEnded(probe)
    }
  }

  /**
   * Resolve when the owned client reaches `ready`. A connection error while the client is still
   * reconnecting does not end the wait — a Redis that restarts during a deploy refuses connections
   * for a moment first — so the budget does. The two exceptions are an answer from the server that
   * waiting cannot change (a refused credential) and a client that has stopped reconnecting; both
   * reject at once. No rejection carries an error code or message in its response, since both can
   * name the backing service's state or host: the last error, when there was one, is the
   * exception's `cause`.
   */
  private async waitReady(timeoutMs: number): Promise<void> {
    const client = this.getClient()
    if (client.status === 'ready') return
    await new Promise<void>((resolve, reject) => {
      let lastError: unknown
      const cleanup = (): void => {
        clearTimeout(timer)
        client.off('ready', onReady)
        client.off('error', onError)
        client.off('end', onEnd)
      }
      // The status follows the cause: a budget that ended means Redis is unavailable (retry may
      // help), a refused credential or an ended client is a configuration fault (retry cannot).
      const fail = (code: string, status: HttpStatus, extra: Record<string, unknown>): void => {
        cleanup()
        const exception = new QueueException(code, status, extra)
        if (lastError !== undefined) exception.cause = lastError
        reject(exception)
      }
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (err: unknown): void => {
        lastError = err
        if (isReplyError(err))
          fail(QUEUE_ERROR_CODES.CONNECTION_INVALID, HttpStatus.INTERNAL_SERVER_ERROR, {})
      }
      const onEnd = (): void => {
        if (!isUnreachable(lastError)) {
          fail(QUEUE_ERROR_CODES.CONNECTION_INVALID, HttpStatus.INTERNAL_SERVER_ERROR, {})
          return
        }
        cleanup()
        reject(unavailableException('connect', lastError, 'unavailable'))
      }
      const timer = setTimeout(() => {
        fail(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, HttpStatus.SERVICE_UNAVAILABLE, { timeoutMs })
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

/**
 * The network errors Node reports on a connection that could not be made or was cut, in
 * `error.code`: the set the sibling libraries read for a Redis outage.
 */
const NETWORK_CODES: ReadonlySet<unknown> = new Set<unknown>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/**
 * Whether a startup error says Redis could not be reached, so a retry may help: a network error
 * (an `AggregateError` from a host that resolves to several addresses carries the code too), or
 * the command timeout ioredis raises when the ready check's `INFO` gets no answer. A reply error
 * and the absence of any error are not outages.
 */
function isUnreachable(err: unknown): boolean {
  return (
    isCommandTimeout(err) || NETWORK_CODES.has((err as { code?: unknown } | null | undefined)?.code)
  )
}

/** True for an error the server answered with (`WRONGPASS`, `NOAUTH`, ...), as opposed to a socket fault. */
function isReplyError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ReplyError'
  )
}
