/**
 * @fileoverview Unit tests for the worker option bounds: whole numbers where BullMQ takes counts,
 * and a supported range for the two timers that govern lock renewal and the stalled-job check.
 * BullMQ `Worker` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import type { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { WorkerOptions } from '../interfaces/worker-options.interface'

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() =>
    Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    }),
  ),
}))

/** A connection stub whose duplicates can be quit or disconnected. */
function fakeConnection(): ConnectionResolver {
  const redis = {
    duplicate: jest.fn().mockImplementation(() => ({
      status: 'ready',
      disconnect: jest.fn(),
      quit: jest.fn<Promise<string>, []>().mockResolvedValue('OK'),
    })),
  } as unknown as Redis
  return { getClient: jest.fn<Redis, []>().mockReturnValue(redis) } as unknown as ConnectionResolver
}

const resolved: ResolvedQueueOptions = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: false },
  metrics: { enabled: false, cacheTtlMs: 5000 },
  shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
}

/** The reason and actual value of the exception registering `options` throws, or undefined. */
function refusal(options: WorkerOptions): { reason: string; actual: unknown } | undefined {
  const registry = new WorkerRegistry(fakeConnection(), resolved)
  try {
    registry.register({ queueName: 'q', handler: () => Promise.resolve(), options })
  } catch (err) {
    const { error } = (err as QueueException).getResponse() as {
      error: { details: { reason: string; actual: unknown } }
    }
    return error.details
  }
  return undefined
}

describe('WorkerRegistry — counts must be whole numbers', () => {
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses concurrency %s', (bad) => {
    // NaN is neither < 1 nor > the cap, so a range check alone lets it through to BullMQ.
    expect(refusal({ concurrency: bad })).toStrictEqual({
      reason: 'concurrency must be a whole number',
      actual: bad,
    })
  })

  it.each([
    ['max', { max: 1.5, duration: 1000 }],
    ['max', { max: Number.NaN, duration: 1000 }],
    ['duration', { max: 1, duration: 0.5 }],
    ['duration', { max: 1, duration: Number.NaN }],
  ] as const)('refuses a non-whole limiter.%s', (field, limiter) => {
    expect(refusal({ limiter })?.reason).toBe(`limiter.${field} must be a whole number`)
  })
})

describe('WorkerRegistry — lockDuration and stalledInterval', () => {
  it.each(['lockDuration', 'stalledInterval'] as const)(
    'refuses %s outside 1000..2147483647, and says why',
    (key) => {
      for (const bad of [999, 0, -1, 1000.5, Number.NaN, 2_147_483_648]) {
        expect(refusal({ [key]: bad })).toStrictEqual({
          reason: `${key} must be a whole number from 1000 to 2147483647`,
          actual: bad,
        })
      }
    },
  )

  it.each(['lockDuration', 'stalledInterval'] as const)(
    'accepts the ends of the range for %s',
    (key) => {
      expect(refusal({ [key]: 1000 })).toBeUndefined()
      expect(refusal({ [key]: 2_147_483_647 })).toBeUndefined()
    },
  )
})
