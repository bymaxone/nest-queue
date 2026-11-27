/**
 * @fileoverview Unit tests for the job a processor hands its handler and the guard that runs again
 * once the handler has settled: the job's options hold their own values before the handler runs, a
 * key planted while the handler ran is refused on both outcomes, and a worker the shutdown abandoned
 * still never settles. BullMQ's `Worker` is mocked, so the processor is called directly.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import { abandonWorker } from '../utils/abandoned-workers'
import { JOB_OPTION_KEYS } from '../config/snapshot-options'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

type Processor = (job: Job, token?: string, signal?: AbortSignal) => Promise<unknown>

const processors: Processor[] = []

jest.mock('bullmq', () => ({
  DelayedError: jest.requireActual<{ DelayedError: unknown }>('bullmq').DelayedError,
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    processors.push(processor)
    return Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    })
  }),
}))

const options = {
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
} as unknown as ResolvedQueueOptions

/** A connection stub whose client can be duplicated for a worker. */
function connection(): ConnectionResolver {
  const redis = {
    duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
  } as unknown as Redis
  return { getClient: jest.fn().mockReturnValue(redis) } as unknown as ConnectionResolver
}

/** The keys `Object.prototype` holds before any test plants one. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

/** A job with its own, enumerable options, as BullMQ rebuilds them. */
function jobWithOptions(opts: object | undefined): Job {
  return { id: '1', name: 'send', data: {}, opts } as unknown as Job
}

/** Register a worker over `handler`, returning it with its processor. */
function registered(handler: (job: Job) => Promise<unknown>): {
  worker: object
  processor: Processor
} {
  const worker = new WorkerRegistry(connection(), options).register({ queueName: 'q', handler })
  const processor = processors.at(-1)
  if (processor === undefined) throw new Error('no processor registered')
  return { worker, processor }
}

/** The code of a refusal, or the error itself when it is something else. */
function codeOf(error: unknown): unknown {
  if (!(error instanceof QueueException)) return error
  return (error.getResponse() as { error: { code: string } }).error.code
}

/** Whether `promise` is still pending after the microtasks and a short timer have run. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return !settled
}

/** Plant a key by plain assignment, as pollution does. */
function plant(key: string): void {
  ;(Object.prototype as Record<string, unknown>)[key] = 1
}

beforeEach(() => {
  processors.length = 0
})

afterEach(() => {
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD.has(n))
  for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
  if (extra.length > 0) throw new Error('a test left a key on Object.prototype')
})

describe('the options of the job the handler is given', () => {
  it('hold an own value for every job option before the handler runs', async () => {
    const seen: boolean[] = []
    const opts = { attempts: 2 }
    const { processor } = registered((job) => {
      for (const key of JOB_OPTION_KEYS) seen.push(Object.hasOwn(job.opts, key))
      return Promise.resolve('done')
    })

    await expect(processor(jobWithOptions(opts))).resolves.toBe('done')

    expect(seen).toHaveLength(JOB_OPTION_KEYS.length)
    expect(seen.every(Boolean)).toBe(true)
    expect(opts.attempts).toBe(2)
  })
})

describe('a key planted while the handler runs', () => {
  it('is refused with the typed refusal when the handler resolves', async () => {
    const { processor } = registered(() => {
      plant('zz')
      return Promise.resolve('done')
    })

    const error: unknown = await processor(jobWithOptions({}))
      .catch((caught: unknown) => caught)
      .finally(() => Reflect.deleteProperty(Object.prototype, 'zz'))

    expect(codeOf(error)).toBe('queue.invalid_options')
  })

  it('is refused with the typed refusal, not the failure, when the handler rejects', async () => {
    const { processor } = registered(() => {
      plant('zz')
      return Promise.reject(new Error('handler failed'))
    })

    const error: unknown = await processor(jobWithOptions({}))
      .catch((caught: unknown) => caught)
      .finally(() => Reflect.deleteProperty(Object.prototype, 'zz'))

    expect(codeOf(error)).toBe('queue.invalid_options')
  })

  it('does not change the failure a handler gives on a clean prototype', async () => {
    const boom = new Error('boom')
    const { processor } = registered(() => Promise.reject(boom))

    await expect(processor(jobWithOptions({}))).rejects.toBe(boom)
  })
})

describe('a worker abandoned before the handler settles', () => {
  it.each(['resolves', 'rejects'] as const)(
    'still never settles when the handler %s',
    async (how) => {
      let settle: () => void = () => undefined
      const { worker, processor } = registered(
        () =>
          new Promise<string>((resolve, reject) => {
            settle = () => {
              if (how === 'resolves') resolve('late')
              else reject(new Error('late'))
            }
          }),
      )

      const running = processor(jobWithOptions({}))
      abandonWorker(worker)
      settle()

      expect(await stillPending(running)).toBe(true)
    },
  )

  it.each(['resolves', 'rejects'] as const)(
    'still never settles when the handler %s while a key is planted',
    async (how) => {
      let settle: () => void = () => undefined
      const { worker, processor } = registered(
        () =>
          new Promise<string>((resolve, reject) => {
            settle = () => {
              if (how === 'resolves') resolve('late')
              else reject(new Error('late'))
            }
          }),
      )

      const running = processor(jobWithOptions({}))
      abandonWorker(worker)
      plant('zzAbandoned')
      try {
        settle()

        expect(await stillPending(running)).toBe(true)
      } finally {
        Reflect.deleteProperty(Object.prototype, 'zzAbandoned')
      }
    },
  )
})
