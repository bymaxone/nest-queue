/**
 * @fileoverview Unit tests for `ConnectionResolver.ping`, the readiness ping: `up` when Redis answers
 * in time, `down` when it fails, does not answer in the bound or the caller stops waiting, never an
 * error text, no timer or listener left behind, and `down` plus a logged event when the prototype guard
 * refuses.
 * @layer server/services
 */

import { getEventListeners } from 'node:events'
import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { QUEUE_LOG_EVENTS } from '../utils/log-event'
import { loggedEvents } from '../utils/log-lines'
import { ConnectionResolver } from './connection-resolver.service'

/** A resolver whose client answers `ping` with `ping`, adopted as a BYO client. */
async function resolverWith(ping: () => Promise<unknown>): Promise<ConnectionResolver> {
  const probe = {
    status: 'ready',
    options: { maxRetriesPerRequest: null },
    on: jest.fn(),
    disconnect: jest.fn(),
  }
  const client = {
    status: 'ready',
    options: { maxRetriesPerRequest: 20 },
    duplicate: () => probe,
    on: jest.fn(),
    off: jest.fn(),
    ping,
  } as unknown as Redis
  const resolver = new ConnectionResolver({ connection: { client } })
  await resolver.init()
  return resolver
}

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  Reflect.deleteProperty(Object.prototype, 'zzPlanted')
})

describe('ConnectionResolver.ping', () => {
  it('is up when Redis answers, with the connection mode as detail', async () => {
    const resolver = await resolverWith(() => Promise.resolve('PONG'))

    await expect(resolver.ping(2000)).resolves.toEqual({
      status: 'up',
      details: { mode: 'mode-a-byo' },
    })
  })

  it('answers with objects that have no prototype, so a `then` planted on Object.prototype is never read', async () => {
    const resolver = await resolverWith(() => Promise.resolve('PONG'))

    const result = await resolver.ping(2000)

    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(Object.getPrototypeOf(result.details)).toBeNull()
  })

  it('is down when the ping fails, and says nothing of the error', async () => {
    const resolver = await resolverWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED redis://user:SENTINEL@host:6379')),
    )

    const result = await resolver.ping(2000)

    expect(result).toEqual({ status: 'down', details: { mode: 'mode-a-byo' } })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
  })

  it('is down when Redis does not answer within the bound, and up just inside it', async () => {
    jest.useFakeTimers()
    const hung = await resolverWith(() => new Promise<string>(() => undefined))
    const pending = hung.ping(2000)
    await jest.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toMatchObject({ status: 'down' })

    const late = await resolverWith(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('PONG')
          }, 1999)
        }),
    )
    const inside = late.ping(2000)
    await jest.advanceTimersByTimeAsync(1999)
    await expect(inside).resolves.toMatchObject({ status: 'up' })
  })

  it('is down at once when the caller stops waiting, and when it already has', async () => {
    jest.useFakeTimers()
    const resolver = await resolverWith(() => new Promise<string>(() => undefined))
    const stopping = new AbortController()
    const pending = resolver.ping(2000, stopping.signal)
    stopping.abort()
    await jest.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toMatchObject({ status: 'down' })

    const stopped = resolver.ping(2000, AbortSignal.abort())
    await jest.advanceTimersByTimeAsync(0)
    await expect(stopped).resolves.toMatchObject({ status: 'down' })
  })

  it('removes its listener from the signal and leaves no timer behind once it has answered', async () => {
    jest.useFakeTimers()
    const resolver = await resolverWith(() => Promise.resolve('PONG'))
    const signal = new AbortController().signal

    await resolver.ping(2000, signal)

    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('is down, and leaves no rejection unheard, when the client throws before it can ping', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const resolver = await resolverWith(() => {
      throw new Error('not connected')
    })

    const result = await resolver.ping(2000, AbortSignal.abort())
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)

    expect(result.status).toBe('down')
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('rejects, as getMode does, when the connection is not initialised', async () => {
    const resolver = new ConnectionResolver({ connection: {} as never })

    await expect(resolver.ping(2000)).rejects.toMatchObject({ name: 'QueueException' })
  })

  it('is down and logs the refusal, without pinging, when the prototype is polluted at entry', async () => {
    const ping = jest.fn().mockResolvedValue('PONG')
    const resolver = await resolverWith(ping)
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    ;(Object.prototype as Record<string, unknown>).zzPlanted = 'planted'

    const result = await resolver.ping(2000)

    expect(result.status).toBe('down')
    expect(ping).not.toHaveBeenCalled()
    expect(loggedEvents(error)).toMatchObject([
      { event: QUEUE_LOG_EVENTS.GUARD_REFUSED, site: 'health' },
    ])
  })
})
