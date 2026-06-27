/**
 * @fileoverview Unit tests for the dual-mode connection resolver.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'

const redisConstructor = jest.fn<Redis, unknown[]>()

jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation((...args: unknown[]): Redis => redisConstructor(...args)),
}))

/** A controllable fake ioredis client driving the resolver's event paths. */
class FakeRedis extends EventEmitter {
  status: string
  readonly options: { maxRetriesPerRequest?: number | null }
  readonly duplicate = jest.fn()
  readonly disconnect = jest.fn()
  readonly quit = jest.fn<Promise<'OK'>, []>().mockResolvedValue('OK')

  constructor(status = 'connecting', maxRetriesPerRequest: number | null = null) {
    super()
    this.status = status
    this.options = { maxRetriesPerRequest }
  }
}

/** Cast a fake to the Redis type for the resolver under test. */
function asRedis(fake: FakeRedis): Redis {
  return fake as unknown as Redis
}

/** Build module options for a given connection config. */
function optionsWith(connection: BymaxQueueModuleOptions['connection']): BymaxQueueModuleOptions {
  return { connection }
}

describe('ConnectionResolver — Mode A (bring your own client)', () => {
  it('adopts a ready client and validates the duplicated probe', async () => {
    // The BYO client is used as-is; the probe confirms the null override applies.
    const probe = new FakeRedis('ready', null)
    const client = new FakeRedis('ready', 20)
    client.duplicate.mockReturnValue(asRedis(probe))

    const resolver = new ConnectionResolver(optionsWith({ client: asRedis(client) }))
    await resolver.init()

    expect(resolver.getMode()).toBe('mode-a-byo')
    expect(resolver.getClient()).toBe(asRedis(client))
    expect(resolver.isOwned()).toBe(false)
    expect(probe.disconnect).toHaveBeenCalledTimes(1)
  })

  it('rejects an ended client with CONNECTION_INVALID', async () => {
    // An unusable client must fail fast before any work is attempted.
    const client = new FakeRedis('end', null)
    const resolver = new ConnectionResolver(optionsWith({ client: asRedis(client) }))

    await expect(resolver.init()).rejects.toBeInstanceOf(QueueException)
    expect(client.duplicate).not.toHaveBeenCalled()
  })

  it('fails fast and disconnects the probe when the duplicate ignores the override', async () => {
    // A wrapper that drops the override leaves a non-null value — must throw.
    const probe = new FakeRedis('ready', 20)
    const client = new FakeRedis('ready', 20)
    client.duplicate.mockReturnValue(asRedis(probe))

    const resolver = new ConnectionResolver(optionsWith({ client: asRedis(client) }))

    await expect(resolver.init()).rejects.toBeInstanceOf(QueueException)
    expect(probe.disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not touch the client on destroy', async () => {
    // The library never closes a connection it does not own.
    const probe = new FakeRedis('ready', null)
    const client = new FakeRedis('ready', 20)
    client.duplicate.mockReturnValue(asRedis(probe))

    const resolver = new ConnectionResolver(optionsWith({ client: asRedis(client) }))
    await resolver.init()
    await resolver.onModuleDestroy()

    expect(client.quit).not.toHaveBeenCalled()
    expect(client.disconnect).not.toHaveBeenCalled()
  })
})

describe('ConnectionResolver — Mode B (library-owned)', () => {
  beforeEach(() => {
    redisConstructor.mockReset()
  })

  it('opens a client from a URL and resolves when it becomes ready', async () => {
    // The URL arm passes options through with lazyConnect disabled.
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(
      optionsWith({ url: 'redis://localhost:6379', options: { db: 1 } }),
    )
    const init = resolver.init()
    client.status = 'ready'
    client.emit('ready')
    await init

    expect(redisConstructor).toHaveBeenCalledWith('redis://localhost:6379', {
      db: 1,
      lazyConnect: false,
    })
    expect(resolver.getMode()).toBe('mode-b-owned')
    expect(resolver.isOwned()).toBe(true)
    // The ready handler resolves the race; cleanup must then detach BOTH listeners
    // so the unused 'error' subscription is not leaked once the client is ready.
    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('opens a client from options only', async () => {
    // The options-only arm constructs Redis with a single object argument.
    const client = new FakeRedis('ready', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ options: { host: 'localhost', port: 6379 } }))
    await resolver.init()

    expect(redisConstructor).toHaveBeenCalledWith({ host: 'localhost', port: 6379, lazyConnect: false })
  })

  it('resolves immediately when the client is already ready', async () => {
    // A ready client skips the event race entirely.
    const client = new FakeRedis('ready', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    await expect(resolver.init()).resolves.toBeUndefined()
    expect(redisConstructor).toHaveBeenCalledWith('redis://localhost:6379', { lazyConnect: false })
  })

  it('rejects with CONNECTION_TIMEOUT when ready never arrives', async () => {
    // The timeout guards against a Redis that never reaches ready.
    jest.useFakeTimers()
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379', options: {} },
      connectionReadyTimeoutMs: 1000,
    })
    const init = resolver.init()
    const assertion = expect(init).rejects.toBeInstanceOf(QueueException)
    jest.advanceTimersByTime(1000)
    await assertion
    jest.useRealTimers()
  })

  it('rejects when the client emits an error before ready', async () => {
    // A connection error during startup propagates to the caller.
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    const init = resolver.init()
    const boom = new Error('ECONNREFUSED')
    client.emit('error', boom)

    await expect(init).rejects.toBe(boom)
    // The error handler rejects the race; cleanup must then detach BOTH listeners
    // so the unused 'ready' subscription is not leaked once startup has failed.
    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('quits the owned client on destroy', async () => {
    // Graceful shutdown flushes pending commands via quit().
    const client = new FakeRedis('ready', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    await resolver.init()
    await resolver.onModuleDestroy()

    expect(client.quit).toHaveBeenCalledTimes(1)
  })

  it('falls back to disconnect when quit rejects', async () => {
    // If quit fails, force the socket closed so the process can exit.
    const client = new FakeRedis('ready', null)
    client.quit.mockRejectedValue(new Error('already closed'))
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    await resolver.init()
    await resolver.onModuleDestroy()

    expect(client.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectionResolver — uninitialized access', () => {
  it('throws when getClient is called before init', () => {
    // Defensive guard: the client accessor must not return undefined.
    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    expect(() => resolver.getClient()).toThrow(QueueException)
  })

  it('throws when getMode is called before init', () => {
    // Defensive guard: the mode accessor must not return undefined.
    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    expect(() => resolver.getMode()).toThrow(QueueException)
  })

  it('does nothing on destroy when never initialized', async () => {
    // Destroying an uninitialized resolver is a safe no-op.
    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    await expect(resolver.onModuleDestroy()).resolves.toBeUndefined()
  })
})

/** Read the structured details of a thrown/ rejected QueueException. */
function detailsOf(err: unknown): Record<string, unknown> {
  return ((err as QueueException).getResponse() as { error: { details: Record<string, unknown> } })
    .error.details
}

describe('ConnectionResolver — exception details', () => {
  beforeEach(() => {
    redisConstructor.mockReset()
  })

  it('reports "not initialized" from getClient and getMode before init', () => {
    // The defensive accessors carry a precise reason, not a bare error.
    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    let clientErr: unknown
    let modeErr: unknown
    try {
      resolver.getClient()
    } catch (err) {
      clientErr = err
    }
    try {
      resolver.getMode()
    } catch (err) {
      modeErr = err
    }
    expect(detailsOf(clientErr).reason).toBe('not initialized')
    expect(detailsOf(modeErr).reason).toBe('not initialized')
  })

  it('reports the client status when a BYO client is unusable', async () => {
    // The CONNECTION_INVALID detail surfaces the offending status.
    const client = new FakeRedis('end', null)
    const resolver = new ConnectionResolver(optionsWith({ client: asRedis(client) }))
    try {
      await resolver.init()
      throw new Error('expected init to reject')
    } catch (err) {
      expect(detailsOf(err).status).toBe('end')
    }
  })

  it('reports the configured timeout on CONNECTION_TIMEOUT', async () => {
    // The timeout detail echoes the configured ready-timeout for diagnosis.
    jest.useFakeTimers()
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))
    const resolver = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379' },
      connectionReadyTimeoutMs: 1234,
    })
    const init = resolver.init()
    const assertion = init.catch((err: unknown) => {
      expect(detailsOf(err).timeoutMs).toBe(1234)
    })
    jest.advanceTimersByTime(1234)
    await assertion
    jest.useRealTimers()
  })
})
