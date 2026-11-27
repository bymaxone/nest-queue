/**
 * @fileoverview Unit tests for the worker option bounds: whole numbers where BullMQ takes counts,
 * and a supported range for the two timers that govern lock renewal and the stalled-job check.
 * BullMQ `Worker` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { Worker, type WorkerOptions as BullWorkerOptions } from 'bullmq'
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
  metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
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

describe('WorkerRegistry — limiter.duration has no ceiling', () => {
  // BullMQ sleeps a rate-limited worker for min(time left, maximumRateLimitDelay), 30 s by
  // default, and only passes the duration to Redis as an expiry, so a window above 2^31 - 1 ms
  // (about 24.8 days, e.g. "per month") is not a timer Node would cut to 1 ms.
  it.each([2_147_483_648, 2_592_000_000, Number.MAX_SAFE_INTEGER])(
    'accepts a limiter window of %s ms',
    (duration) => {
      expect(refusal({ limiter: { max: 1, duration } })).toBeUndefined()
    },
  )
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

describe('WorkerRegistry — maxStalledCount', () => {
  const built = (options: WorkerOptions): BullWorkerOptions | undefined => {
    jest.mocked(Worker).mockClear()
    new WorkerRegistry(fakeConnection(), resolved).register({
      queueName: 'q',
      handler: () => Promise.resolve(),
      options,
    })
    return jest.mocked(Worker).mock.calls[0]?.[2]
  }

  it.each([
    ['must be a whole number', 1.5],
    ['must be a whole number', Number.NaN],
    ['must be a whole number', Number.POSITIVE_INFINITY],
    ['must be >= 0', -1],
  ])('refuses a value that %s: %s', (rule, bad) => {
    // BullMQ accepts NaN here, and its stall script then never finds the limit exceeded.
    expect(refusal({ maxStalledCount: bad })).toStrictEqual({
      reason: `maxStalledCount ${rule}`,
      actual: bad,
    })
  })

  it.each([0, 1, 5, Number.MAX_SAFE_INTEGER])('hands %s to the BullMQ worker', (value) => {
    expect(built({ maxStalledCount: value })?.maxStalledCount).toBe(value)
  })

  it('leaves the BullMQ default in place when the option is not given', () => {
    const options = built({})
    expect(options).toBeDefined()
    expect(options).not.toHaveProperty('maxStalledCount')
  })

  it('hands the value to a sandboxed worker too', () => {
    jest.mocked(Worker).mockClear()
    new WorkerRegistry(fakeConnection(), resolved).registerSandboxed({
      queueName: 'sandboxed',
      processorFile: '/srv/processor.js',
      options: { maxStalledCount: 3 },
    })
    const options = jest.mocked(Worker).mock.calls[0]?.[2]
    expect(options?.maxStalledCount).toBe(3)
  })
})
