/**
 * @fileoverview Tests for the connector the resolver gives ioredis, over real sockets: a TCP server, a
 * unix-socket server and, when `openssl` is on the PATH, a TLS server. A key planted on
 * `Object.prototype` after the client was built must reach no socket, on a first connect and on a
 * reconnect, and the guard on the sentinel connector refuses before and after the connect.
 * @layer server/connection
 */

import { execFileSync } from 'node:child_process'
import net from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { Redis } from 'ioredis'
import { QueueException } from '../errors/queue-exception'
import { GuardedConnector, guardSentinelConnector } from './guarded-connector'

/** The keys `Object.prototype` holds on this Node, taken before any test plants one. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

const closers: (() => void)[] = []

afterEach(() => {
  for (const close of closers.splice(0)) close()
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD.has(n))
  for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
  if (extra.length > 0) throw new Error('a test left a key on Object.prototype')
})

/** The `INVALID_OPTIONS` code a refusal carries. */
function codeOf(error: unknown): string | undefined {
  return error instanceof QueueException
    ? (error.getResponse() as { error: { code: string } }).error.code
    : undefined
}

/** One RESP command per array header. */
const COMMAND_START = /(?=\*\d+\r\n\$)/

/** Answers INFO and PING, and every other command a connecting client sends with `+OK`. */
function answer(socket: Socket): void {
  socket.on('error', () => undefined)
  socket.on('data', (chunk: Buffer) => {
    for (const command of chunk.toString('latin1').split(COMMAND_START)) {
      const name = /^\*\d+\r\n\$\d+\r\n(\w+)\r\n/.exec(command)?.[1]?.toUpperCase()
      if (name === 'INFO') {
        const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n'
        socket.write(`$${String(info.length)}\r\n${info}\r\n`)
      } else if (name === 'PING') {
        socket.write('+PONG\r\n')
      } else {
        socket.write('+OK\r\n')
      }
    }
  })
}

/** Listen on a TCP port of the loopback; the server is closed after the test. */
async function listenOnPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return (server.address() as { port: number }).port
}

/** Listen on a unix socket; the server is closed after the test. */
async function listenOnPath(server: Server, name: string): Promise<string> {
  const path = join(tmpdir(), `bymax-queue-${String(process.pid)}-${name}.sock`)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  closers.push(() => server.close())
  return path
}

/** Run `run` with `name` planted on `Object.prototype`, and take it off again. */
async function planted<T>(name: string, value: unknown, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(Object.prototype, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(Object.prototype, name)
  }
}

/** What `connect()` settles to: the stream, or the error it was refused with. */
async function settle(connector: GuardedConnector): Promise<{ stream?: Socket; error?: unknown }> {
  try {
    return { stream: await connector.connect() }
  } catch (error) {
    return { error }
  }
}

/** The options object a spied call was handed. */
function firstArg(spy: jest.SpyInstance): object {
  return (spy.mock.calls[0] as unknown[])[0] as object
}

/** Wait until a stream connected or failed. */
function opened(stream: Socket | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    stream?.once('connect', () => {
      resolve()
    })
    stream?.once('error', () => {
      resolve()
    })
    if (stream === undefined) resolve()
  })
}

/** A server that counts the connections it receives and drops them. */
function counting(): { server: Server; seen: () => number } {
  let count = 0
  const server = net.createServer((socket) => {
    count += 1
    socket.on('error', () => undefined)
    socket.destroy()
  })
  return { server, seen: () => count }
}

/** Whether `openssl` is on the PATH. */
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('the connector, run by hand', () => {
  it('connects to a port', async () => {
    const port = await listenOnPort(net.createServer(answer))
    const connector = new GuardedConnector({ host: '127.0.0.1', port, family: 4 })

    const { stream, error } = await settle(connector)
    await opened(stream)

    expect(error).toBeUndefined()
    expect(stream?.remotePort).toBe(port)
    connector.disconnect()
  })

  it('connects to a unix socket when it has a path, ignoring the port', async () => {
    const path = await listenOnPath(net.createServer(answer), 'own')
    const connector = new GuardedConnector({ path, port: 1, host: 'nowhere.invalid' })

    const { stream, error } = await settle(connector)
    await opened(stream)

    expect(error).toBeUndefined()
    expect(stream?.remoteAddress).toBeUndefined()
    expect(stream?.connecting).toBe(false)
    // Reached the socket at the path, not the host and port next to it, which could not be reached.
    expect(stream?.readyState).toBe('open')
    connector.disconnect()
  })

  it('hands Node an object with no prototype, with only the names the options hold', async () => {
    const port = await listenOnPort(net.createServer(answer))
    const spy = jest.spyOn(net, 'createConnection')
    const connector = new GuardedConnector({ host: '127.0.0.1', port })

    const { stream } = await settle(connector)
    await opened(stream)

    const handed = firstArg(spy)
    expect(Object.getPrototypeOf(handed)).toBeNull()
    expect(Object.keys(handed).sort()).toEqual(['host', 'port'])
    connector.disconnect()
  })

  it('hands Node no name the options leave out or hold as null', async () => {
    const port = await listenOnPort(net.createServer(answer))
    const spy = jest.spyOn(net, 'createConnection')
    const options = { host: null, port, family: null } as unknown as ConstructorParameters<
      typeof GuardedConnector
    >[0]
    const connector = new GuardedConnector(options)

    const { stream, error } = await settle(connector)
    await opened(stream)

    expect(error).toBeUndefined()
    expect(Object.keys(firstArg(spy))).toEqual(['port'])
    connector.disconnect()
  })

  it('hands Node no port when the options hold none', async () => {
    const spy = jest.spyOn(net, 'createConnection')
    const connector = new GuardedConnector({ host: '127.0.0.1' })

    const { error } = await settle(connector)

    expect(Object.keys(firstArg(spy))).toEqual(['host'])
    expect((error as Error).message).toContain('ERR_')
  })

  it('refuses with the error when the socket cannot be opened, whatever was thrown', async () => {
    jest.spyOn(net, 'createConnection').mockImplementation(() => {
      const thrown: unknown = 'not an error object'
      throw thrown
    })

    const { error } = await settle(new GuardedConnector({ host: '127.0.0.1', port: 1 }))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('not an error object')
  })

  it('takes its disconnect timeout from the options, and has none by default', () => {
    const given = new GuardedConnector({ host: 'h', disconnectTimeout: 7 })
    const absent = new GuardedConnector({ host: 'h' })

    expect((given as unknown as { disconnectTimeout: number }).disconnectTimeout).toBe(7)
    expect((absent as unknown as { disconnectTimeout: number }).disconnectTimeout).toBe(0)
  })

  it('is refused with the text of ioredis when it is disconnected before the socket opens', async () => {
    const connector = new GuardedConnector({ host: '127.0.0.1', port: 1 })
    const pending = settle(connector)
    connector.disconnect()

    const { stream, error } = await pending

    expect(stream).toBeUndefined()
    expect((error as Error).message).toBe('Connection is closed.')
  })

  it('keeps the first error of the stream', async () => {
    const free = net.createServer()
    const port = await listenOnPort(free)
    await new Promise<void>((resolve) =>
      free.close(() => {
        resolve()
      }),
    )
    const connector = new GuardedConnector({ host: '127.0.0.1', port })

    const { stream } = await settle(connector)
    await opened(stream)

    expect((connector.firstError as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
  })
})

describe('the connector with a key planted on Object.prototype after the client was built', () => {
  it('refuses to connect, and a planted path reaches no socket', async () => {
    const unix = counting()
    const path = await listenOnPath(unix.server, 'planted')
    const port = await listenOnPort(net.createServer(answer))
    const spy = jest.spyOn(net, 'createConnection')
    const connector = new GuardedConnector({ host: '127.0.0.1', port })

    const { stream, error } = await planted('path', path, () => settle(connector))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(stream).toBeUndefined()
    expect(codeOf(error)).toBe('queue.invalid_options')
    expect((error as QueueException).getResponse()).toMatchObject({
      error: { details: { count: 1 } },
    })
    expect(JSON.stringify(error)).not.toContain(path)
    expect(unix.seen()).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('a real client built with the connector', () => {
  /** The first of `ready` and `error` the client emits next, as `ready` or the error. */
  function nextOutcome(client: Redis): Promise<'ready' | Error> {
    return new Promise((resolve) => {
      client.once('ready', () => {
        resolve('ready')
      })
      client.once('error', (error: Error) => {
        resolve(error)
      })
    })
  }

  /** A client over a port, through the guarded connector. */
  function build(port: number): Redis {
    const client = new Redis({
      host: '127.0.0.1',
      port,
      Connector: GuardedConnector,
      retryStrategy: () => 50,
      disconnectTimeout: 20,
    } as never)
    closers.push(() => {
      client.disconnect()
    })
    client.on('error', () => undefined)
    return client
  }

  it('becomes ready, and again after a reconnect, when nothing is planted', async () => {
    const port = await listenOnPort(net.createServer(answer))
    const client = build(port)
    expect(await nextOutcome(client)).toBe('ready')

    const again = nextOutcome(client)
    client.disconnect(true)

    expect(await again).toBe('ready')
    expect(await client.ping()).toBe('PONG')
  })

  it('does not reconnect to a planted path: the unix socket sees nothing and the client ends', async () => {
    const unix = counting()
    const path = await listenOnPath(unix.server, 'reconnect')
    const port = await listenOnPort(net.createServer(answer))
    const client = build(port)
    expect(await nextOutcome(client)).toBe('ready')

    const outcome = await planted('path', path, () => {
      const next = nextOutcome(client)
      client.disconnect(true)
      return next
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(codeOf(outcome)).toBe('queue.invalid_options')
    expect(unix.seen()).toBe(0)
    expect(client.status).toBe('end')
  })
})

/** The self-signed certificate and its key. */
interface IPair {
  certificate: string
  key: string
}

/** Make a throwaway certificate for `localhost` and `127.0.0.1` with `openssl`. */
function makePair(): IPair {
  const pem = execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      '/dev/stdout',
      '-out',
      '/dev/stdout',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  return {
    certificate:
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0] ?? '',
    key:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/.exec(pem)?.[0] ??
      '',
  }
}

/** Whether the TLS handshake of `stream` completed. */
function secured(stream: Socket | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    stream?.once('secureConnect', () => {
      resolve(true)
    })
    stream?.once('error', () => {
      resolve(false)
    })
  })
}

/** Listen with a TLS server that answers like a Redis server. */
function listenTls(pair: IPair): Promise<number> {
  return listenOnPort(tls.createServer({ key: pair.key, cert: pair.certificate }, answer))
}

/** The connector connects with the TLS options of the host. */
async function tlsConnects(pair: IPair): Promise<void> {
  const port = await listenTls(pair)
  const spy = jest.spyOn(tls, 'connect')
  const connector = new GuardedConnector({
    host: '127.0.0.1',
    port,
    tls: { ca: pair.certificate, servername: 'localhost' },
  })

  const { stream, error } = await settle(connector)
  const ok = await secured(stream)

  expect(error).toBeUndefined()
  expect(ok).toBe(true)
  expect(Object.getPrototypeOf(firstArg(spy))).toBeNull()
  connector.disconnect()
}

/** A server whose certificate the host never gave is not trusted. */
async function tlsDistrusts(pair: IPair): Promise<void> {
  const port = await listenTls(pair)
  const connector = new GuardedConnector({
    host: '127.0.0.1',
    port,
    tls: { servername: 'localhost' },
  })

  const { stream } = await settle(connector)
  const ok = await secured(stream)

  expect(ok).toBe(false)
  connector.disconnect()
}

/** A planted `ca` is refused before any socket opens. */
async function tlsRefusesPlantedCa(pair: IPair): Promise<void> {
  const port = await listenTls(pair)
  const spy = jest.spyOn(tls, 'connect')
  const connector = new GuardedConnector({
    host: '127.0.0.1',
    port,
    tls: { servername: 'localhost' },
  })

  const { stream, error } = await planted('ca', pair.certificate, () => settle(connector))

  expect(stream).toBeUndefined()
  expect(codeOf(error)).toBe('queue.invalid_options')
  expect(spy).not.toHaveBeenCalled()
}

/** A real TLS client that reconnects with a planted `ca` ends. */
async function tlsEndsOnPlantedCa(pair: IPair): Promise<void> {
  const port = await listenTls(pair)
  const client = new Redis({
    host: '127.0.0.1',
    port,
    tls: { ca: pair.certificate, servername: 'localhost' },
    Connector: GuardedConnector,
    retryStrategy: () => 50,
    disconnectTimeout: 20,
  } as never)
  closers.push(() => {
    client.disconnect()
  })
  client.on('error', () => undefined)
  await new Promise<void>((resolve) =>
    client.once('ready', () => {
      resolve()
    }),
  )

  const outcome = await planted('ca', pair.certificate, () => {
    const next = new Promise<Error | 'ready'>((resolve) => {
      client.once('ready', () => {
        resolve('ready')
      })
      client.once('error', (e: Error) => {
        resolve(e)
      })
    })
    client.disconnect(true)
    return next
  })

  expect(codeOf(outcome)).toBe('queue.invalid_options')
  expect(client.status).toBe('end')
}

describe('the connector over TLS', () => {
  /** `describe` only when `openssl` can make the certificate; otherwise the skip is explicit. */
  const describeTls = hasOpenssl() ? describe : describe.skip
  let pair: IPair = { certificate: '', key: '' }

  describeTls('with a certificate made by openssl', () => {
    beforeAll(() => {
      pair = makePair()
    })

    it('connects with the TLS options of the host, and hands Node an object with no prototype', () =>
      tlsConnects(pair))
    it('does not trust a server whose certificate the host never gave', () => tlsDistrusts(pair))
    it('refuses with a planted ca, so the planted certificate makes no server trusted', () =>
      tlsRefusesPlantedCa(pair))
    it('ends a real TLS client that reconnects with a planted ca', () => tlsEndsOnPlantedCa(pair))
  })
})

describe('the guard on the connector a sentinel client builds for itself', () => {
  /** A fake client whose connector connects through `connect`. */
  function fake(connect: jest.Mock): {
    connector: { connect: (...a: never[]) => Promise<unknown> }
  } {
    return { connector: { connect } }
  }

  /** Call the wrapped connect. */
  function callWrapped(client: ReturnType<typeof fake>, ...args: unknown[]): Promise<unknown> {
    return (client.connector.connect as (...a: unknown[]) => Promise<unknown>)(...args)
  }

  it('returns the client itself', () => {
    const client = fake(jest.fn())

    expect(guardSentinelConnector(client)).toBe(client)
  })

  it('passes the stream through, and the arguments, when nothing is planted', async () => {
    const stream = { destroy: jest.fn() }
    const original = jest.fn().mockResolvedValue(stream)
    const client = fake(original)
    guardSentinelConnector(client)

    const result = await callWrapped(client, 'emitter')

    expect(result).toBe(stream)
    expect(original).toHaveBeenCalledWith('emitter')
    expect(stream.destroy).not.toHaveBeenCalled()
  })

  it('cuts the listener table of the stream from Object.prototype once the connect resolved', async () => {
    const listeners = { error: [] as unknown[] }
    const stream = { destroy: jest.fn(), _events: listeners }
    const client = fake(jest.fn().mockResolvedValue(stream))
    guardSentinelConnector(client)

    await callWrapped(client)

    expect(Object.getPrototypeOf(stream._events)).toBeNull()
    expect(stream._events).toBe(listeners)
  })

  it('refuses before the connect it wraps runs when a key is planted', async () => {
    const original = jest.fn().mockResolvedValue({ destroy: jest.fn() })
    const client = fake(original)
    guardSentinelConnector(client)

    const error = await planted('anything', 1, () => callWrapped(client).catch((e: unknown) => e))

    expect(codeOf(error)).toBe('queue.invalid_options')
    expect(original).not.toHaveBeenCalled()
  })

  it('destroys the socket and refuses when a key was planted while the connect waited', async () => {
    const stream = { destroy: jest.fn() }
    const original = jest.fn(async () => {
      Object.defineProperty(Object.prototype, 'path', { value: 'x', configurable: true })
      await Promise.resolve()
      return stream
    })
    const client = fake(original)
    guardSentinelConnector(client)

    let error: unknown
    try {
      await callWrapped(client)
    } catch (caught) {
      error = caught
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path')
    }

    expect(codeOf(error)).toBe('queue.invalid_options')
    expect(stream.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('GuardedConnector seals the table of listeners of its socket', () => {
  const EVENTS = [
    'OCSPResponse',
    'connectionAttempt',
    'connectionAttemptFailed',
    'connectionAttemptTimeout',
    'drain',
    'end',
    'finish',
    'keylog',
    'lookup',
    'pause',
    'ready',
    'resume',
    'secureConnect',
    'session',
    'timeout',
  ]

  /** The server's own end of the connection is a Node stream too; keep the plant off its table. */
  function sealed(socket: Socket): void {
    Object.setPrototypeOf((socket as unknown as { _events: object })._events, null)
  }

  /** A socket from a connector over a listening server, with a host name to resolve. */
  async function open(options: { host: string } = { host: 'localhost' }): Promise<Socket> {
    const server = net.createServer((socket) => {
      sealed(socket)
      answer(socket)
    })
    const port = await listenOnPort(server)
    const { stream } = await settle(new GuardedConnector({ ...options, port }))
    if (stream === undefined) throw new Error('the connector refused')
    return stream
  }

  it('leaves the table of listeners of the socket with no prototype', async () => {
    const stream = await open()

    const table = (stream as unknown as { _events: object })._events

    expect(Object.getPrototypeOf(table)).toBeNull()
    stream.destroy()
  })

  /**
   * The `Object.prototype` of the realm Node's own streams are built in. Jest runs a test in a context
   * of its own, so the tables of listeners that Node creates inherit from this one and not from the
   * `Object.prototype` the test sees; planting there is what a process-wide pollution does to them.
   */
  async function nodeObjectPrototype(): Promise<object> {
    const probe = new net.Socket()
    const proto = Object.getPrototypeOf((probe as unknown as { _events: object })._events) as object
    const closed = new Promise<void>((resolve) =>
      probe.once('close', () => {
        resolve()
      }),
    )
    probe.destroy()
    await closed
    return proto
  }

  it('survives strings planted under many event names after the guard ran', async () => {
    const stream = await open()
    stream.on('error', () => undefined)
    const closed = new Promise<void>((resolve) =>
      stream.once('close', () => {
        resolve()
      }),
    )
    const proto = await nodeObjectPrototype()
    // The plant is on the prototype of the whole process, which outlives this test: a test that
    // times out never reaches its `finally`, so the cleanup of the file runs it as well.
    closers.push(() => {
      for (const event of EVENTS) Reflect.deleteProperty(proto, event)
    })
    for (const event of EVENTS) {
      Object.defineProperty(proto, event, { value: 'planted', configurable: true, writable: true })
    }
    try {
      await opened(stream)
      stream.destroy()
      await closed
    } finally {
      for (const event of EVENTS) Reflect.deleteProperty(proto, event)
    }

    expect(stream.destroyed).toBe(true)
  })

  it('leaves alone a stream that has no table of listeners to seal', async () => {
    const once = jest.fn()
    const spy = jest.spyOn(net, 'createConnection').mockReturnValue({ once } as unknown as Socket)

    const { stream } = await settle(new GuardedConnector({ host: '127.0.0.1', port: 1 }))

    expect(stream).toEqual({ once })
    expect(once).toHaveBeenCalledWith('error', expect.any(Function))
    spy.mockRestore()
  })

  it('still calls the listeners that were registered: connect and error', async () => {
    const stream = await open({ host: '127.0.0.1' })
    const seen: string[] = []
    stream.on('connect', () => seen.push('connect'))
    stream.on('error', () => seen.push('error'))

    stream.emit('connect')
    stream.emit('error', new Error('boom'))

    expect(seen).toEqual(['connect', 'error'])
    stream.destroy()
  })
})
