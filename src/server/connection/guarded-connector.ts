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

import { AbstractConnector } from 'ioredis'

import { assertPrototypeClean } from './prototype-guard'

/**
 * The events Node emits on a socket that nobody listens to. An emitter with no listener for an event
 * looks it up on a plain object, so a string planted on `Object.prototype` after the guard ran would be
 * found there and end the process from inside `emit`. A listener that does nothing is registered
 * before the socket opens, so the lookup finds a function of ours.
 */
const IDLE_EVENTS = [
  'connectionAttempt',
  'connectionAttemptFailed',
  'connectionAttemptTimeout',
  'keylog',
  'lookup',
  'OCSPResponse',
  'secureConnect',
  'session',
] as const

/** A listener that does nothing. */
function idle(): void {
  // Nothing to do: the registration is the point.
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
        for (const event of IDLE_EVENTS) this.stream.on(event, idle)
        this.stream.once('error', (error: Error) => {
          this.firstError = error
        })
        resolve(this.stream)
      })
    })
  }
}

/** A connector with a `connect()` that can be wrapped. */
interface IWrappableConnector {
  connect: (...args: never[]) => Promise<unknown>
}

/**
 * Runs the guard before every connect of the connector a sentinel client built for itself, which is
 * ioredis's own `SentinelConnector`, and again once it has resolved: it asks the sentinels for the master
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
  connector.connect = async (...args): Promise<unknown> => {
    assertPrototypeClean()
    const stream = await connect(...args)
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
