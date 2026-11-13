/**
 * @fileoverview Unit tests for the dual-mode connection resolver.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
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
    await resolver.teardown()

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
    // The ready handler resolves the race; cleanup detaches the startup listeners. The one
    // listener left is the persistent logger: without it every later outage reaches ioredis with
    // no handler and is printed to raw stderr.
    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('error')).toBe(1)
  })

  it('opens a client from options only', async () => {
    // The options-only arm constructs Redis with a single object argument.
    const client = new FakeRedis('ready', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(
      optionsWith({ options: { host: 'localhost', port: 6379 } }),
    )
    await resolver.init()

    expect(redisConstructor).toHaveBeenCalledWith({
      host: 'localhost',
      port: 6379,
      lazyConnect: false,
    })
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

  it('detaches both listeners once the ready timeout fires', async () => {
    // A timed-out startup must not leave 'ready'/'error' subscriptions on a client the
    // caller may still hold, or a late event would run handlers for a settled attempt.
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

    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('error')).toBe(1)
    jest.useRealTimers()
  })

  it('cancels the ready timeout once the client becomes ready', async () => {
    // The timeout timer is armed before the event race; a client that wins the race must
    // disarm it so no pending timer keeps the process alive for the rest of the budget.
    jest.useFakeTimers()
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379', options: {} },
      connectionReadyTimeoutMs: 1000,
    })
    const init = resolver.init()
    expect(jest.getTimerCount()).toBe(1)
    client.emit('ready')
    await init

    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
  })

  it('keeps waiting through a connection error and resolves when the client becomes ready', async () => {
    // A Redis that is restarting refuses a connection before it accepts one; ioredis emits an
    // error per refused attempt and keeps retrying, so the first error is not the end of the
    // startup budget.
    jest.useFakeTimers()
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379' },
      connectionReadyTimeoutMs: 3000,
    })
    const init = resolver.init()
    const outcome = init.then(
      () => 'resolved',
      () => 'rejected',
    )
    client.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    client.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    jest.advanceTimersByTime(1000)
    client.status = 'ready'
    client.emit('ready')

    await expect(outcome).resolves.toBe('resolved')
    expect(client.disconnect).not.toHaveBeenCalled()
    // Cleanup detaches the startup listeners; only the persistent logger stays.
    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('error')).toBe(1)
    jest.useRealTimers()
  })

  it('rejects with CONNECTION_TIMEOUT carrying only the last error code, and disconnects the client', async () => {
    // The budget ends with the last transient error's code; the message, which can name the
    // host, never reaches the exception. The owned client is closed so it stops reconnecting.
    jest.useFakeTimers()
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver({
      connection: { url: 'redis://:s3cr3t@db.internal:6379' },
      connectionReadyTimeoutMs: 3000,
    })
    const init = resolver.init()
    const failure = init.then(
      () => undefined,
      (err: unknown) => err,
    )
    client.emit(
      'error',
      Object.assign(new Error('connect ECONNREFUSED db.internal:6379'), { code: 'ECONNREFUSED' }),
    )
    jest.advanceTimersByTime(3000)
    const err = await failure

    expect(err).toBeInstanceOf(QueueException)
    expect((err as QueueException).getResponse()).toEqual({
      error: {
        code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
        message: 'Redis connection timeout',
        details: { timeoutMs: 3000, lastErrorCode: 'ECONNREFUSED' },
      },
    })
    expect(JSON.stringify(err)).not.toContain('s3cr3t')
    expect(JSON.stringify((err as QueueException).getResponse())).not.toContain('db.internal')
    expect(client.disconnect).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('rejects at once, and disconnects, when the server refuses the credentials', async () => {
    // A reply error (WRONGPASS, NOAUTH) will not change by waiting, so it ends the startup
    // instead of spending the whole budget.
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    const init = resolver.init()
    const failure = init.then(
      () => undefined,
      (err: unknown) => err,
    )
    const reply = new Error('WRONGPASS invalid username-password pair')
    reply.name = 'ReplyError'
    client.emit('error', reply)
    const err = await failure

    expect(err).toBeInstanceOf(QueueException)
    expect((err as QueueException).getResponse()).toMatchObject({
      error: {
        code: QUEUE_ERROR_CODES.CONNECTION_INVALID,
        details: { lastErrorCode: 'WRONGPASS' },
      },
    })
    expect(client.disconnect).toHaveBeenCalledTimes(1)
  })

  it('reports no code when the error carries none', async () => {
    // A thrown string, an error without a `code`, and a reply without a leading token each leave
    // the exception without `lastErrorCode` rather than inventing one from the message.
    jest.useFakeTimers()
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))
    const resolver = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379' },
      connectionReadyTimeoutMs: 1000,
    })
    const failure = resolver.init().then(
      () => undefined,
      (err: unknown) => err,
    )
    client.emit('error', 'a thrown string')
    client.emit('error', new Error('no code on this one'))
    jest.advanceTimersByTime(1000)

    const body = ((await failure) as QueueException).getResponse() as {
      error: { code: string; details: unknown }
    }
    expect(body.error.code).toBe(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT)
    expect(body.error.details).toEqual({ timeoutMs: 1000 })
    jest.useRealTimers()
  })

  it('rejects a reply error that has no leading token without a code', async () => {
    // Reply errors end the wait at once; a message that does not start with an upper-case token
    // (or a reply with no message at all) gives no code to carry.
    for (const reply of [
      { name: 'ReplyError', message: 'lower case start' },
      { name: 'ReplyError' },
    ]) {
      const client = new FakeRedis('connecting', null)
      redisConstructor.mockReturnValue(asRedis(client))
      const failure = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
        .init()
        .then(
          () => undefined,
          (err: unknown) => err,
        )
      client.emit('error', reply)

      const body = ((await failure) as QueueException).getResponse() as {
        error: { code: string; details: unknown }
      }
      expect(body.error.code).toBe(QUEUE_ERROR_CODES.CONNECTION_INVALID)
      expect(body.error.details).toEqual({})
    }
  })

  it('rejects at once, and disconnects, when the client gives up reconnecting', async () => {
    // A `retryStrategy` that returns null ends the client: waiting for `ready` after `end`
    // would only spend the budget.
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    const init = resolver.init()
    const failure = init.then(
      () => undefined,
      (err: unknown) => err,
    )
    client.emit('end')
    const err = await failure

    expect(err).toBeInstanceOf(QueueException)
    expect((err as QueueException).getResponse()).toMatchObject({
      error: { code: QUEUE_ERROR_CODES.CONNECTION_INVALID },
    })
    expect(client.disconnect).toHaveBeenCalledTimes(1)
  })

  it('quits the owned client on destroy', async () => {
    // Graceful shutdown flushes pending commands via quit().
    const client = new FakeRedis('ready', null)
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    await resolver.init()
    await resolver.teardown()

    expect(client.quit).toHaveBeenCalledTimes(1)
  })

  it('falls back to disconnect when quit rejects', async () => {
    // If quit fails, force the socket closed so the process can exit.
    const client = new FakeRedis('ready', null)
    client.quit.mockRejectedValue(new Error('already closed'))
    redisConstructor.mockReturnValue(asRedis(client))

    const resolver = new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' }))
    await resolver.init()
    await resolver.teardown()

    expect(client.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectionResolver — error events after startup', () => {
  beforeEach(() => {
    redisConstructor.mockReset()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('logs an outage on the owned client through the module logger instead of leaving it unhandled', async () => {
    // Once the client is ready the startup listeners are gone; an outage 6 s long produced six
    // "[ioredis] Unhandled error event" lines on raw stderr, outside the structured logger.
    const lines = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const client = new FakeRedis('ready', null)
    redisConstructor.mockReturnValue(asRedis(client))
    await new ConnectionResolver(optionsWith({ url: 'redis://localhost:6379' })).init()

    client.emit('error', new Error('ECONNREFUSED'))
    client.emit('error', new Error('ECONNREFUSED'))

    expect(lines.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual([
      'Redis connection (owned) emitted an error: ECONNREFUSED',
      'Redis connection (owned) emitted an error: ECONNREFUSED',
    ])
  })

  it('attaches the logger when the client is created, before startup can fail', async () => {
    // A client that never reaches ready still emits errors while it retries; the listener must
    // already be there when init rejects and the caller drops the resolver.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const client = new FakeRedis('connecting', null)
    redisConstructor.mockReturnValue(asRedis(client))
    const init = new ConnectionResolver({
      connection: { url: 'redis://localhost:6379' },
      connectionReadyTimeoutMs: 1,
    }).init()

    await expect(init).rejects.toBeInstanceOf(QueueException)
    expect(client.listenerCount('error')).toBe(1)
  })

  it('adds no listener to a host-supplied client, and guards only its own probe', async () => {
    // The host owns its client's error handling; the library only owns the probe it duplicates.
    const probe = new FakeRedis('ready', null)
    const client = new FakeRedis('ready', 20)
    client.duplicate.mockReturnValue(asRedis(probe))
    const lines = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await new ConnectionResolver(optionsWith({ client: asRedis(client) })).init()

    expect(client.listenerCount('error')).toBe(0)
    expect(probe.listenerCount('error')).toBe(1)
    // A late error on the probe is the library's to report, under its own label.
    probe.emit('error', new Error('ECONNRESET'))
    expect(lines).toHaveBeenCalledWith('Redis connection (probe) emitted an error: ECONNRESET')
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
    await expect(resolver.teardown()).resolves.toBeUndefined()
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
  it('keeps the client and the module options out of every serialization path', () => {
    // The resolver is injected into QueueService, WorkerRegistry,
    // QueueEventsRegistry and QueueLifecycle. It holds the consumer's module
    // options — whose `url` carries the Redis password inline — and an ioredis
    // instance, which carries `options.password` as a plain field. Both were
    // reachable by walking a service that holds the resolver, which is what a
    // structured logger or an error reporter does when it renders one.
    const secret = 'r3d1sPassw0rd-canary'
    const client = new FakeRedis('ready')
    redisConstructor.mockReturnValue(asRedis(client))
    const resolver = new ConnectionResolver({
      connection: { url: `redis://default:${secret}@127.0.0.1:6379` },
    })

    expect(Object.keys(resolver)).not.toContain('client')
    expect(Object.keys(resolver)).not.toContain('options')
    expect(JSON.stringify(resolver)).not.toContain(secret)
    expect(inspect(resolver, { depth: null, showHidden: true })).not.toContain(secret)
  })
})
