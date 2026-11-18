/**
 * @fileoverview Unit tests for the queue's readiness indicator: `up` when Redis answers a PING,
 * `down` when it fails, does not answer in time or the aggregator stops waiting, and never an error
 * text in the result.
 * @layer observability
 */

import 'reflect-metadata'
import { getEventListeners } from 'node:events'
import { BYMAX_HEALTH_INDICATOR_METADATA } from '@bymax-one/nest-core/health'
import type { ConnectionResolver } from '@bymax-one/nest-queue'
import { QueueHealthIndicator, QUEUE_HEALTH_INDICATOR_NAME } from './queue-health.indicator'

/** An indicator over a connection whose client answers `ping` with `ping`. */
function indicatorWith(ping: () => Promise<string>): QueueHealthIndicator {
  const connection = {
    getMode: () => 'A',
    getClient: () => ({ ping }),
  } as unknown as ConnectionResolver
  return new QueueHealthIndicator(connection)
}

afterEach(() => {
  jest.useRealTimers()
})

describe('QueueHealthIndicator', () => {
  it('is marked so @bymax-one/nest-core finds it, and is named queue', () => {
    expect(Reflect.getMetadata(BYMAX_HEALTH_INDICATOR_METADATA, QueueHealthIndicator)).toBe(true)
    expect(indicatorWith(() => Promise.resolve('PONG')).name).toBe(QUEUE_HEALTH_INDICATOR_NAME)
    expect(QUEUE_HEALTH_INDICATOR_NAME).toBe('queue')
  })

  it('is up when Redis answers, with the connection mode as detail', async () => {
    await expect(indicatorWith(() => Promise.resolve('PONG')).check()).resolves.toEqual({
      status: 'up',
      details: { mode: 'A' },
    })
  })

  it('is down when the ping fails, and says nothing of the error', async () => {
    const result = await indicatorWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED redis://user:SENTINEL@host:6379')),
    ).check()

    expect(result).toEqual({ status: 'down', details: { mode: 'A' } })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
  })

  it('is down when Redis does not answer within the bound', async () => {
    jest.useFakeTimers()
    const pending = indicatorWith(() => new Promise<string>(() => undefined)).check()

    await jest.advanceTimersByTimeAsync(2000)

    await expect(pending).resolves.toEqual({ status: 'down', details: { mode: 'A' } })
  })

  it('is still up when the answer comes just inside the bound', async () => {
    jest.useFakeTimers()
    const pending = indicatorWith(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('PONG')
          }, 1999)
        }),
    ).check()

    await jest.advanceTimersByTimeAsync(1999)

    await expect(pending).resolves.toMatchObject({ status: 'up' })
  })

  it('is down at once when the aggregator stops waiting, and when it already has', async () => {
    jest.useFakeTimers()
    const stopping = new AbortController()
    const pending = indicatorWith(() => new Promise<string>(() => undefined)).check(stopping.signal)
    stopping.abort()
    await jest.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toMatchObject({ status: 'down' })

    const stopped = indicatorWith(() => new Promise<string>(() => undefined)).check(
      AbortSignal.abort(),
    )
    await jest.advanceTimersByTimeAsync(0)
    await expect(stopped).resolves.toMatchObject({ status: 'down' })
  })

  it('removes its listener from the signal once it has answered', async () => {
    const signal = new AbortController().signal

    await indicatorWith(() => Promise.resolve('PONG')).check(signal)

    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('leaves no timer behind once it has answered', async () => {
    jest.useFakeTimers()

    await indicatorWith(() => Promise.resolve('PONG')).check()

    expect(jest.getTimerCount()).toBe(0)
  })
})
