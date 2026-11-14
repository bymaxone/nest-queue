/**
 * @fileoverview The forced disconnect of a client with no open stream leaves no 2 s timer behind.
 * ioredis arms a teardown timer (`disconnectTimeout`, 2 000 ms by default) on `disconnect()` and
 * clears it only when the stream emits `close`; a client that is reconnecting has no stream to
 * close, so the timer outlives the shutdown and holds the host process. Real ioredis, with the
 * timer function spied so every delay it is given can be read.
 * @layer server/services
 */

import { createServer, type Server } from 'node:net'
import { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'

const servers: Server[] = []
const clients: Redis[] = []

afterEach(async () => {
  jest.restoreAllMocks()
  for (const client of clients.splice(0)) client.disconnect()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        }),
    ),
  )
})

/** A server that accepts and never replies, with no ready check or handshake needed to start. */
async function silentServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    socket.resume()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, server }
}

const STARTUP = { enableReadyCheck: false, protocol: 2, disableClientInfo: true } as const

/** A started resolver whose server has gone: the client is reconnecting, with no stream. */
async function reconnectingResolver(
  options: Record<string, unknown> = {},
): Promise<ConnectionResolver> {
  const { port, server } = await silentServer()
  const resolver = new ConnectionResolver({
    connection: { url: `redis://127.0.0.1:${String(port)}`, options: { ...STARTUP, ...options } },
  })
  await resolver.init()
  const client = resolver.getClient()
  const dropped = new Promise<void>((resolve) => {
    client.once('close', () => {
      resolve()
    })
  })
  server.close()
  client.stream.destroy()
  await dropped
  return resolver
}

/** Every delay a timer was armed with while `work` ran. */
async function timerDelaysDuring(work: () => Promise<void>): Promise<unknown[]> {
  const spy = jest.spyOn(global, 'setTimeout')
  await work()
  return spy.mock.calls.map((call) => call[1])
}

describe('ConnectionResolver teardown of a reconnecting client', () => {
  it('arms the short teardown timer and no 2 000 ms one', async () => {
    const resolver = await reconnectingResolver()
    const client = resolver.getClient()
    expect(client.status).toBe('reconnecting')

    const delays = await timerDelaysDuring(() => resolver.teardown(5_000))

    // The forced disconnect armed ioredis's teardown timer with the short value, and no other.
    expect(delays).toContain(1)
    expect(delays).not.toContain(2_000)
  })

  it('keeps a disconnectTimeout the host chose', async () => {
    const resolver = await reconnectingResolver({ disconnectTimeout: 500 })

    const delays = await timerDelaysDuring(() => resolver.teardown(5_000))

    expect(resolver.getClient().options.disconnectTimeout).toBe(500)
    expect(delays).toContain(500)
  })
})

describe('duplicateConnection disconnectTimeout', () => {
  const base = { ...STARTUP, lazyConnect: true }

  it('passes the short value of a library-opened client on to its duplicates', async () => {
    const resolver = await reconnectingResolver()

    const duplicate = duplicateConnection(resolver.getClient())
    clients.push(duplicate)

    expect(duplicate.options.disconnectTimeout).toBe(1)
    await resolver.teardown(5_000)
  })

  it.each([500, 2_000])('leaves a duplicate of a host client at the host value %i', (value) => {
    const host = new Redis({ ...base, disconnectTimeout: value })
    clients.push(host)

    const duplicate = duplicateConnection(host)
    clients.push(duplicate)

    expect(duplicate.options.disconnectTimeout).toBe(value)
  })
})
