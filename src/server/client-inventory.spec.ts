/**
 * @fileoverview Client inventory: every Redis client the library constructs or duplicates, driven
 * through the real services and real BullMQ against a Redis that is not there, must carry an
 * `error` listener. A client that emits `error` with none makes ioredis print
 * `[ioredis] Unhandled error event` to raw stderr, outside the structured logger, during exactly
 * the outage the logs exist for.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { ConnectionResolver } from './services/connection-resolver.service'
import { FlowService } from './services/flow.service'
import { QueueEventsRegistry } from './services/queue-events-registry.service'
import { QueueService } from './services/queue.service'
import { WorkerRegistry } from './services/worker-registry.service'
import { applyDefaults } from './config/resolved-options'
import type { BymaxQueueModuleOptions } from './interfaces/queue-module-options.interface'

// Nothing here needs a Redis server: the listeners under test are attached when a client is
// constructed, not when it becomes ready, and an unreachable port is the outage itself. A client
// that is ready has the same listeners, because nothing removes them.

/** The way nest-cache builds its client: no offline queue, so a command fails while it is down. */
const hostOptions = {
  host: '127.0.0.1',
  port: 1,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 3,
  retryStrategy: () => null,
}

/** A library-owned connection to a port nothing listens on. */
const owned = { url: 'redis://127.0.0.1:1', options: { retryStrategy: () => null } }

/** Every client created through `duplicate()`, including the ones BullMQ makes from ours. */
const duplicates: Redis[] = []
/** Every client the stack was built on: the owned one, or the host's. */
const roots: Redis[] = []

const realDuplicate: (this: Redis, override?: Partial<RedisOptions>) => Redis =
  Redis.prototype.duplicate

beforeEach(() => {
  duplicates.length = 0
  roots.length = 0
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  jest.spyOn(Redis.prototype, 'duplicate').mockImplementation(function (
    this: Redis,
    override?: Partial<RedisOptions>,
  ) {
    const copy = realDuplicate.call(this, override)
    duplicates.push(copy)
    return copy
  })
})

afterEach(async () => {
  const clients = [...roots, ...duplicates]
  for (const client of clients) if (client.status !== 'end') client.disconnect()
  // A client that was told to stop reaches `end` on a later tick; leaving before that keeps its
  // reconnect timer alive past the test.
  await Promise.all(
    clients.map((client) =>
      client.status === 'end'
        ? Promise.resolve()
        : new Promise<void>((done) =>
            client.once('end', () => {
              done()
            }),
          ),
    ),
  )
  jest.restoreAllMocks()
})

/** Builds the services over `connection` and exercises every role that opens a client. */
async function buildStack(connection: BymaxQueueModuleOptions['connection']): Promise<{
  resolver: ConnectionResolver
  close: () => Promise<void>
}> {
  const options: BymaxQueueModuleOptions = { connection, connectionReadyTimeoutMs: 50 }
  const resolver = new ConnectionResolver(options)
  await resolver.init().catch(() => undefined)
  roots.push(resolver.getClient())
  const resolved = applyDefaults({ ...options, flows: { enabled: true } })
  const queues = new QueueService(resolver, resolved)
  const workers = new WorkerRegistry(resolver, resolved)
  const events = new QueueEventsRegistry(resolver, resolved)
  const flow = new FlowService(resolver, true, resolved.prefix)
  queues.getOrCreateQueue('inventory')
  workers.register({
    queueName: 'inventory',
    handler: () => Promise.resolve(undefined),
    // BullMQ arms a timer of this length when the worker is closed while its stalled-job check is
    // in flight; the default 30 s one would outlive the test.
    options: { stalledInterval: 20 },
  })
  events.getOrCreate('inventory')
  return {
    resolver,
    close: async () => {
      await workers.unregister('inventory')
      for (const qe of events.getAll().values()) await qe.close().catch(() => undefined)
      await queues.closeAll()
      await flow.close()
    },
  }
}

/** The clients with no `error` listener, named by where they came from. */
function unhandled(clients: readonly Redis[]): string[] {
  return clients.flatMap((client, index) =>
    client.listenerCount('error') === 0 ? [`client #${String(index)}`] : [],
  )
}

describe('the client inventory — library-owned connection (Mode B)', () => {
  it('guards the owned client on its own, before any queue, worker or flow exists', async () => {
    // BullMQ adds a listener of its own to a client it is handed, which hides a bare client here;
    // an application that has not touched a queue yet has only the library's.
    const resolver = new ConnectionResolver({
      connection: owned,
      connectionReadyTimeoutMs: 50,
    })
    await resolver.init().catch(() => undefined)
    roots.push(resolver.getClient())

    expect(resolver.getClient().listenerCount('error')).toBeGreaterThanOrEqual(1)
  })

  it('leaves no client the library constructed or duplicated without an error listener', async () => {
    const { close } = await buildStack(owned)
    const all = [...roots, ...duplicates]

    // The owned client, the worker's and the QueueEvents' duplicates, and every duplicate BullMQ
    // makes from those must all be listened on.
    expect(all.length).toBeGreaterThanOrEqual(5)
    expect(unhandled(all)).toEqual([])
    await close()
  })

  it('writes nothing to stderr when any of them emits an error', async () => {
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { close } = await buildStack(owned)

    for (const client of [...roots, ...duplicates]) {
      client.emit('error', new Error('ECONNREFUSED'))
    }

    // ioredis reports an unhandled error with console.error.
    expect(stderr).not.toHaveBeenCalled()
    await close()
  })
})

describe('the client inventory — what the log line carries', () => {
  it('never carries the credentials of a connection URL, for the owned client or its duplicates', async () => {
    // The line holds the error's message, name and code and a role label, nothing from the URL.
    // `localhost` resolves to two addresses, which is the AggregateError that has no message.
    const lines = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { close } = await buildStack({
      url: 'redis://user:SENTINEL@localhost:1',
      options: { retryStrategy: () => null },
    })
    for (const client of [...roots, ...duplicates]) {
      client.emit('error', new Error('connect ECONNREFUSED'))
    }

    const logged = lines.mock.calls.map((call: unknown[]): unknown => call[0])
    expect(logged.length).toBeGreaterThan(0)
    expect(
      logged.some((line) => typeof line === 'string' && line.includes('Redis connection (')),
    ).toBe(true)
    expect(JSON.stringify(logged)).not.toContain('SENTINEL')
    expect(JSON.stringify(logged)).not.toContain('user:')
    await close()
  })

  it('names a real refused connection by its type and code, not by an empty message', async () => {
    const lines = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const resolver = new ConnectionResolver({
      connection: {
        url: 'redis://user:SENTINEL@localhost:1',
        options: { retryStrategy: () => null },
      },
      connectionReadyTimeoutMs: 2000,
    })
    await resolver.init().catch(() => undefined)
    roots.push(resolver.getClient())

    const owned = lines.mock.calls
      .map((call: unknown[]): unknown => call[0])
      .filter((line) => typeof line === 'string' && line.includes('(owned)'))
    expect(owned.length).toBeGreaterThan(0)
    expect(owned.join('\n')).toMatch(/emitted an error: \S/)
    expect(owned.join('\n')).not.toContain('SENTINEL')
  })
})

describe('the client inventory — host-supplied connection (Mode A, nest-cache style)', () => {
  it('guards every duplicate the library makes and adds nothing to the host client itself', async () => {
    const host = new Redis(hostOptions)
    const before = host.listenerCount('error')
    const resolver = new ConnectionResolver({ connection: { client: host } })
    await resolver.init().catch(() => undefined)

    // The host owns its client's error handling; the library adds nothing of its own to it.
    expect(host.listenerCount('error')).toBe(before)
    expect(duplicates.length).toBeGreaterThanOrEqual(1)
    expect(unhandled(duplicates)).toEqual([])
    host.disconnect()
  })
})
