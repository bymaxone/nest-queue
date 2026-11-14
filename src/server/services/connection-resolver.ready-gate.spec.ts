/**
 * @fileoverview Unit tests for the shared ready-wait a cold queue's first call goes through while
 * the client is not ready. A scripted client stands in for ioredis.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'

jest.mock('ioredis', () => ({ Redis: jest.fn() }))

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

describe('ConnectionResolver.awaitReady', () => {
  it.each(['ready', 'wait', 'end'])('is already settled when the client is %s', async (status) => {
    // `wait` is a lazy client that connects on its first command, so gating it would deadlock;
    // `end` will never be ready and is left for the call itself to fail.
    const { resolver, client } = await resolverFor(status)
    const before = client.listenerCount('ready')

    await expect(resolver.awaitReady()).resolves.toBeUndefined()

    expect(client.listenerCount('ready')).toBe(before)
  })

  it.each(['connecting', 'connect', 'reconnecting', 'close'])(
    'waits for ready while the client is %s',
    async (status) => {
      const { resolver, client } = await resolverFor(status)
      let settled = false
      const wait = resolver.awaitReady().then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      client.status = 'ready'
      client.emit('ready')
      await wait

      expect(settled).toBe(true)
    },
  )

  // A health check that polls through a long outage must not add a listener set per poll.
  it('shares ONE wait among every caller, and gives its listener back when ready', async () => {
    const { resolver, client } = await resolverFor('reconnecting')
    const before = client.listenerCount('ready')

    const waits = Array.from({ length: 50 }, () => resolver.awaitReady())

    expect(client.listenerCount('ready')).toBe(before + 1)
    expect(new Set(waits).size).toBe(1)
    client.status = 'ready'
    client.emit('ready')
    await Promise.all(waits)
    expect(client.listenerCount('ready')).toBe(before)
  })

  it('opens a new wait for the next outage once the last one has settled', async () => {
    const { resolver, client } = await resolverFor('reconnecting')
    const first = resolver.awaitReady()
    client.status = 'ready'
    client.emit('ready')
    await first

    client.status = 'reconnecting'
    const second = resolver.awaitReady()

    expect(second).not.toBe(first)
    client.status = 'ready'
    client.emit('ready')
    await second
  })
})
