/**
 * @fileoverview Unit tests for how the worker registry reports an attempt to the observers: the
 * processor BullMQ is given runs inside the observers' process span with the headers stored with the
 * job, and the outcome and duration of each attempt are reported. With no registry the processor is
 * the handler and nothing else. BullMQ `Worker` is mocked, so the processor is called directly.
 * @layer server/services
 */

import { QueueException } from '../errors/queue-exception'
import type { Job } from 'bullmq'
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import { QueueObserverRegistry } from '../observability/queue-observer'
import type { JobFinishedEvent } from '../observability/queue-observer'
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

/** The part of BullMQ's move this reads: it finishes the job when no attempt is left. */
function moveToFailed(this: Job): Promise<void> {
  if (this.attemptsMade + 1 >= (this.opts.attempts ?? 1)) this.finishedOn = 1
  return Promise.resolve()
}

/** Run one attempt and, when it throws, move the job as BullMQ does before it rethrows. */
async function attempt(processor: Processor, job: Job): Promise<unknown> {
  try {
    return await processor(job)
  } catch (error) {
    await job.moveToFailed(error as Error, 'token')
    throw error
  }
}

/** A job as the worker receives it. */
function jobWith(metadata: string | undefined, attemptsMade = 0, attempts = 2): Job {
  return {
    id: '7',
    name: 'send',
    data: {},
    attemptsMade,
    opts: { attempts, ...(metadata === undefined ? {} : { telemetry: { metadata } }) },
    moveToFailed,
  } as unknown as Job
}

/** Register a handler on `queue`, with an observer registry when one is given. */
function registered(
  handler: (job: Job) => Promise<unknown>,
  observers?: QueueObserverRegistry,
): Processor {
  const registry =
    observers === undefined
      ? new WorkerRegistry(fakeConnection(), options)
      : new WorkerRegistry(fakeConnection(), options, observers)
  registry.register({ queueName: 'email', handler })
  const processor = processors.at(-1)
  if (processor === undefined) throw new Error('no processor registered')
  return processor
}

beforeEach(() => {
  processors.length = 0
})

describe('WorkerRegistry — observed attempts', () => {
  it('runs the handler inside the process span with the stored headers, and reports completed', async () => {
    const observers = new QueueObserverRegistry()
    const finished: JobFinishedEvent[] = []
    const seen: unknown[] = []
    observers.register({
      traceProcess: (info, carrier, run) => {
        seen.push({ info, carrier })
        return run()
      },
      jobFinished: (event) => finished.push(event),
    })
    const processor = registered(() => Promise.resolve('sent'), observers)

    const result = await processor(jobWith(JSON.stringify({ traceparent: 'tp' })))

    expect(result).toBe('sent')
    expect(seen).toEqual([
      { info: { queue: 'email', job: 'send' }, carrier: { traceparent: 'tp' } },
    ])
    expect(finished).toMatchObject([{ queue: 'email', outcome: 'completed' }])
  })

  it('reports retried for an attempt that failed with attempts left, and rethrows the error', async () => {
    const observers = new QueueObserverRegistry()
    const finished: JobFinishedEvent[] = []
    observers.register({ jobFinished: (event) => finished.push(event) })
    const error = new Error('boom')
    const processor = registered(() => Promise.reject(error), observers)

    await expect(attempt(processor, jobWith(undefined, 0, 2))).rejects.toBe(error)

    expect(finished).toMatchObject([{ queue: 'email', outcome: 'retried' }])
  })

  it('reports failed for the last attempt', async () => {
    const observers = new QueueObserverRegistry()
    const finished: JobFinishedEvent[] = []
    observers.register({ jobFinished: (event) => finished.push(event) })
    const processor = registered(() => Promise.reject(new Error('boom')), observers)

    await attempt(processor, jobWith(undefined, 1, 2)).catch(() => undefined)

    expect(finished).toMatchObject([{ outcome: 'failed' }])
  })

  it('is the handler alone when no observer registry is given', async () => {
    const processor = registered(() => Promise.resolve('plain'))

    await expect(processor(jobWith(undefined))).resolves.toBe('plain')
  })

  it('reports the refusal of a key planted while the handler ran as a failed attempt, never as completed', async () => {
    const observers = new QueueObserverRegistry()
    const finished: JobFinishedEvent[] = []
    observers.register({ jobFinished: (event) => finished.push(event) })
    const processor = registered(() => {
      ;(Object.prototype as Record<string, unknown>).zzPlantedInTheHandler = 1
      return Promise.resolve('done')
    }, observers)

    try {
      await expect(attempt(processor, jobWith(undefined, 0, 1))).rejects.toBeInstanceOf(
        QueueException,
      )
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlantedInTheHandler')
    }

    expect(finished).toMatchObject([{ queue: 'email', outcome: 'failed' }])
  })

  it('reports the refusal, not the handler error, when a key is planted while the handler rejects', async () => {
    const observers = new QueueObserverRegistry()
    const finished: JobFinishedEvent[] = []
    observers.register({ jobFinished: (event) => finished.push(event) })
    const processor = registered(() => {
      ;(Object.prototype as Record<string, unknown>).zzPlantedBeforeRejecting = 1
      return Promise.reject(new Error('the handler failed'))
    }, observers)

    try {
      await expect(attempt(processor, jobWith(undefined, 0, 1))).rejects.toBeInstanceOf(
        QueueException,
      )
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlantedBeforeRejecting')
    }

    expect(finished).toMatchObject([{ queue: 'email', outcome: 'failed' }])
  })

  it('leaves the move to BullMQ and says retried when a planted key is still there as the job moves', async () => {
    const observers = new QueueObserverRegistry()
    const finished: JobFinishedEvent[] = []
    observers.register({ jobFinished: (event) => finished.push(event) })
    const processor = registered(() => {
      ;(Object.prototype as Record<string, unknown>).zzPlantedAcrossTheMove = 1
      return Promise.reject(new Error('the handler failed'))
    }, observers)
    const next = ['the next job']
    let moved = false
    const job = Object.assign(jobWith(undefined, 0, 2), {
      moveToFailed: async (): Promise<unknown> => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        moved = true
        return next
      },
    }) as unknown as Job
    let result: unknown
    let movedWhenAnswered: boolean | undefined

    try {
      await expect(processor(job)).rejects.toBeInstanceOf(QueueException)
      result = await job.moveToFailed(new Error('x'), 'token')
      movedWhenAnswered = moved
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlantedAcrossTheMove')
    }

    expect(movedWhenAnswered).toBe(true)
    expect(result).toBe(next)
    expect(finished).toMatchObject([{ queue: 'email', outcome: 'retried' }])
  })
})
