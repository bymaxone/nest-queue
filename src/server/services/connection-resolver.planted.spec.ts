/**
 * @fileoverview Unit tests for the connection resolver under a polluted `Object.prototype`: a key
 * planted there is refused as a whole, at boot, before any client is built, and the refusal reports a
 * count and never a name or a value.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'

const redisConstructor = jest.fn<Redis, unknown[]>()

jest.mock('ioredis', () => ({
  AbstractConnector: jest.requireActual<{ AbstractConnector: unknown }>('ioredis')
    .AbstractConnector,
  Redis: jest.fn().mockImplementation((...args: unknown[]): Redis => redisConstructor(...args)),
}))

/** A client that is ready from the start. */
class ReadyRedis extends EventEmitter {
  status = 'ready'
  readonly options = { maxRetriesPerRequest: null }
  readonly duplicate = jest.fn()
  readonly disconnect = jest.fn()
  readonly quit = jest.fn().mockResolvedValue('OK')
}

/** Run `body` with `key` planted on the root prototype, and take it off again whatever happens. */
async function withPlanted(key: string, value: unknown, body: () => Promise<void>): Promise<void> {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  try {
    await body()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('ConnectionResolver refuses a polluted Object.prototype at boot', () => {
  beforeEach(() => {
    redisConstructor.mockReset()
    redisConstructor.mockReturnValue(new ReadyRedis() as unknown as Redis)
  })

  it.each(['client', 'commandTimeoutMs', 'path'])(
    'refuses a planted %s with a count only and builds no client',
    async (key) => {
      await withPlanted(key, 'planted-value', async () => {
        const resolver = new ConnectionResolver({ connection: { url: 'redis://localhost:6379' } })

        const error: unknown = await resolver.init().catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(QueueException)
        const body = (error as QueueException).getResponse() as {
          error: { code: string; details: Record<string, unknown> }
        }
        expect(body.error.code).toBe('queue.invalid_options')
        expect(body.error.details).toEqual({
          reason: 'Object.prototype holds keys the libraries would read as their own',
          count: 1,
        })
        expect(JSON.stringify(error)).not.toContain('planted-value')
        expect(redisConstructor).not.toHaveBeenCalled()
      })
    },
  )

  it('refuses a bring-your-own client too, since the guard runs before the mode is chosen', async () => {
    await withPlanted('zzPlanted', 1, async () => {
      const resolver = new ConnectionResolver({
        connection: { client: new ReadyRedis() as unknown as Redis },
      })

      await expect(resolver.init()).rejects.toBeInstanceOf(QueueException)
    })
  })

  it('opens its own client for a url when Object.prototype is clean', async () => {
    const resolver = new ConnectionResolver({ connection: { url: 'redis://localhost:6379' } })

    await resolver.init()

    expect(resolver.getMode()).toBe('mode-b-owned')
    expect(redisConstructor).toHaveBeenCalledTimes(1)
  })
})
