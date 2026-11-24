/**
 * @fileoverview Unit tests for the queue's readiness indicator: it asks the connection to ping inside
 * the 2 s bound with the aggregator's signal, and reports the connection's answer as it is. The wait
 * itself, and every way it can fail closed, is held by the specs of `ConnectionResolver.ping`.
 * @layer observability
 */

import 'reflect-metadata'
import { BYMAX_HEALTH_INDICATOR_METADATA } from '@bymax-one/nest-core/health'
import type { ConnectionResolver } from '@bymax-one/nest-queue'
import { QueueHealthIndicator, QUEUE_HEALTH_INDICATOR_NAME } from './queue-health.indicator'

/** An indicator over a connection whose `ping` is `ping`. */
function indicatorWith(ping: jest.Mock): QueueHealthIndicator {
  return new QueueHealthIndicator({ ping } as unknown as ConnectionResolver)
}

describe('QueueHealthIndicator', () => {
  it('is marked so @bymax-one/nest-core finds it, and is named queue', () => {
    expect(Reflect.getMetadata(BYMAX_HEALTH_INDICATOR_METADATA, QueueHealthIndicator)).toBe(true)
    expect(indicatorWith(jest.fn()).name).toBe(QUEUE_HEALTH_INDICATOR_NAME)
    expect(QUEUE_HEALTH_INDICATOR_NAME).toBe('queue')
  })

  it('asks the connection to ping inside two seconds, with the signal of the aggregator', () => {
    const ping = jest.fn().mockResolvedValue({ status: 'up' })
    const signal = new AbortController().signal

    void indicatorWith(ping).check(signal)

    expect(ping).toHaveBeenCalledTimes(1)
    expect(ping).toHaveBeenCalledWith(2000, signal)
  })

  it('reports the answer of the connection as it is, up and down', async () => {
    const up = { status: 'up', details: { mode: 'A' } }
    const down = { status: 'down', details: { mode: 'A' } }

    await expect(indicatorWith(jest.fn().mockResolvedValue(up)).check()).resolves.toBe(up)
    await expect(indicatorWith(jest.fn().mockResolvedValue(down)).check()).resolves.toBe(down)
  })

  it('rejects when the connection is not initialised, as the connection does', async () => {
    const failure = new Error('not initialized')

    await expect(indicatorWith(jest.fn().mockRejectedValue(failure)).check()).rejects.toBe(failure)
  })
})
