/**
 * @fileoverview Unit tests that the ready-wait builds its promise from the intrinsic constructor: a
 * host that replaced the global `Promise` binding after load, with one that counts what it builds,
 * is asked for nothing, whether the client is already ready or still connecting.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'

jest.mock('ioredis', () => ({
  AbstractConnector: jest.requireActual<{ AbstractConnector: unknown }>('ioredis')
    .AbstractConnector,
  Redis: jest.fn(),
}))

/** A scripted client: a status and the events ioredis emits. */
class FakeRedis extends EventEmitter {
  status: string
  readonly options: { maxRetriesPerRequest: number | null } = { maxRetriesPerRequest: 20 }
  readonly duplicate = jest.fn()
  readonly disconnect = jest.fn()

  constructor(status: string) {
    super()
    this.status = status
  }
}

/** The binding as the host found it, put back after each test. */
const GLOBAL_PROMISE = globalThis.Promise

afterEach(() => {
  globalThis.Promise = GLOBAL_PROMISE
})

/** A resolver over a bring-your-own client in the given status, initialised past the probe. */
async function resolverFor(
  status: string,
): Promise<{ resolver: ConnectionResolver; client: FakeRedis }> {
  const probe = new FakeRedis('ready')
  probe.options.maxRetriesPerRequest = null
  const client = new FakeRedis('ready')
  client.duplicate.mockReturnValue(probe)
  const resolver = new ConnectionResolver({ connection: { client: client as unknown as Redis } })
  await resolver.init()
  client.status = status
  return { resolver, client }
}

/** Replace the global binding with a subclass that counts every promise it is asked to build. */
function countGlobalBuilds(): { built: () => number } {
  let built = 0
  globalThis.Promise = class Counting<T> extends GLOBAL_PROMISE<T> {
    constructor(
      executor: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
    ) {
      built += 1
      super(executor)
    }
  } as PromiseConstructor
  return { built: () => built }
}

describe('ConnectionResolver.awaitReady under a replaced global Promise', () => {
  it('builds nothing from the binding when the client is ready', async () => {
    const { resolver } = await resolverFor('ready')
    const counting = countGlobalBuilds()

    const wait = resolver.awaitReady()
    const builtByTheCall = counting.built()
    globalThis.Promise = GLOBAL_PROMISE

    await expect(wait).resolves.toBeUndefined()
    expect(builtByTheCall).toBe(0)
  })

  it('builds nothing from the binding while the client is connecting, and still settles on ready', async () => {
    const { resolver, client } = await resolverFor('connecting')
    const counting = countGlobalBuilds()

    const wait = resolver.awaitReady()
    const builtByTheCall = counting.built()
    globalThis.Promise = GLOBAL_PROMISE
    client.status = 'ready'
    client.emit('ready')

    await expect(wait).resolves.toBeUndefined()
    expect(builtByTheCall).toBe(0)
  })
})
