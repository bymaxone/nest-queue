/**
 * @fileoverview Unit tests for the options a connection resolver reads when `forRootAsync` hands it
 * the factory's own object: a key planted on the root prototype is not a value of those options, so
 * it neither flips the mode to a bring-your-own client nor sets a deadline.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'

const redisConstructor = jest.fn<Redis, unknown[]>()

jest.mock('ioredis', () => ({
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

describe('ConnectionResolver does not take a planted key for the host’s option', () => {
  beforeEach(() => {
    redisConstructor.mockReset()
    redisConstructor.mockReturnValue(new ReadyRedis() as unknown as Redis)
  })

  it('opens its own client for a url when a client is planted', async () => {
    await withPlanted('client', new ReadyRedis(), async () => {
      const resolver = new ConnectionResolver({
        connection: { url: 'redis://localhost:6379' },
      })

      await resolver.init()

      expect(resolver.getMode()).toBe('mode-b-owned')
      expect(redisConstructor).toHaveBeenCalledTimes(1)
    })
  })

  it('applies the default command deadline when one is planted', async () => {
    await withPlanted('commandTimeoutMs', 1, async () => {
      await new ConnectionResolver({
        connection: { url: 'redis://localhost:6379' },
      }).init()

      expect(redisConstructor).toHaveBeenCalledWith(
        'redis://localhost:6379',
        expect.objectContaining({ commandTimeout: 5000 }),
      )
    })
  })
})
