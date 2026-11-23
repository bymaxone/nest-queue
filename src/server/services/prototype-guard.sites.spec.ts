/**
 * @fileoverview Unit tests for the call sites of the prototype guard: every add to a queue, every add
 * of a flow and every job a worker is given is refused when `Object.prototype` holds a key it does not
 * hold by default, before BullMQ is touched or the handler runs, and each runs normally when it is
 * clean. BullMQ's `Queue`, `FlowProducer` and `Worker` are mocked.
 * @layer server/services
 */

import { DelayedError } from 'bullmq'
import { EventEmitter } from 'node:events'
import type { FlowJob, Job } from 'bullmq'
import { FlowService } from './flow.service'
import { QueueService } from './queue.service'
import { QueueObserverRegistry } from '../observability/queue-observer'
import { JOB_OPTION_KEYS } from '../config/snapshot-options'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

type Processor = (job: Job, token?: string, signal?: AbortSignal) => Promise<unknown>

const queues: { add: jest.Mock; addBulk: jest.Mock; upsertJobScheduler: jest.Mock }[] = []
const producers: { add: jest.Mock; addBulk: jest.Mock }[] = []
const processors: Processor[] = []

jest.mock('bullmq', () => ({
  DelayedError: jest.requireActual<{ DelayedError: unknown }>('bullmq').DelayedError,
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue({ id: 'added' }),
      addBulk: jest.fn().mockResolvedValue([{ id: 'bulk' }]),
      upsertJobScheduler: jest.fn().mockResolvedValue({ id: 'scheduler' }),
      close: jest.fn().mockResolvedValue(undefined),
    })
    queues.push(instance)
    return instance
  }),
  FlowProducer: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue({ job: { id: 'flow' } }),
      addBulk: jest.fn().mockResolvedValue([{ job: { id: 'flow' } }]),
      close: jest.fn().mockResolvedValue(undefined),
    })
    producers.push(instance)
    return instance
  }),
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    processors.push(processor)
    return Object.assign(new EventEmitter(), {
      close: jest.fn().mockResolvedValue(undefined),
    })
  }),
}))

const options = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: true },
  metrics: { enabled: false, cacheTtlMs: 5000 },
  shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
} as unknown as ResolvedQueueOptions

/** A connection stub whose client can be duplicated for a worker. */
function connection(): ConnectionResolver {
  return {
    getClient: jest.fn().mockReturnValue({
      options: { commandTimeout: 5000 },
      duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
    }),
    awaitReady: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionResolver
}

const flow = { name: 'parent', queueName: 'q', data: {} } as FlowJob

/** The keys `Object.prototype` holds before any test plants one. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

/** Plant a key for the length of `body`, and take it off again. */
function planted<T>(body: () => T): T {
  Object.defineProperty(Object.prototype, 'zzPlanted', {
    value: 'planted-value',
    configurable: true,
    writable: true,
    enumerable: true,
  })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, 'zzPlanted')
  }
}

/** What a call was refused with: the code, or `undefined` when it was not refused. */
async function refusedWith(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof QueueException)) throw error
    return (error.getResponse() as { error: { code: string } }).error.code
  }
  return undefined
}

beforeEach(() => {
  queues.length = 0
  producers.length = 0
  processors.length = 0
})

afterEach(() => {
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD.has(n))
  for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
  if (extra.length > 0) throw new Error('a test left a key on Object.prototype')
})

describe('QueueService under a polluted Object.prototype', () => {
  const schedule = { every: 1000 }

  /** The calls of the service, each with the mock a clean run reaches. */
  const calls: [string, (s: QueueService) => Promise<unknown>, keyof (typeof queues)[number]][] = [
    ['enqueue', (s) => s.enqueue('q', 'job', { a: 1 }), 'add'],
    ['enqueueBulk', (s) => s.enqueueBulk('q', [{ name: 'job', data: 1 }]), 'addBulk'],
    ['upsertJobScheduler', (s) => s.upsertJobScheduler('q', 'id', schedule), 'upsertJobScheduler'],
  ]

  it.each(calls)('%s is refused before a queue is built', async (_name, call) => {
    const service = new QueueService(connection(), options)

    const code = await planted(() => refusedWith(() => call(service)))

    expect(code).toBe('queue.invalid_options')
    expect(queues).toHaveLength(0)
  })

  it.each(calls)('%s runs when Object.prototype is clean', async (_name, call, reached) => {
    const service = new QueueService(connection(), options)

    expect(await refusedWith(() => call(service))).toBeUndefined()

    expect(queues[0]?.[reached]).toHaveBeenCalledTimes(1)
  })
})

describe('QueueService when a key is planted while it waits for the client', () => {
  const schedule = { every: 1000 }
  // The late refusal reaches the caller of every call as the refusal itself, and stops the call before
  // BullMQ is touched.
  const calls: [
    string,
    (s: QueueService) => Promise<unknown>,
    'add' | 'addBulk' | 'upsertJobScheduler',
    string,
  ][] = [
    ['enqueue', (s) => s.enqueue('q', 'job', { a: 1 }), 'add', 'queue.invalid_options'],
    [
      'enqueueBulk',
      (s) => s.enqueueBulk('q', [{ name: 'job', data: 1 }]),
      'addBulk',
      'queue.invalid_options',
    ],
    [
      'upsertJobScheduler',
      (s) => s.upsertJobScheduler('q', 'id', schedule),
      'upsertJobScheduler',
      'queue.invalid_options',
    ],
  ]

  it.each(calls)(
    '%s is refused when the wait ends, and never reaches BullMQ',
    async (_n, call, reached, expected) => {
      let ready: () => void = () => undefined
      const pending = connection()
      ;(pending.awaitReady as jest.Mock).mockReturnValue(
        new Promise<void>((resolve) => {
          ready = resolve
        }),
      )
      const service = new QueueService(pending, options)

      const outcome = refusedWith(() => call(service))
      // The guard at the entry has passed; the key arrives while the call waits for the client.
      let code: string | undefined
      try {
        ;(Object.prototype as Record<string, unknown>).zzPlanted = 'planted-value'
        ready()
        code = await outcome
      } finally {
        Reflect.deleteProperty(Object.prototype, 'zzPlanted')
      }

      expect(code).toBe(expected)
      expect(queues.every((queue) => queue[reached].mock.calls.length === 0)).toBe(true)
    },
  )
})

describe('FlowService under a polluted Object.prototype', () => {
  const calls: [string, (s: FlowService) => Promise<unknown>][] = [
    ['add', (s) => s.add(flow)],
    ['addBulk', (s) => s.addBulk([flow])],
  ]

  it.each(calls)('%s is refused before the producer is touched', async (_name, call) => {
    const service = new FlowService(connection(), true, 'bull')

    const code = await planted(() => refusedWith(() => call(service)))

    expect(code).toBe('queue.invalid_options')
    expect(producers[0]?.add).not.toHaveBeenCalled()
    expect(producers[0]?.addBulk).not.toHaveBeenCalled()
  })

  it.each(calls)('%s runs when Object.prototype is clean', async (_name, call) => {
    const service = new FlowService(connection(), true, 'bull')

    expect(await refusedWith(() => call(service))).toBeUndefined()

    // `addBulk` hands the producer its trees one by one or together, so either call counts.
    const reached =
      (producers[0]?.add.mock.calls.length ?? 0) + (producers[0]?.addBulk.mock.calls.length ?? 0)
    expect(reached).toBeGreaterThan(0)
  })
})

describe('FlowService when a key is planted after the call started', () => {
  const second = { name: 'second', queueName: 'q', data: {} } as FlowJob

  /** The error code and the details a call rejected with. */
  async function rejection(
    run: () => Promise<unknown>,
  ): Promise<{ code: string; details: Record<string, unknown> }> {
    let error: unknown
    try {
      error = await run().catch((caught: unknown) => caught)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlanted')
    }
    if (!(error instanceof QueueException)) throw new Error('the call was not refused')
    return (error.getResponse() as { error: { code: string; details: Record<string, unknown> } })
      .error
  }

  it('refuses an add whose observer plants a key, and never calls the producer', async () => {
    const observers = new QueueObserverRegistry()
    observers.register({
      async traceEnqueue(_info, _carrier, run) {
        ;(Object.prototype as Record<string, unknown>).zzPlanted = 'planted-value'
        return await run()
      },
    })
    const service = new FlowService(connection(), true, 'bull', undefined, 10000, observers)

    const error = await rejection(() => service.add(flow))

    expect(error.code).toBe('queue.invalid_options')
    expect(producers[0]?.add).not.toHaveBeenCalled()
  })

  it('refuses the second tree of a bulk before its add when the first add planted a key', async () => {
    const service = new FlowService(connection(), true, 'bull')
    const producer = producers[0]
    producer?.add.mockImplementationOnce(() => {
      ;(Object.prototype as Record<string, unknown>).zzPlanted = 'planted-value'
      return Promise.resolve({ job: { id: 'first' } })
    })

    const error = await rejection(() => service.addBulk([flow, second]))

    expect(producer?.add).toHaveBeenCalledTimes(1)
    // Measured: the refusal is reported as the bulk's own failure, not as INVALID_OPTIONS.
    expect(error.code).toBe('queue.bulk_enqueue_failed')
    expect(error.details).toMatchObject({ landed: [0], failed: [1], notStarted: [] })
  })
})

describe('the processor the worker registry gives BullMQ', () => {
  const jobFields = { id: '1', name: 'send', data: {} }
  const job = jobFields as unknown as Job

  /** Register a worker over `handler` and return its processor. */
  function registered(handler: () => Promise<unknown>): Processor {
    new WorkerRegistry(connection(), options).register({ queueName: 'q', handler })
    const processor = processors.at(-1)
    if (processor === undefined) throw new Error('no processor registered')
    return processor
  }

  /** A job whose queue backend moves it to the delayed set through `moveToDelayed`. */
  function jobWith(moveToDelayed: jest.Mock): Job {
    return Object.assign({}, jobFields, { backend: { moveToDelayed } }) as unknown as Job
  }

  it('moves the job back to the delayed set through the backend with an options object that has no prototype', async () => {
    const handler = jest.fn().mockResolvedValue('done')
    const moveToDelayed = jest.fn().mockResolvedValue(undefined)
    const processor = registered(handler)

    const outcome = await planted(() =>
      processor(jobWith(moveToDelayed), 'token').catch((e: unknown) => e),
    )

    expect(outcome).toBeInstanceOf(DelayedError)
    expect(moveToDelayed).toHaveBeenCalledTimes(1)
    const [id, , delay, token, options] = moveToDelayed.mock.calls[0] as [
      string,
      number,
      number,
      string,
      Record<string, unknown>,
    ]
    expect(id).toBe('1')
    expect(delay).toBe(5000)
    expect(token).toBe('token')
    expect(Object.getPrototypeOf(options)).toBeNull()
    expect({ ...options }).toEqual({
      skipAttempt: true,
      fetchNext: false,
      fieldsToUpdate: undefined,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('has shadowed the options of a refused job, repeat and removeOnFail included, when it is moved', async () => {
    const moveToDelayed = jest.fn().mockImplementation(function (this: unknown) {
      const opts = (refused as unknown as { opts: object }).opts
      for (const key of [...JOB_OPTION_KEYS, 'repeat']) {
        expect(Object.getOwnPropertyDescriptor(opts, key)).toMatchObject({ value: undefined })
      }
      expect(Object.hasOwn(opts, 'removeOnFail')).toBe(true)
      return Promise.resolve()
    })
    const refused = Object.assign({}, jobFields, {
      opts: {},
      backend: { moveToDelayed },
    }) as unknown as Job
    const processor = registered(jest.fn())

    await planted(() => processor(refused, 'token').catch((e: unknown) => e))

    expect(moveToDelayed).toHaveBeenCalledTimes(1)
    expect.assertions(JOB_OPTION_KEYS.length + 3)
  })

  it('moves a refused job and shadows its options while get is planted on Object.prototype', async () => {
    const moveToDelayed = jest.fn().mockResolvedValue(undefined)
    const refused = Object.assign({}, jobFields, {
      opts: {},
      backend: { moveToDelayed },
    }) as unknown as Job
    const processor = registered(jest.fn())
    Object.defineProperty(Object.prototype, 'get', { value: 'x', configurable: true })
    let outcome: unknown
    try {
      outcome = await processor(refused, 'token').catch((e: unknown) => e)
    } finally {
      delete (Object.prototype as Record<string, unknown>).get
    }

    expect(outcome).toBeInstanceOf(DelayedError)
    expect(moveToDelayed).toHaveBeenCalledTimes(1)
    expect(Object.hasOwn((refused as unknown as { opts: object }).opts, 'removeOnFail')).toBe(true)
  })

  it('moves the job with a prototype-less options object and a finite time when Object.create and Date.now are replaced', async () => {
    const moveToDelayed = jest.fn().mockResolvedValue(undefined)
    const processor = registered(jest.fn())
    const { create } = Object
    const { now } = Date
    let outcome: unknown
    try {
      // Replacing Object.create makes the guard refuse, which is the scenario.
      Object.create = (() => ({})) as typeof Object.create
      Date.now = () => NaN
      outcome = await processor(jobWith(moveToDelayed), 'token').catch((e: unknown) => e)
    } finally {
      Object.create = create
      Date.now = now
    }

    expect(outcome).toBeInstanceOf(DelayedError)
    const [, timestamp, delay, , moved] = moveToDelayed.mock.calls[0] as [
      string,
      number,
      number,
      string,
      object,
    ]
    expect(Object.getPrototypeOf(moved)).toBeNull()
    expect(Number.isFinite(timestamp)).toBe(true)
    expect(delay).toBe(5000)
  })

  it('ends the attempt with the error of the move when the job cannot be moved', async () => {
    const boom = new Error('redis down')
    const processor = registered(jest.fn())

    const outcome = await planted(() =>
      processor(jobWith(jest.fn().mockRejectedValue(boom))).catch((e: unknown) => e),
    )

    expect(outcome).toBe(boom)
  })

  it('runs the handler and returns its result when Object.prototype is clean', async () => {
    const handler = jest.fn().mockResolvedValue('done')
    const processor = registered(handler)

    await expect(processor(job)).resolves.toBe('done')

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
