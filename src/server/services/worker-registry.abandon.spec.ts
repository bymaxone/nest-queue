/**
 * @fileoverview Unit tests for a worker the lifecycle stopped without draining: the result a
 * handler produces after that must be dropped, so BullMQ's `pause` never resumes and reopens the
 * worker's blocking connection. BullMQ's `Worker` is mocked, so the processor the registry hands it
 * is called directly.
 * @layer server/services
 */

import { Logger } from '@nestjs/common'
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
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor | string) => {
    const worker = Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    })
    // For a file, BullMQ builds the processor itself and keeps it on the worker. The path with
    // `no-member` stands for a BullMQ that keeps it somewhere else.
    if (typeof processor === 'string' && !processor.includes('no-member'))
      return Object.assign(worker, { processFn: () => Promise.resolve('from-the-file') })
    if (typeof processor === 'function') processors.push(processor)
    return worker
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
  metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
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

/** Whether `promise` is still pending after the microtasks and 20 ms of the fake clock have run. */
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
  await jest.advanceTimersByTimeAsync(20)
  return !settled
}

// A handler with a `jobTimeoutMs` leaves the deadline timer of an abandoned run pending by design;
// on the fake clock it ends with the case and holds nothing open.
beforeEach(() => {
  processors.length = 0
  jest.useFakeTimers()
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
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

describe('a sandboxed worker stopped without draining', () => {
  // The registry cannot wrap a file, so it wraps what BullMQ built from it, right after construction.
  it('drops the result its processor produces after the stop, and not before', async () => {
    const registry = new WorkerRegistry(fakeConnection(), options)
    const worker = registry.registerSandboxed({
      queueName: 'q',
      processorFile: '/processors/job.js',
    }) as unknown as { processFn: () => Promise<unknown> }

    await expect(worker.processFn()).resolves.toBe('from-the-file')

    abandonWorker(worker)
    let settled = false
    void worker.processFn().then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(20)
    expect(settled).toBe(false)
  })

  // Without the member the outcome cannot be dropped, and nothing else would say so.
  it('warns once, with the queue alone, for each worker it could not wrap', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new WorkerRegistry(fakeConnection(), options)

    registry.registerSandboxed({ queueName: 'wrapped', processorFile: '/processors/job.js' })
    registry.registerSandboxed({ queueName: 'bare', processorFile: '/processors/no-member.js' })

    expect(warn.mock.calls).toEqual([
      [
        {
          event: 'QUEUE_SANDBOX_SHUTDOWN_UNGUARDED',
          message: expect.stringContaining('is not dropped') as string,
          queue: 'bare',
        },
      ],
    ])
    warn.mockRestore()
  })
})
