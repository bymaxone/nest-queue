/**
 * @fileoverview Unit tests for a worker the lifecycle stopped without draining: the result a
 * handler produces after that must be dropped, so BullMQ's `pause` never resumes and reopens the
 * worker's blocking connection. BullMQ's `Worker` is mocked, so the processor the registry hands it
 * is called directly.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import { abandonWorker, isAbandoned } from '../utils/abandoned-workers'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

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

const options: ResolvedQueueOptions = {
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

const job = { id: '1', name: 'send', data: {} } as unknown as Job

/** Register a worker with `handler` (and `jobTimeoutMs` when given) and return it with its processor. */
function registered(
  handler: () => Promise<unknown>,
  jobTimeoutMs?: number,
): { worker: object; processor: Processor } {
  const registry = new WorkerRegistry(fakeConnection(), options)
  const worker = registry.register({
    queueName: 'q',
    handler,
    ...(jobTimeoutMs === undefined ? {} : { options: { jobTimeoutMs } }),
  })
  const processor = processors.at(-1)
  if (processor === undefined) throw new Error('no processor registered')
  return { worker, processor }
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

beforeEach(() => {
  processors.length = 0
})

describe('a worker stopped without draining', () => {
  it.each([undefined, 3000])(
    'drops the result of a handler that settles afterwards (jobTimeoutMs %s)',
    async (jobTimeoutMs) => {
      let finish: (value: string) => void = () => undefined
      const { worker, processor } = registered(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
        jobTimeoutMs,
      )

      const running = processor(job)
      abandonWorker(worker)
      finish('late result')

      expect(await stillPending(running)).toBe(true)
    },
  )

  it.each([undefined, 3000])(
    'drops the failure of a handler that fails afterwards (jobTimeoutMs %s)',
    async (jobTimeoutMs) => {
      let fail: (reason: Error) => void = () => undefined
      const { worker, processor } = registered(
        () =>
          new Promise<string>((_resolve, reject) => {
            fail = reject
          }),
        jobTimeoutMs,
      )

      const running = processor(job)
      abandonWorker(worker)
      fail(new Error('late failure'))

      expect(await stillPending(running)).toBe(true)
    },
  )

  it('keeps delivering results and failures while the worker is not abandoned', async () => {
    const ok = registered(() => Promise.resolve('done'))
    const boom = new Error('boom')
    const bad = registered(() => Promise.reject(boom))

    await expect(ok.processor(job)).resolves.toBe('done')
    await expect(bad.processor(job)).rejects.toBe(boom)
  })

  it('marks only the worker it was given', () => {
    const first = registered(() => Promise.resolve())
    const second = registered(() => Promise.resolve())

    abandonWorker(first.worker)

    expect(isAbandoned(first.worker)).toBe(true)
    expect(isAbandoned(second.worker)).toBe(false)
  })

  // BullMQ creates the per-job signal only for a processor that declares three parameters.
  it('still declares three parameters', () => {
    expect(registered(() => Promise.resolve()).processor.length).toBe(3)
  })
})
