/**
 * @fileoverview Mode A null-retries probe against real ioredis clients and a real BullMQ worker.
 * @layer server/services
 */

import { createServer, type Server } from 'node:net'
import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'

// `connection-resolver.service.spec.ts` drives the probe with scripted fakes, so it can only show
// that the resolver reacts to the answer it was handed. These cases use real clients: the probe
// either sees what ioredis actually produces or it does not, and BullMQ's own check is the
// authority on what a worker connection must look like.

/** Options for a client that is "connecting" and never reaches a server, so no test needs Redis. */
const unreachable: RedisOptions = {
  host: '127.0.0.1',
  port: 1,
  maxRetriesPerRequest: 3,
  retryStrategy: () => null,
}

/** A real client that keeps the duplicates it hands out, honouring the override like ioredis does. */
class RecordingRedis extends Redis {
  readonly duplicates: Redis[] = []

  override duplicate(override?: Partial<RedisOptions>): Redis {
    const copy = super.duplicate(override)
    this.duplicates.push(copy)
    return copy
  }
}

/** A real client whose `duplicate()` drops the override, as a wrapper that ignores it would. */
class OverrideIgnoringRedis extends RecordingRedis {
  override duplicate(): Redis {
    return super.duplicate()
  }
}

const open: Redis[] = []

/** Build a client of the given class and make sure the test closes it. */
function client<T extends Redis>(Type: new (options: RedisOptions) => T): T {
  const created = new Type(unreachable)
  created.on('error', () => undefined)
  open.push(created)
  return created
}

/** Resolve the Mode A connection for a client and return what init threw, if anything. */
async function initWith(redis: Redis): Promise<unknown> {
  try {
    await new ConnectionResolver({ connection: { client: redis } }).init()
    return undefined
  } catch (err) {
    return err
  }
}

/** Wait for a client that was told to disconnect to reach `end`; its status moves on a later tick. */
async function settle(redis: Redis | undefined): Promise<string | undefined> {
  if (redis === undefined) return undefined
  if (redis.status !== 'end') {
    await Promise.race([
      new Promise((resolve) => redis.once('end', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  }
  return redis.status
}

afterEach(() => {
  for (const redis of open.splice(0)) redis.disconnect()
})

describe('ConnectionResolver Mode A probe, with real ioredis', () => {
  // A stock client created with finite retries is the case the override exists for: the duplicate
  // comes back with `null`, so the probe passes and the consumer needs to do nothing.
  it('accepts a stock client with finite retries and closes the probe it opened', async () => {
    const redis = client(RecordingRedis)

    const failure = await initWith(redis)

    expect(failure).toBeUndefined()
    expect(redis.options.maxRetriesPerRequest).toBe(3)
    expect(redis.duplicates).toHaveLength(1)
    expect(redis.duplicates[0]?.options.maxRetriesPerRequest).toBeNull()
    expect(await settle(redis.duplicates[0])).toBe('end')
  })

  // The case the probe exists for: a client whose `duplicate()` ignores the override would hand
  // BullMQ a worker connection with finite retries, so init must refuse it, and must still close
  // the probe it opened to find out.
  it('refuses a client whose duplicate() ignores the override and closes the probe', async () => {
    const redis = client(OverrideIgnoringRedis)

    const failure = await initWith(redis)

    expect(failure).toBeInstanceOf(QueueException)
    const body = (failure as QueueException).getResponse() as {
      error: { code: string; details: unknown }
    }
    expect(body.error.code).toBe(QUEUE_ERROR_CODES.CONNECTION_REQUIRES_NULL_RETRIES)
    expect(body.error.details).toEqual({ actualValue: 3, expectedValue: null })
    expect(await settle(redis.duplicates[0])).toBe('end')
  })

  // The probe is only worth having if the connection it rejects is one BullMQ would reject too.
  // Without the probe, this is the failure a consumer would meet when the first worker is built.
  it('rejects exactly the connection BullMQ refuses to build a Worker on', async () => {
    const redis = client(OverrideIgnoringRedis)
    await initWith(redis)
    const rejected = redis.duplicates[0]
    if (rejected === undefined) throw new Error('init opened no probe')

    expect(
      () => new Worker('probe', () => Promise.resolve(), { connection: rejected, autorun: false }),
    ).toThrow('maxRetriesPerRequest must be null')
  })
})

/** A port nothing listens on, found by binding and releasing one. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve()
    })
  })
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe('ConnectionResolver Mode B startup, with real ioredis', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  // Without a ready check ioredis is ready as soon as the socket connects, so a bare TCP listener
  // stands in for a Redis that has come back; no server protocol is involved.
  const ownedOptions = {
    enableReadyCheck: false,
    protocol: 2 as const,
    disableClientInfo: true,
    retryStrategy: () => 100,
  }

  it('closes the client it opened when the budget ends, so nothing keeps reconnecting', async () => {
    const port = await freePort()
    const resolver = new ConnectionResolver({
      connection: { url: `redis://:s3cr3t@127.0.0.1:${String(port)}`, options: ownedOptions },
      connectionReadyTimeoutMs: 500,
    })

    const failure = await resolver.init().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(QueueException)
    const body = (failure as QueueException).getResponse() as {
      error: { code: string; details: unknown }
    }
    expect(body.error.code).toBe(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT)
    expect(body.error.details).toEqual({ timeoutMs: 500, lastErrorCode: 'ECONNREFUSED' })
    expect(JSON.stringify(body)).not.toContain('s3cr3t')
    // A client left reconnecting would connect as soon as something listens; this one must not.
    let connections = 0
    const server = createServer((socket) => {
      connections++
      socket.on('error', () => undefined)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(connections).toBe(0)
  })

  // A server that accepts the socket and never answers is what a frozen Redis looks like to the
  // client; before the command deadline such a call stayed pending for as long as the freeze did.
  it('rejects a command on a Redis that never replies, within the command deadline', async () => {
    const server = createServer((socket) => socket.on('error', () => undefined))
    servers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    const resolver = new ConnectionResolver({
      connection: { url: `redis://127.0.0.1:${String(port)}`, options: ownedOptions },
      commandTimeoutMs: 300,
    })
    await resolver.init()

    const started = Date.now()
    const failure = await resolver
      .getClient()
      .get('k')
      .then(
        () => undefined,
        (err: unknown) => err,
      )

    expect((failure as Error).message).toContain('timed out')
    expect(Date.now() - started).toBeLessThan(2000)
    await resolver.teardown()
  })

  // With the offline queue off, a call made while the socket is down fails at once instead of
  // being buffered until the reconnect.
  it('rejects at once, without buffering, while the connection is down', async () => {
    const server = createServer((socket) => socket.on('error', () => undefined))
    servers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    const resolver = new ConnectionResolver({
      connection: {
        url: `redis://127.0.0.1:${String(port)}`,
        options: { ...ownedOptions, retryStrategy: () => 5000 },
      },
    })
    await resolver.init()
    server.close()
    const client = resolver.getClient()
    client.stream.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const started = Date.now()
    const failure = await client.get('k').then(
      () => undefined,
      (err: unknown) => err,
    )

    expect((failure as Error).message).toContain('enableOfflineQueue')
    expect(Date.now() - started).toBeLessThan(500)
    await resolver.teardown()
  })

  it('boots when Redis comes up inside the budget', async () => {
    const port = await freePort()
    const resolver = new ConnectionResolver({
      connection: { url: `redis://127.0.0.1:${String(port)}`, options: ownedOptions },
      connectionReadyTimeoutMs: 3000,
    })
    const server = createServer((socket) => socket.on('error', () => undefined))
    servers.push(server)
    const listening = new Promise<void>((resolve) =>
      setTimeout(() => server.listen(port, '127.0.0.1', resolve), 1000),
    )

    await resolver.init()
    await listening

    expect(resolver.getClient().status).toBe('ready')
    open.push(resolver.getClient())
  })
})
