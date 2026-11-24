/**
 * @fileoverview The verdict of every bounded wait is the work's own, whatever a host or another
 * dependency did to `Promise` after this library loaded. Three sites decide through a bounded wait
 * (`withDeadline`, `quitWithin`, `ConnectionResolver.ping`); each is run under every plant that
 * changed its verdict when it was built on `Promise.race` and an async return: a replaced static, a
 * replaced `Promise.resolve`, a `then` that erases itself on `Object.prototype`, `Array.prototype` or
 * `Function.prototype`, and a replaced `constructor` that a forged `then` puts back.
 * Statics change nothing; a `then` or a `constructor` that is not the engine's is refused, and the
 * refusal fails closed (a rejection, a disconnect, `down`).
 * @layer server/utils
 */

import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import { ConnectionResolver } from '../services/connection-resolver.service'
import { QUEUE_LOG_EVENTS } from './log-event'
import { loggedEvents } from './log-lines'
import { quitWithin } from './quit-within'
import { withDeadline } from './with-deadline'

/** The engine's promise, its statics and its `then`, taken before any plant. */
const Native = Promise
const realThen = Promise.prototype.then
const realConstructor = Promise.prototype.constructor
const statics = {
  race: Promise.race,
  all: Promise.all,
  allSettled: Promise.allSettled,
  any: Promise.any,
  resolve: Promise.resolve,
  reject: Promise.reject,
}

/** What a promise settled with, read without resolving through any object. */
interface Settled {
  state: 'pending' | 'resolved' | 'rejected'
  value: unknown
}
let last: Settled = { state: 'pending', value: undefined }

/** Wait for `p` with the engine's own `then`, so that a planted `then` cannot touch the reading. */
function observe(p: Promise<unknown>, capMs: number): Promise<undefined> {
  last = { state: 'pending', value: undefined }
  return new Native<undefined>((done) => {
    const cap = setTimeout(() => {
      restore()
      done(undefined)
    }, capMs)
    const end = (state: 'resolved' | 'rejected') => (value: unknown) => {
      last = { state, value }
      clearTimeout(cap)
      restore()
      done(undefined)
    }
    void realThen.call(p, end('resolved'), end('rejected'))
  })
}

/** A promise that has already rejected, heard by a handler so that it is never reported unhandled. */
function rejected(error: Error): Promise<never> {
  const p = statics.reject.call(Native, error) as Promise<never>
  void realThen.call(p, undefined, () => undefined)
  return p
}

const settledWith = (value: unknown): Promise<unknown> => statics.resolve.call(Native, value)
const never = (): Promise<never> => new Native<never>(() => undefined)

/** A plant: how to arm it, and whether the guard sees it. */
interface Plant {
  readonly name: string
  readonly refused: boolean
  readonly arm: () => void
}

/** Replace a static of `Promise` by assignment. */
function replace(name: keyof typeof statics, value: unknown): void {
  ;(Promise as unknown as Record<string, unknown>)[name] = value
}

/** Plant a `then` that puts itself away when it is read, and answers `'FORGED'`. */
function selfErasingThen(owner: object): void {
  Object.defineProperty(owner, 'then', {
    configurable: true,
    value(resolve: (value: unknown) => void) {
      Reflect.deleteProperty(owner, 'then')
      resolve('FORGED')
    },
  })
}

const PLANTS: readonly Plant[] = [
  {
    name: 'Promise.race answering at once',
    refused: false,
    arm: () => {
      replace('race', () => statics.resolve.call(Native, 'FORGED'))
    },
  },
  {
    name: 'Promise.race answering with its first element only',
    refused: false,
    arm: () => {
      replace('race', (list: unknown[]) => list[0])
    },
  },
  {
    name: 'Promise.race that never settles',
    refused: false,
    arm: () => {
      replace('race', never)
    },
  },
  {
    name: 'Promise.resolve answering at once',
    refused: false,
    arm: () => {
      replace('resolve', () => statics.resolve.call(Native, 'FORGED'))
    },
  },
  {
    name: 'Promise.all, allSettled and any answering at once',
    refused: false,
    arm: () => {
      replace('all', () => statics.resolve.call(Native, []))
      replace('allSettled', () => statics.resolve.call(Native, []))
      replace('any', () => statics.resolve.call(Native, 'FORGED'))
    },
  },
  {
    name: 'a self-erasing then on Object.prototype',
    refused: true,
    arm: () => {
      selfErasingThen(Object.prototype)
    },
  },
  {
    name: 'a self-erasing then on Array.prototype',
    refused: true,
    arm: () => {
      selfErasingThen(Array.prototype)
    },
  },
  {
    name: 'a self-erasing then on Function.prototype',
    refused: true,
    arm: () => {
      selfErasingThen(Function.prototype)
    },
  },
  {
    name: 'a replaced constructor that a forged then puts back',
    refused: true,
    arm: () => {
      Promise.prototype.constructor = function Forged() {
        return undefined
      }
      Promise.prototype.then = function forged(this: Promise<unknown>, resolve: unknown) {
        Promise.prototype.constructor = realConstructor
        Promise.prototype.then = realThen
        ;(resolve as (value: unknown) => void)('FORGED')
        return this
      } as typeof Promise.prototype.then
    },
  },
]

function restore(): void {
  for (const [name, value] of Object.entries(statics)) replace(name as keyof typeof statics, value)
  Promise.prototype.then = realThen
  Promise.prototype.constructor = realConstructor
  for (const owner of [Object.prototype, Array.prototype, Function.prototype]) {
    Reflect.deleteProperty(owner, 'then')
  }
}

afterEach(() => {
  restore()
  jest.restoreAllMocks()
})

/** Whether `error` is the refusal of the guard. */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof QueueException &&
    (error.getResponse() as { error: { code: string } }).error.code ===
      QUEUE_ERROR_CODES.INVALID_OPTIONS
  )
}

/** A client stub whose `quit` and `ping` are given, and its `disconnect` spy. */
function clientWith(command: () => Promise<unknown>): { client: Redis; disconnect: jest.Mock } {
  const disconnect = jest.fn()
  return {
    client: { status: 'ready', quit: command, ping: command, disconnect } as unknown as Redis,
    disconnect,
  }
}

/** A resolver over `client` (bring your own), initialised. */
async function resolverOver(client: Redis): Promise<ConnectionResolver> {
  const probe = {
    status: 'ready',
    options: { maxRetriesPerRequest: null },
    on: jest.fn(),
    disconnect: jest.fn(),
  }
  const adopted = Object.assign(client, {
    options: { maxRetriesPerRequest: 20 },
    duplicate: () => probe,
    on: jest.fn(),
    off: jest.fn(),
  })
  const resolver = new ConnectionResolver({ connection: { client: adopted } })
  await resolver.init()
  return resolver
}

describe.each(PLANTS)('under $name', ({ arm, refused }) => {
  describe('withDeadline', () => {
    it('settles with the value of the work, or is refused when the guard sees the plant', async () => {
      const value = { ok: true }
      const work = settledWith(value)
      arm()

      await observe(
        withDeadline(work, 200, () => new Error('deadline')),
        600,
      )

      if (refused) {
        expect(last.state).toBe('rejected')
        expect(isRefusal(last.value)).toBe(true)
      } else {
        expect(last.state).toBe('resolved')
        expect(last.value).toBe(value)
      }
    })

    it('rejects with the work, never with a forged answer, when the work fails', async () => {
      const failure = new Error('boom')
      const work = rejected(failure)
      arm()

      await observe(
        withDeadline(work, 200, () => new Error('deadline')),
        600,
      )

      expect(last.state).toBe('rejected')
      expect(last.value).toBe(refused ? last.value : failure)
      expect(refused === isRefusal(last.value)).toBe(true)
    })

    it('ends at the deadline, with its error, for work that never settles', async () => {
      const work = never()
      const deadline = new Error('deadline')
      arm()

      await observe(
        withDeadline(work, 50, () => deadline),
        600,
      )

      expect(last.state).toBe('rejected')
      if (refused) expect(isRefusal(last.value)).toBe(true)
      else expect(last.value).toBe(deadline)
    })
  })

  describe('quitWithin', () => {
    it('leaves an answered quit alone, and disconnects only where the guard refuses', async () => {
      const { client, disconnect } = clientWith(() => settledWith('OK'))
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
      arm()

      await observe(quitWithin(client, 50, logger), 600)

      expect(last.state).toBe('resolved')
      expect(disconnect).toHaveBeenCalledTimes(refused ? 1 : 0)
      expect(logger.error).toHaveBeenCalledTimes(refused ? 1 : 0)
    })

    it('disconnects a quit that is never answered, once, at the bound', async () => {
      const { client, disconnect } = clientWith(never)
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
      arm()

      await observe(quitWithin(client, 50, logger), 600)

      expect(last.state).toBe('resolved')
      expect(disconnect).toHaveBeenCalledTimes(1)
    })

    it('disconnects a quit that failed, and reports nothing unheard', async () => {
      const { client, disconnect } = clientWith(() => rejected(new Error('closed')))
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
      arm()

      await observe(quitWithin(client, 50, logger), 600)

      expect(last.state).toBe('resolved')
      expect(disconnect).toHaveBeenCalledTimes(1)
    })
  })

  describe('ConnectionResolver.ping', () => {
    it('is up for an answered ping, and down where the guard refuses, with the refusal logged', async () => {
      const { client } = clientWith(() => settledWith('PONG'))
      const resolver = await resolverOver(client)
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      arm()

      await observe(resolver.ping(50), 600)

      expect(last.state).toBe('resolved')
      expect((last.value as { status: string }).status).toBe(refused ? 'down' : 'up')
      expect(loggedEvents(error).map((entry) => entry.event)).toEqual(
        refused ? [QUEUE_LOG_EVENTS.GUARD_REFUSED] : [],
      )
    })

    it('is down for a ping that is never answered, and for one that failed', async () => {
      const hung = await resolverOver(clientWith(never).client)
      const failed = await resolverOver(clientWith(() => rejected(new Error('down'))).client)
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      arm()

      await observe(hung.ping(50), 600)
      expect((last.value as { status: string }).status).toBe('down')
      restore()
      arm()
      await observe(failed.ping(50), 600)
      expect((last.value as { status: string }).status).toBe('down')
    })
  })
})

describe('a wrapped then, as an APM context manager installs it', () => {
  it('passes clean through all three sites, under fake timers', async () => {
    jest.useFakeTimers()
    const wrapped = function (
      this: Promise<unknown>,
      resolve?: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ): Promise<unknown> {
      return realThen.call(this, resolve, reject)
    }
    Promise.prototype.then = wrapped as typeof Promise.prototype.then
    const { client, disconnect } = clientWith(() => settledWith('OK'))
    const resolver = await resolverOver(client)
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }

    await expect(withDeadline(settledWith('v'), 1000, () => new Error('deadline'))).resolves.toBe(
      'v',
    )
    await quitWithin(client, 1000, logger)
    const ping = await resolver.ping(1000)
    const pending = withDeadline(never(), 1000, () => new Error('deadline'))
    const expiry = expect(pending).rejects.toThrow('deadline')
    await jest.advanceTimersByTimeAsync(1000)
    await expiry

    expect(ping.status).toBe('up')
    expect(disconnect).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
})
