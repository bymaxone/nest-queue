/**
 * @fileoverview Tests for `duplicateConnection` on a client in sentinel mode: the duplicate is built
 * lazy and its connector is guarded, so a key planted on `Object.prototype` after the source client
 * connected cannot redirect the duplicate's reconnect, checked with fakes and with a real sentinel
 * handshake over loopback sockets.
 * @layer server/utils
 */

import net from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { GuardedConnector, guardSentinelConnector } from '../connection/guarded-connector'
import { QueueException } from '../errors/queue-exception'
import { duplicateConnection } from './duplicate-connection'

/** The keys `Object.prototype` holds on this Node, taken before any test plants one. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

const closers: (() => void)[] = []

/** `duplicateConnection` with the logger and role these tests do not look at. */
const duplicate = (client: Redis): Redis => duplicateConnection(client, new Logger('test'), 'test')

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

/** Plant `name` on `Object.prototype` by plain assignment, so it is enumerable. */
function plant(name: string, value: unknown): void {
  ;(Object.prototype as Record<string, unknown>)[name] = value
}

/** The pieces of a fake source client and its duplicate. */
interface IFake {
  client: Redis
  duplicate: jest.Mock
  copy: {
    connector: { connect: (...args: unknown[]) => Promise<unknown> }
    duplicate: (override?: object) => unknown
  }
  connect: jest.Mock
  /** The `duplicate` of the copy as the client built it, before the guard wraps it. */
  copyDuplicate: jest.Mock
}

/** A fake client whose `duplicate` hands back a fake duplicate with a mock connector. */
function fakeClient(options: object | undefined): IFake {
  const connect = jest.fn()
  const copyDuplicate = jest
    .fn()
    .mockReturnValue({ connector: { connect }, duplicate: jest.fn(), on: jest.fn() })
  const copy = { connector: { connect }, duplicate: copyDuplicate, on: jest.fn() }
  const duplicate = jest.fn().mockReturnValue(copy)
  const client = (options === undefined ? { duplicate } : { options, duplicate }) as unknown
  return { client: client as Redis, duplicate, copy, connect, copyDuplicate }
}

/** The override object `duplicate` was called with. */
function overrideOf(fake: IFake): Record<string, unknown> {
  return (fake.duplicate.mock.calls[0] as unknown[])[0] as Record<string, unknown>
}

describe('duplicateConnection on a client with sentinels', () => {
  const sentinels = [{ host: '127.0.0.1', port: 26379 }]

  it('duplicates lazy with the blocking-connection policy', () => {
    const fake = fakeClient({ sentinels })

    const result = duplicate(fake.client)

    expect(result).toBe(fake.copy)
    expect(fake.duplicate).toHaveBeenCalledTimes(1)
    const override = overrideOf(fake)
    expect(override).toEqual({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      commandTimeout: undefined,
      lazyConnect: true,
    })
    expect('commandTimeout' in override).toBe(true)
  })

  it('builds a duplicate of the duplicate lazy too, whatever override it is given', () => {
    const fake = fakeClient({ sentinels })
    const copy = duplicate(fake.client) as unknown as IFake['copy']

    const second = copy.duplicate({ maxRetriesPerRequest: 3 })

    expect(second).toBe(fake.copyDuplicate.mock.results[0]?.value)
    expect(fake.copyDuplicate).toHaveBeenCalledWith({ maxRetriesPerRequest: 3, lazyConnect: true })
    copy.duplicate()
    expect(fake.copyDuplicate).toHaveBeenLastCalledWith({ lazyConnect: true })
  })

  it('guards the connector of the duplicate of the duplicate', async () => {
    const fake = fakeClient({ sentinels })
    const copy = duplicate(fake.client) as unknown as IFake['copy']
    const second = copy.duplicate({}) as IFake['copy']
    plant('path', '/nowhere')

    let error: unknown
    try {
      error = await second.connector.connect().catch((e: unknown) => e)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path')
    }

    expect(codeOf(error)).toBe('queue.invalid_options')
    expect(fake.connect).not.toHaveBeenCalled()
  })

  it('refuses a connect while a key is planted, before the original connect runs', async () => {
    const fake = fakeClient({ sentinels })
    const copy = duplicate(fake.client) as unknown as IFake['copy']
    plant('path', '/nowhere')

    let error: unknown
    try {
      error = await copy.connector.connect().catch((e: unknown) => e)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path')
    }

    expect(codeOf(error)).toBe('queue.invalid_options')
    expect(fake.connect).not.toHaveBeenCalled()
  })

  it('calls the original connect once and passes the stream through when clean', async () => {
    const stream = { destroy: jest.fn() }
    const fake = fakeClient({ sentinels })
    fake.connect.mockResolvedValue(stream)
    const copy = duplicate(fake.client) as unknown as IFake['copy']

    const result: unknown = await copy.connector.connect('emitter')

    expect(result).toBe(stream)
    expect(fake.connect).toHaveBeenCalledTimes(1)
    expect(fake.connect).toHaveBeenCalledWith('emitter')
    expect(stream.destroy).not.toHaveBeenCalled()
  })
})

describe('duplicateConnection on a client without sentinels', () => {
  it.each([
    ['empty options', {}],
    ['no options at all', undefined],
  ])('duplicates as before, with no lazy override and no wrapping: %s', (_name, options) => {
    const fake = fakeClient(options)

    const result = duplicate(fake.client)

    expect(result).toBe(fake.copy)
    const override = overrideOf(fake)
    expect(override).toEqual({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      commandTimeout: undefined,
    })
    expect('lazyConnect' in override).toBe(false)
    expect(fake.copy.connector.connect).toBe(fake.connect)
  })
})

/** One RESP command parsed out of `text`: its arguments and the rest of the text, or undefined. */
function parseCommand(text: string): { args: string[]; rest: string } | undefined {
  const header = /^\*(\d+)\r\n/.exec(text)
  if (!header) return undefined
  const args: string[] = []
  let rest = text.slice(header[0].length)
  for (let i = 0; i < Number(header[1]); i += 1) {
    const bulk = /^\$(\d+)\r\n/.exec(rest)
    if (!bulk) return undefined
    const start = bulk[0].length
    const end = start + Number(bulk[1])
    if (rest.length < end + 2) return undefined
    args.push(rest.slice(start, end))
    rest = rest.slice(end + 2)
  }
  return { args, rest }
}

/** A RESP bulk string. */
function bulk(text: string): string {
  return `$${String(text.length)}\r\n${text}\r\n`
}

/** Serve a Redis-like reply to every command on `socket`, using `reply` to choose it. */
function serve(socket: Socket, reply: (args: string[]) => string): void {
  socket.on('error', () => undefined)
  let pending = ''
  socket.on('data', (chunk: Buffer) => {
    pending += chunk.toString('latin1')
    for (let next = parseCommand(pending); next; next = parseCommand(pending)) {
      pending = next.rest
      socket.write(reply(next.args))
    }
  })
}

/** The reply of a fake master: INFO, PING, ROLE and `+OK` for the rest. */
function masterReply(args: string[]): string {
  const name = args[0]?.toUpperCase()
  if (name === 'INFO') {
    return bulk('# Server\r\nredis_version:7.2.0\r\nloading:0\r\nrole:master\r\n')
  }
  if (name === 'PING') return '+PONG\r\n'
  if (name === 'ROLE') return '*1\r\n' + bulk('master')
  return '+OK\r\n'
}

/** The reply of a fake sentinel that says the master is at `port`. */
function sentinelReply(port: number): (args: string[]) => string {
  return (args) => {
    const name = args[0]?.toUpperCase()
    const sub = args[1]?.toLowerCase()
    if (name === 'SENTINEL' && sub === 'get-master-addr-by-name') {
      return '*2\r\n' + bulk('127.0.0.1') + bulk(String(port))
    }
    if (name === 'SENTINEL' && sub === 'sentinels') return '*0\r\n'
    if (name === 'SUBSCRIBE') return '*3\r\n' + bulk('subscribe') + bulk(args[1] ?? '') + ':1\r\n'
    return masterReply(args)
  }
}

/** Listen on a loopback port with `handler` on every socket; closed after the test. */
async function listenTcp(handler: (socket: Socket) => void): Promise<number> {
  const server = net.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => {
    server.close()
  })
  return (server.address() as { port: number }).port
}

/** A unix-socket server that counts what it is asked for; closed after the test. */
async function listenCounting(): Promise<{
  path: string
  seen: () => number
  bytes: () => number
}> {
  let count = 0
  let received = 0
  const server: Server = net.createServer((socket) => {
    count += 1
    socket.on('error', () => undefined)
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length
    })
    socket.destroy()
  })
  const path = join(tmpdir(), `bymax-queue-dup-${String(process.pid)}.sock`)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  closers.push(() => {
    server.close()
  })
  return { path, seen: () => count, bytes: () => received }
}

/** Resolve when `client` is ready. */
function ready(client: Redis): Promise<void> {
  return new Promise<void>((resolve) => {
    client.once('ready', () => {
      resolve()
    })
  })
}

/** A real sentinel client and its duplicate, both ready, against fake sentinel and master servers. */
async function connectedPair(): Promise<{ client: Redis; copy: Redis }> {
  const master = await listenTcp((socket) => {
    serve(socket, masterReply)
  })
  const sentinel = await listenTcp((socket) => {
    serve(socket, sentinelReply(master))
  })
  const client = new Redis({
    sentinels: [{ host: '127.0.0.1', port: sentinel }],
    name: 'mymaster',
    lazyConnect: true,
    retryStrategy: () => 50,
    sentinelRetryStrategy: () => 50,
    disconnectTimeout: 20,
  })
  closers.push(() => {
    client.disconnect()
  })
  client.on('error', () => undefined)
  const up = ready(client)
  await client.connect()
  await up
  const copy = duplicate(client)
  closers.push(() => {
    copy.disconnect()
  })
  copy.on('error', () => undefined)
  const copyUp = ready(copy)
  await copy.connect()
  await copyUp
  return { client, copy }
}

/**
 * Force a reconnect of `copy` and report how it ended up: `ready`, or the error that ended it. An error
 * that leaves the client retrying (ioredis reports "all sentinels are unreachable" once on every
 * reconnect, then asks again) is not the end of it.
 */
function reconnect(copy: Redis): Promise<Error | 'ready'> {
  const errors: Error[] = []
  const next = new Promise<Error | 'ready'>((resolve) => {
    copy.on('error', (error: Error) => errors.push(error))
    copy.once('ready', () => {
      resolve('ready')
    })
    copy.once('end', () => {
      resolve(
        errors.find((e) => e instanceof QueueException) ?? errors.at(-1) ?? new Error('ended'),
      )
    })
  })
  copy.disconnect(true)
  return next
}

describe('a duplicate of a real sentinel client', () => {
  it('is built unconnected, and reaches ready after the handshake', async () => {
    const { client, copy } = await connectedPair()

    expect(client.status).toBe('ready')
    expect(copy.status).toBe('ready')
    expect(copy.options.lazyConnect).toBe(true)
    expect(copy.options.maxRetriesPerRequest).toBeNull()
  })

  it('reconnects to the master when nothing is planted (control)', async () => {
    const { copy } = await connectedPair()

    const outcome = await reconnect(copy)

    expect(outcome).toBe('ready')
    expect(copy.status).toBe('ready')
  })

  it('ends with INVALID_OPTIONS on a reconnect under a planted path, and opens no socket to it', async () => {
    const unix = await listenCounting()
    const { copy } = await connectedPair()
    plant('path', unix.path)

    let outcome: Error | 'ready'
    try {
      outcome = await reconnect(copy)
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path')
    }

    expect(codeOf(outcome)).toBe('queue.invalid_options')
    expect(copy.status).toBe('end')
    expect(unix.seen()).toBe(0)
  })
})

describe('a duplicate of the duplicate of a real sentinel client', () => {
  it('is built lazy, reaches ready, and ends with INVALID_OPTIONS on a reconnect under a planted path', async () => {
    const unix = await listenCounting()
    const { copy } = await connectedPair()
    const second = copy.duplicate({})
    closers.push(() => {
      second.disconnect()
    })
    second.on('error', () => undefined)
    const wasLazy = second.status
    const up = ready(second)
    await second.connect()
    await up
    plant('path', unix.path)

    let outcome: Error | 'ready'
    try {
      outcome = await reconnect(second)
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path')
    }

    expect(wasLazy).toBe('wait')
    expect(codeOf(outcome)).toBe('queue.invalid_options')
    expect(second.status).toBe('end')
    expect(unix.seen()).toBe(0)
  })
})

/** A fake server and every command it received, in order. */
interface IRecording {
  port: number
  commands: string[][]
}

/** Listen on a loopback port, answer with `reply`, and keep every command received. */
async function listenRecording(reply: (args: string[]) => string): Promise<IRecording> {
  const commands: string[][] = []
  const port = await listenTcp((socket) => {
    serve(socket, (args) => {
      commands.push(args)
      return reply(args)
    })
  })
  return { port, commands }
}

/** A recording fake master and a recording fake sentinel that points at it. */
async function recordedPair(): Promise<{ master: IRecording; sentinel: IRecording }> {
  const master = await listenRecording(masterReply)
  const sentinel = await listenRecording(sentinelReply(master.port))
  return { master, sentinel }
}

/** The sentinel client of the handshake rows: lazy, with a sentinel password, not yet guarded. */
function sentinelClient(sentinelPort: number): Redis {
  const client = new Redis({
    sentinels: [{ host: '127.0.0.1', port: sentinelPort }],
    name: 'mymaster',
    sentinelPassword: 'sentinel-secret',
    lazyConnect: true,
    retryStrategy: () => 50,
    sentinelRetryStrategy: () => 50,
    disconnectTimeout: 20,
  })
  closers.push(() => {
    client.disconnect()
  })
  client.on('error', () => undefined)
  return client
}

/**
 * The commands in `commands` that carry the sentinel password. ioredis speaks RESP3 by default, so the
 * probe hands its credentials over in `HELLO 3 AUTH <user> <password>` rather than in an `AUTH`.
 */
function authsOf(commands: string[][]): string[][] {
  return commands.filter((c) => c.includes('sentinel-secret'))
}

/** The probe builder of a guarded sentinel client. */
interface ProbeBuilder {
  connectToSentinel(endpoint: { host: string; port: number }): Redis
}

/** Build the probe the guarded connector of `client` opens toward `port`, owned by this test. */
function probeOf(client: Redis, port: number): Redis {
  const probe = (client as unknown as { connector: ProbeBuilder }).connector.connectToSentinel({
    host: '127.0.0.1',
    port,
  })
  closers.push(() => {
    probe.disconnect()
  })
  return probe
}

describe('the probe a guarded sentinel client opens to ask a sentinel', () => {
  it('reaches the master through a probe built with the guarded connector, password sent', async () => {
    const { master, sentinel } = await recordedPair()
    const probes = jest.spyOn(GuardedConnector.prototype, 'connect')
    const client = guardSentinelConnector(sentinelClient(sentinel.port))
    const up = ready(client)

    await client.connect()
    await up

    expect(client.status).toBe('ready')
    expect(await client.ping()).toBe('PONG')
    expect(probes).toHaveBeenCalled()
    expect(authsOf(sentinel.commands)).toHaveLength(1)
    expect(authsOf(master.commands)).toEqual([])
    expect(sentinel.commands.some((c) => c[1]?.toLowerCase() === 'get-master-addr-by-name')).toBe(
      true,
    )
    probes.mockRestore()
  })

  it('sends the sentinel password to the sentinel when nothing is planted (control)', async () => {
    const { sentinel } = await recordedPair()
    const client = guardSentinelConnector(sentinelClient(sentinel.port))
    const probe = probeOf(client, sentinel.port)
    probe.on('error', () => undefined)

    expect(await probe.ping()).toBe('PONG')

    expect(authsOf(sentinel.commands)).toHaveLength(1)
  })

  it('refuses to open the probe under a path planted after the wrapper checked, sending nothing', async () => {
    const unix = await listenCounting()
    const { sentinel } = await recordedPair()
    const client = guardSentinelConnector(sentinelClient(sentinel.port))
    plant('path', unix.path)

    let probe: Redis
    const failure = new Promise<unknown>((resolve) => {
      probe = probeOf(client, sentinel.port)
      probe.once('error', resolve)
    })
    let error: unknown
    try {
      error = await failure
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      Reflect.deleteProperty(Object.prototype, 'path')
    }

    expect(codeOf(error)).toBe('queue.invalid_options')
    expect(unix.seen()).toBe(0)
    expect(unix.bytes()).toBe(0)
    expect(authsOf(sentinel.commands)).toEqual([])
  })
})
