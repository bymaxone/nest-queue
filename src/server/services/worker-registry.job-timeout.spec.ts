/**
 * @fileoverview Unit tests for the per-job timeout and the abort signal a handler receives.
 * BullMQ `Worker` is mocked, so the processor the registry hands it is called directly.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { EventEmitter, getEventListeners } from 'node:events'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** The processor BullMQ is given, as the registry built it. */
type Processor = (job: Job, token?: string, signal?: AbortSignal) => Promise<unknown>

const processors: Processor[] = []

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    processors.push(processor)
    return Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    })
  }),
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

/** Resolved options for the registry under test. */
function makeOptions(): ResolvedQueueOptions {
  return {
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
}

const job = { id: '7', name: 'send', data: {} } as unknown as Job

/** The processor registered for `jobTimeoutMs`, or for no timeout when it is undefined. */
function registered(
  handler: (job: Job, signal?: AbortSignal) => Promise<unknown>,
  jobTimeoutMs?: number,
): Processor {
  const registry = new WorkerRegistry(fakeConnection(), makeOptions())
  registry.register({
    queueName: 'q',
    handler,
    ...(jobTimeoutMs === undefined ? {} : { options: { jobTimeoutMs } }),
  })
  const processor = processors.at(-1)
  if (processor === undefined) throw new Error('no processor registered')
  return processor
}

beforeEach(() => {
  processors.length = 0
})

afterEach(() => {
  jest.useRealTimers()
})

describe('WorkerRegistry — jobTimeoutMs', () => {
  // A handler that never settles must not keep its job alive beyond the configured deadline.
  it('rejects a job that outlives the timeout and aborts its signal', async () => {
    jest.useFakeTimers()
    let seen: AbortSignal | undefined
    const processor = registered((_job, signal) => {
      seen = signal
      return new Promise<unknown>(() => undefined)
    }, 3000)

    const outcome = processor(job).catch((err: unknown) => err)
    await jest.advanceTimersByTimeAsync(2999)
    expect(seen?.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(1)

    const err = await outcome
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(QueueException)
    expect((err as Error).name).toBe('JobTimeoutError')
    expect((err as Error).message).toContain('queue.job_timeout')
    expect((err as Error).message).toContain('3000')
    expect(seen?.aborted).toBe(true)
    expect(seen?.reason).toBe(err)
  })

  it('returns the result and holds no timer when the handler settles in time', async () => {
    jest.useFakeTimers()
    const processor = registered(() => Promise.resolve('done'), 3000)

    await expect(processor(job)).resolves.toBe('done')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('rethrows the handler own failure unchanged', async () => {
    const boom = new Error('boom')
    const processor = registered(() => Promise.reject(boom), 3000)

    await expect(processor(job)).rejects.toBe(boom)
  })

  it('sets no timer and passes the signal BullMQ gave it through when no timeout is configured', async () => {
    jest.useFakeTimers()
    let seen: AbortSignal | undefined
    const outer = new AbortController()
    const processor = registered((_job, signal) => {
      seen = signal
      return Promise.resolve('ok')
    })

    await processor(job, 'token', outer.signal)

    expect(jest.getTimerCount()).toBe(0)
    expect(seen).toBe(outer.signal)
  })

  it("aborts the handler's signal when BullMQ's signal aborts mid-job, with a timeout configured", async () => {
    let seen: AbortSignal | undefined
    let finish: (value: string) => void = () => undefined
    const outer = new AbortController()
    const processor = registered((_job, signal) => {
      seen = signal
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }, 3000)

    const running = processor(job, 'token', outer.signal)
    await Promise.resolve()
    expect(seen?.aborted).toBe(false)
    outer.abort(new Error('shutdown'))
    expect(seen?.aborted).toBe(true)
    finish('ok')
    await running
  })
})

describe('WorkerRegistry — the signal BullMQ passes to the processor', () => {
  // The relay listener must be gone once the job settles, whichever way it ends.
  it("leaves no listener on BullMQ's signal after a job completes, fails or times out", async () => {
    jest.useFakeTimers()
    const outer = new AbortController()
    const finished = registered(() => Promise.resolve('ok'), 3000)
    const failing = registered(() => Promise.reject(new Error('boom')), 3000)
    const hung = registered(() => new Promise<unknown>(() => undefined), 3000)

    await finished(job, 't', outer.signal)
    await failing(job, 't', outer.signal).catch(() => undefined)
    const timedOut = hung(job, 't', outer.signal).catch(() => undefined)
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(3000)
    await timedOut

    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0)
  })

  // A handler typed to return a promise can still throw before it returns one.
  it("leaves no listener on BullMQ's signal when a handler throws synchronously", async () => {
    const outer = new AbortController()
    const boom = new Error('sync boom')
    const processor = registered(() => {
      throw boom
    }, 3000)

    await expect(processor(job, 't', outer.signal)).rejects.toBe(boom)

    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0)
  })

  it("aborts the handler signal at once when BullMQ's signal is already aborted", async () => {
    let seen: AbortSignal | undefined
    const outer = new AbortController()
    outer.abort(new Error('closing'))
    const processor = registered((_job, signal) => {
      seen = signal
      return Promise.resolve('ok')
    }, 3000)

    await processor(job, 't', outer.signal)

    expect(seen?.aborted).toBe(true)
  })
})

describe('WorkerRegistry — the processor BullMQ is given', () => {
  // BullMQ creates the per-job signal only for a processor that declares three parameters.
  it.each([undefined, 3000])('declares three parameters when jobTimeoutMs is %s', (timeout) => {
    expect(registered(() => Promise.resolve(), timeout).length).toBe(3)
  })
})

/** The `{ error: { code, details } }` envelope of the QueueException a call throws. */
function thrownEnvelope(call: () => unknown): { error: { code: string; details: unknown } } {
  try {
    call()
  } catch (err) {
    return (err as QueueException).getResponse() as { error: { code: string; details: unknown } }
  }
  throw new Error('the call did not throw')
}

describe('WorkerRegistry — jobTimeoutMs validation', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses %s when registering, and says why',
    (bad) => {
      const registry = new WorkerRegistry(fakeConnection(), makeOptions())

      const { error } = thrownEnvelope(() => {
        registry.register({
          queueName: 'q',
          handler: () => Promise.resolve(),
          options: { jobTimeoutMs: bad },
        })
      })

      expect(error.code).toBe('queue.worker_registration_failed')
      expect(error.details).toStrictEqual({
        reason: 'jobTimeoutMs must be a number from 1 to 2147483647',
        actual: bad,
      })
    },
  )

  it.each([1, 2_147_483_647])('accepts %s, the ends of the supported range', (ok) => {
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())

    expect(() =>
      registry.register({
        queueName: 'q',
        handler: () => Promise.resolve(),
        options: { jobTimeoutMs: ok },
      }),
    ).not.toThrow()
  })

  it('refuses the option for a sandboxed worker, whose processor runs out of process', () => {
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())

    const { error } = thrownEnvelope(() => {
      registry.registerSandboxed({
        queueName: 'q',
        processorFile: '/abs/processor.js',
        options: { jobTimeoutMs: 1000 },
      })
    })

    expect(error.details).toStrictEqual({
      reason: 'jobTimeoutMs is not available for sandboxed workers',
    })
  })
})
