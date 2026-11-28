/**
 * @fileoverview The connections the library duplicates keep an `error` listener after the BullMQ
 * object that used them closed. Real ioredis clients and real BullMQ classes run against a loopback
 * server that is taken away, because BullMQ removes its own listener when it closes.
 * @layer server/services
 */

import net from 'node:net'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { QueueEventsRegistry } from './queue-events-registry.service'
import { WorkerRegistry } from './worker-registry.service'
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
