/**
 * @fileoverview The connector the connection resolver gives ioredis, and the guard it puts on every
 * connect. ioredis opens its socket in `connect()`, on the first connect and on every reconnect,
 * from an ordinary object it builds then (`{ port, host, family }` plus the `tls` options), which Node
 * reads with inheritance: a `path`, `ca`, `cert` or `servername` planted on `Object.prototype` after the
 * client was built would redirect the connection to a unix socket or make a server trusted. The guard
 * that refuses a polluted `Object.prototype` at build time cannot see that, so it runs here as well, in
 * the tick that opens the socket, and the object handed to Node has no prototype.
 * @layer server/connection
 */
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ConnectionOptions } from 'node:tls'

import { AbstractConnector, Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'

import { withOwnKeys } from './driver-option-names'
import { assertPrototypeClean } from './prototype-guard'

/**
 * Cut the table of listeners of a socket from `Object.prototype`. An emitter looks a listener up with
 * a property read on that table, so a string planted under any event name after the guard ran would be
 * found there and called, ending the process from inside `emit`; no list of event names can be
 * complete. With no prototype the table finds only the listeners that were registered.
 */
function sealListeners(stream: Socket): void {
  const table = (stream as unknown as { _events?: object })._events
  if (table !== undefined) Object.setPrototypeOf(table, null)
}

/** ioredis's own text for a connect attempt that was cancelled before the socket opened. */
const CONNECTION_CLOSED_MESSAGE = 'Connection is closed.'

/** The options of a client, as far as the connector reads them. */
interface IConnectorOptions {
  readonly disconnectTimeout?: number | undefined
  readonly path?: string | undefined
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly family?: number | undefined
  readonly tls?: ConnectionOptions | undefined
}

/**
 * The connector of a standalone client and of the nodes of a cluster: ioredis's own `StandaloneConnector`
 * with the guard run in the tick that opens the socket, and the options handed to Node held in an
 * object that has no prototype.
 */
export class GuardedConnector extends AbstractConnector {
  /**
   * @param options - The options ioredis built the client with.
   */
  public constructor(private readonly options: IConnectorOptions) {
    super(options.disconnectTimeout ?? 0)
  }

  /**
   * Opens the socket.
   *
   * @returns The socket, a TLS socket when `tls` is set.
   * @throws {QueueException} `INVALID_OPTIONS` when `Object.prototype` holds a key it does not hold by
   *   default. ioredis ends a client whose connector rejects (status `end`, no retry), so the client is
   *   not used again.
   */
  public connect(): Promise<Socket> {
    const { options } = this
    this.connecting = true
    const target = Object.create(null) as Record<string, unknown>
    if (options.path) {
      target.path = options.path
    } else {
      // Stryker disable next-line ConditionalExpression: Node reads an own `undefined` port as an absent one (measured), so setting it always connects the same
      if (options.port != null) target.port = options.port
      // Stryker disable next-line ConditionalExpression: Node reads an own `undefined` or `null` host as an absent one (measured), so setting it always connects the same
      if (options.host != null) target.host = options.host
      // Stryker disable next-line ConditionalExpression: Node reads an own `undefined` or `null` family as an absent one (measured), so setting it always connects the same
      if (options.family != null) target.family = options.family
    }
    if (options.tls) Object.assign(target, options.tls)

    return new Promise<Socket>((resolve, reject) => {
      process.nextTick(() => {
        if (!this.connecting) {
          reject(new Error(CONNECTION_CLOSED_MESSAGE))
          return
        }
        try {
          assertPrototypeClean()
          this.stream = options.tls
            ? tlsConnect(target as unknown as ConnectionOptions)
            : createConnection(target as unknown as { path: string })
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        sealListeners(this.stream)
        this.stream.once('error', (error: Error) => {
          this.firstError = error
        })
        resolve(this.stream)
      })
    })
  }
}

/** The address of a sentinel as ioredis hands it to the client that asks it. */
interface ISentinelEndpoint {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly family?: number | undefined
}

/** A connector with a `connect()` that can be wrapped, and the sentinel connector's probe. */
interface IWrappableConnector {
  connect: (...args: never[]) => Promise<unknown>
  options: RedisOptions
  connectToSentinel: (endpoint: ISentinelEndpoint, probeOptions?: object) => Redis
}

/**
 * The client ioredis opens to ask one sentinel for the master, built as ioredis builds it but with
 * the guarded connector and the own keys: the default one would open its socket from an ordinary
 * object and send the sentinel password wherever a planted `path` points.
 */
function guardedProbe(
  options: RedisOptions,
  endpoint: ISentinelEndpoint,
  probeOptions?: object,
): Redis {
  return new Redis(
    withOwnKeys({
      port: endpoint.port ?? 26379,
      host: endpoint.host,
      username: options.sentinelUsername ?? null,
      password: options.sentinelPassword ?? null,
      family: endpoint.family ?? ('path' in options && options.path ? undefined : options.family),
      tls: options.sentinelTLS,
      retryStrategy: null,
      enableReadyCheck: false,
      protocol: options.protocol,
      replyMapping: 'legacy',
      connectTimeout: options.connectTimeout,
      commandTimeout: options.sentinelCommandTimeout,
      ...probeOptions,
      Connector: GuardedConnector,
    }) as Omit<RedisOptions, 'replyMapping'>,
  )
}

/**
 * Runs the guard before every connect of the connector a sentinel client built for itself, which is
 * ioredis's own `SentinelConnector`, and again once it has resolved, and gives each client that connector
 * opens to ask a sentinel the guarded connector and the own keys: it asks the sentinels for the master
 * and then opens the socket from what they answered, an ordinary object Node reads with inheritance, so
 * a key planted while it waited is read there. A socket opened under a polluted `Object.prototype` is
 * destroyed before ioredis uses it and the connect is refused.
 *
 * @param client - A client built in sentinel mode and not yet connected: ioredis starts the first connect
 *   inside its constructor, so the caller builds it lazy and connects it after this.
 * @returns The same client.
 */
export function guardSentinelConnector<T extends object>(client: T): T {
  const connector = (client as { connector: IWrappableConnector }).connector
  const connect = connector.connect.bind(connector)
  connector.connectToSentinel = (endpoint, probeOptions) =>
    guardedProbe(connector.options, endpoint, probeOptions)
  connector.connect = async (...args): Promise<unknown> => {
    assertPrototypeClean()
    const stream = await connect(...args)
    sealListeners(stream as Socket)
    try {
      assertPrototypeClean()
    } catch (error) {
      ;(stream as { destroy: () => void }).destroy()
      throw error
    }
    return stream
  }
  return client
}
