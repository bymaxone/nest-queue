/**
 * @fileoverview The connections the library duplicates keep an `error` listener after the BullMQ
 * object that used them closed. Real ioredis clients and real BullMQ classes run against a loopback
 * server that is taken away, because BullMQ removes its own listener when it closes. The blocking
 * connection BullMQ duplicates from a worker's connection stays closed once the worker is released.
 * @layer server/services
 */

import net from 'node:net'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { QueueEventsRegistry } from './queue-events-registry.service'
import { WorkerRegistry } from './worker-registry.service'
import { QueueLifecycle } from '../lifecycle/queue-lifecycle.service'
import type { FlowService } from './flow.service'
import type { QueueService } from './queue.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

const INFO = 'redis_version:7.4.0\r\nmaxmemory_policy:noeviction\r\n'
/** A processor that exists on disk; with `autorun: false` it is never loaded. */
const processorFile = join(
  __dirname,
  '../../../test/e2e/fixtures/processors/sandboxed-timer.processor.cjs',
)

const sockets = new Set<Socket>()
let server: Server
let client: Redis
let logged: jest.SpyInstance

/** Answer every command with `+OK`, and `INFO` with a version BullMQ accepts. */
function serve(socket: Socket): void {
  sockets.add(socket)
  socket.on('error', () => undefined)
  socket.on('data', (data) => {
    for (const command of data.toString().split(/(?=\*\d+\r\n)/)) {
      const name = command.split('\r\n')[2]?.toUpperCase()
      socket.write(name === 'INFO' ? `$${String(INFO.length)}\r\n${INFO}\r\n` : '+OK\r\n')
    }
  })
}

/** Refuse every later connection and drop the open ones. */
function takeRedisAway(): void {
  server.close()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
}

/** Wait until `done` holds, or fail after two seconds. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('the condition did not hold in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The lines the library logged for a fault on the connection of `role`. */
function faultsOf(role: string): unknown[] {
  return logged.mock.calls.filter((call) => JSON.stringify(call).includes(`(${role})`))
}

/** The registries of a module over `client`. */
function registries(): { workers: WorkerRegistry; events: QueueEventsRegistry } {
  const connection = { getClient: () => client } as unknown as ConnectionResolver
  const options = { prefix: 'bull' } as unknown as ResolvedQueueOptions
  return {
    workers: new WorkerRegistry(connection, options),
    events: new QueueEventsRegistry(connection, options),
  }
}

beforeEach(async () => {
  logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  server = net.createServer(serve)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  client = new Redis({
    port,
    host: '127.0.0.1',
    protocol: 2,
    retryStrategy: () => 20,
    disconnectTimeout: 1,
  })
  client.on('error', () => undefined)
})

afterEach(() => {
  client.disconnect()
  takeRedisAway()
})

describe('the connection of a closed worker', () => {
  it.each([
    [
      'register',
      (workers: WorkerRegistry) =>
        workers.register({
          queueName: 'q',
          handler: () => Promise.resolve(),
          options: { autorun: false },
        }),
    ],
    [
      'registerSandboxed',
      (workers: WorkerRegistry) =>
        workers.registerSandboxed({ queueName: 'q', processorFile, options: { autorun: false } }),
    ],
  ])('logs a later fault when the worker came from %s', async (_name, start) => {
    const { workers } = registries()
    const worker = start(workers)
    const connection = workers.getConnections().get('q')!
    await until(() => connection.status === 'ready')

    let attempts = 0
    connection.on('reconnecting', () => (attempts += 1))

    await worker.close()
    takeRedisAway()
    // The second attempt comes after the first one was refused, so a fault has been emitted.
    await until(() => attempts >= 2)
    connection.disconnect()

    expect(faultsOf('worker: q').length).toBeGreaterThan(0)
  })

  it('leaves every duplicate with an error listener after BullMQ closed', async () => {
    const { workers, events } = registries()
    const worker = workers.register({
      queueName: 'q',
      handler: () => Promise.resolve(),
      options: { autorun: false },
    })
    const sandboxed = workers.registerSandboxed({
      queueName: 's',
      processorFile,
      options: { autorun: false },
    })
    const queueEvents = events.getOrCreate('e')
    const duplicates = [...workers.getConnections().values(), ...events.getConnections().values()]
    await until(() => duplicates.every((duplicate) => duplicate.status === 'ready'))

    await Promise.all([worker.close(), sandboxed.close(), queueEvents.close()])
    const listeners = duplicates.map((duplicate) => duplicate.listenerCount('error'))
    for (const duplicate of duplicates) duplicate.disconnect()

    expect(listeners).toHaveLength(3)
    for (const count of listeners) expect(count).toBeGreaterThan(0)
  })
})

describe('the blocking connection of a released worker', () => {
  /** The client BullMQ duplicated from the worker's connection, which is the blocking one. */
  function blockingOf(workers: WorkerRegistry): Redis {
    const duplicated = jest.spyOn(Redis.prototype, 'duplicate')
    workers.register({
      queueName: 'q',
      handler: () => Promise.resolve(),
      options: { autorun: false },
    })
    return duplicated.mock.results.at(-1)!.value as Redis
  }

  /** The lifecycle over the registries; consumption shutdown reads nothing else. */
  function lifecycleOf(workers: WorkerRegistry, events: QueueEventsRegistry): QueueLifecycle {
    const none = {} as unknown
    const resolved = { shutdown: { drainTimeoutMs: 500 } } as unknown as ResolvedQueueOptions
    return new QueueLifecycle(
      workers,
      events,
      none as QueueService,
      none as FlowService,
      none as ConnectionResolver,
      resolved,
    )
  }

  it.each([
    ['unregister', ({ workers }: ReturnType<typeof registries>) => workers.unregister('q')],
    [
      'the shutdown',
      ({ workers, events }: ReturnType<typeof registries>) =>
        lifecycleOf(workers, events).onModuleDestroy(),
    ],
  ])('stays closed after %s, whatever still asks it to connect', async (_name, release) => {
    const made = registries()
    const blocking = blockingOf(made.workers)
    await until(() => made.workers.getConnections().get('q')!.status === 'ready')

    await release(made)
    await until(() => blocking.status === 'end' || blocking.status === 'wait')
    const settled = blocking.status
    // What a reconnect BullMQ still has pending does next.
    await blocking.connect()

    expect(blocking.status).toBe(settled)
    expect(blocking.listenerCount('error')).toBeGreaterThan(0)
  })
})

// The installed BullMQ duplicates the connection it is handed before it refuses a queue name.
describe('a QueueEvents whose construction fails', () => {
  it('ends the connection BullMQ had already duplicated, for good', async () => {
    const duplicated = jest.spyOn(Redis.prototype, 'duplicate')
    const { events } = registries()

    expect(() => events.getOrCreate('a:b')).toThrow('Queue name cannot contain :')
    const made = duplicated.mock.results.at(-1)!.value as Redis
    await until(() => made.status === 'ready' || made.status === 'end')
    // What a reconnect still pending on it would do next.
    await made.connect()

    expect(duplicated).toHaveBeenCalledTimes(2)
    expect(made.status).toBe('end')
    expect(made.listenerCount('error')).toBeGreaterThan(0)
  })
})
