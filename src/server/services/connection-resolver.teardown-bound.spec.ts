/**
 * @fileoverview The owned client's quit on shutdown is bounded. A server that accepts the
 * connection and never answers is what a frozen Redis looks like to the client, and ioredis only
 * gives up on the quit at its own command deadline, which a derived backend may have set far
 * longer than a shutdown can wait. Real sockets and real ioredis.
 * @layer server/services
 */

import { createServer, type Server } from 'node:net'
import { ConnectionResolver } from './connection-resolver.service'

const servers: Server[] = []

afterEach(async () => {
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

/** A server that reads and never replies; the port it listens on. */
async function silentServer(): Promise<number> {
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    socket.resume()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

/** A started resolver on the silent server, with a command deadline of one minute. */
async function resolverOnSilent(): Promise<ConnectionResolver> {
  const port = await silentServer()
  const resolver = new ConnectionResolver({
    connection: {
      url: `redis://127.0.0.1:${String(port)}`,
      // No ready check, no HELLO and no CLIENT SETINFO, so the client is ready on connect and no
      // answer is needed to start.
      options: {
        enableReadyCheck: false,
        protocol: 2,
        disableClientInfo: true,
        retryStrategy: () => null,
      },
    },
    commandTimeoutMs: 60_000,
  })
  await resolver.init()
  return resolver
}

describe('ConnectionResolver.teardown against a Redis that never answers', () => {
  // With no bound of its own the quit would wait the minute out: the test timeout fails it.
  it('completes within the bound it is given, and ends the client', async () => {
    const resolver = await resolverOnSilent()
    const client = resolver.getClient()
    const ended = new Promise<void>((resolve) => {
      client.once('end', () => {
        resolve()
      })
    })

    await expect(resolver.teardown(300)).resolves.toBeUndefined()
    await ended

    expect(client.status).toBe('end')
  })
})
