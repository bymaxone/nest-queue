/**
 * @fileoverview Unit tests for how the connection resolver builds an owned client. With sentinels the
 * client is built lazy and with no connector of ours, its own connector is wrapped by the guard, and
 * the first connect is started by the resolver; without them the client gets the guarded connector and
 * connects eagerly. ioredis's `Redis` is mocked and its `AbstractConnector` kept real.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { GuardedConnector } from '../connection/guarded-connector'
import { ConnectionResolver } from './connection-resolver.service'
import type { QueueException } from '../errors/queue-exception'

const redisConstructor = jest.fn<Redis, unknown[]>()

jest.mock('ioredis', () => ({
  AbstractConnector: jest.requireActual<{ AbstractConnector: unknown }>('ioredis')
    .AbstractConnector,
  Redis: jest.fn().mockImplementation((...args: unknown[]): Redis => redisConstructor(...args)),
}))

/** A client that is ready from the start, with a connector whose connect can be wrapped. */
class FakeRedis extends EventEmitter {
  status = 'ready'
  readonly options = { maxRetriesPerRequest: null }
  readonly originalConnect = jest.fn().mockResolvedValue('stream')
  readonly connector = { connect: this.originalConnect }
  readonly connect = jest.fn().mockResolvedValue(undefined)
  readonly duplicate = jest.fn()
  readonly disconnect = jest.fn()
  readonly quit = jest.fn().mockResolvedValue('OK')
}

const sentinels = [{ host: '127.0.0.1', port: 26379 }]

/** The options a client was built with, the last argument of the constructor call. */
function builtWith(): Record<string, unknown> {
  const args = redisConstructor.mock.calls[0] ?? []
  return args.at(-1) as Record<string, unknown>
}

/** The keys `Object.prototype` holds before any test plants one. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

afterEach(() => {
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD.has(n))
  for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
  if (extra.length > 0) throw new Error('a test left a key on Object.prototype')
})

describe('ConnectionResolver builds a sentinel client lazy and guards its connector', () => {
  let client: FakeRedis

  beforeEach(() => {
    redisConstructor.mockReset()
    client = new FakeRedis()
    redisConstructor.mockReturnValue(client as unknown as Redis)
  })

  it('builds it lazy with no connector of ours, and connects it exactly once', async () => {
    const resolver = new ConnectionResolver({
      connection: { options: { sentinels, name: 'mymaster' } },
    })

    await resolver.init()

    const options = builtWith()
    expect(options.lazyConnect).toBe(true)
    expect(options.Connector).toBeUndefined()
    expect(options.sentinels).toEqual(sentinels)
    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('builds it lazy when the sentinels come with a url', async () => {
    const resolver = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379', options: { sentinels, name: 'mymaster' } },
    })

    await resolver.init()

    expect(redisConstructor.mock.calls[0]?.[0]).toBe('redis://localhost:6379')
    expect(builtWith().lazyConnect).toBe(true)
    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('wraps the connector it built, so a connect through it is guarded', async () => {
    const resolver = new ConnectionResolver({
      connection: { options: { sentinels, name: 'mymaster' } },
    })

    await resolver.init()

    expect(client.connector.connect).not.toBe(client.originalConnect)
    await expect((client.connector.connect as () => Promise<unknown>)()).resolves.toBe('stream')
    expect(client.originalConnect).toHaveBeenCalledTimes(1)

    Object.defineProperty(Object.prototype, 'zzPlanted', {
      value: 1,
      configurable: true,
      enumerable: true,
    })
    let code: string | undefined
    try {
      await (client.connector.connect as () => Promise<unknown>)()
    } catch (error) {
      code = ((error as QueueException).getResponse() as { error: { code: string } }).error.code
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlanted')
    }
    expect(code).toBe('queue.invalid_options')
    expect(client.originalConnect).toHaveBeenCalledTimes(1)
  })

  it('does not fail the boot, nor leave a rejection unhandled, when that connect rejects', async () => {
    client.connect.mockRejectedValue(new Error('sentinels unreachable'))
    const unhandled = jest.fn()
    process.once('unhandledRejection', unhandled)
    const resolver = new ConnectionResolver({
      connection: { options: { sentinels, name: 'mymaster' } },
    })

    await resolver.init()
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
    expect(resolver.getMode()).toBe('mode-b-owned')
  })

  it('builds a client with no sentinels eager, with the guarded connector, and wraps nothing', async () => {
    const resolver = new ConnectionResolver({ connection: { url: 'redis://localhost:6379' } })

    await resolver.init()

    const options = builtWith()
    expect(options.Connector).toBe(GuardedConnector)
    expect(options.lazyConnect).toBe(false)
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.connector.connect).toBe(client.originalConnect)
  })

  it('reads an empty sentinel option as none', async () => {
    const resolver = new ConnectionResolver({
      connection: { options: { host: '127.0.0.1', port: 6379 } },
    })

    await resolver.init()

    expect(builtWith().Connector).toBe(GuardedConnector)
    expect(client.connect).not.toHaveBeenCalled()
  })
})
