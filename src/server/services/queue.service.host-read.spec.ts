/**
 * @fileoverview Unit tests for what the queue service reads from the host's objects. A list of jobs
 * and a schedule are the host's: a subclass of `Array`, a Proxy or a getter can answer differently
 * the second time, or throw. The list is copied by index with its length read once, each job and
 * the schedule are read once, and what BullMQ receives is the copy that was checked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { BulkJob } from '../interfaces/queue-job-data.interface'
import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'

const queues: { addBulk: jest.Mock; upsertJobScheduler: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const queue = Object.assign(new EventEmitter(), {
      addBulk: jest.fn().mockResolvedValue([]),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })
    queues.push(queue)
    return queue
  }),
}))

/** A service over a stub connection. */
function makeService(): QueueService {
  const connection = {
    getClient: jest.fn().mockReturnValue({}),
    awaitReady: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionResolver
  const options = {
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
  } as ResolvedQueueOptions
  return new QueueService(connection, options)
}

beforeEach(() => {
  queues.length = 0
})

/** The code and cause of the refusal a call ended in. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; cause: unknown }> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof QueueException)) throw error
    const body = error.getResponse() as { error: { code: string } }
    return { code: body.error.code, cause: error.cause }
  }
  throw new Error('expected a refusal')
}

describe('QueueService.enqueueBulk — the list is the host’s', () => {
  const jobs: BulkJob[] = [
    { name: 'a', data: 1 },
    { name: 'b', data: 2 },
  ]

  it('sends every job when the list is an Array subclass whose map returns nothing', async () => {
    class Hostile extends Array<BulkJob> {
      override map(): never[] {
        return []
      }
    }
    const list = Hostile.from(jobs)
    const service = makeService()

    await service.enqueueBulk('q', list)

    expect(queues[0]?.addBulk).toHaveBeenCalledWith([
      { name: 'a', data: 1 },
      { name: 'b', data: 2 },
    ])
  })

  it('reads the length once and sends exactly the jobs that count covers', async () => {
    let lengthReads = 0
    const list = new Proxy(jobs, {
      get: (target, key, receiver): unknown => {
        if (key === 'length') {
          lengthReads += 1
          return lengthReads === 1 ? 2 : 1
        }
        return Reflect.get(target, key, receiver) as unknown
      },
    })

    await makeService().enqueueBulk('q', list)

    expect(lengthReads).toBe(1)
    expect(queues[0]?.addBulk).toHaveBeenCalledWith([
      { name: 'a', data: 1 },
      { name: 'b', data: 2 },
    ])
  })

  it('reads each job once, so a getter that changes cannot send other data than was checked', async () => {
    let reads = 0
    const job = {
      name: 'a',
      get data(): unknown {
        reads += 1
        return reads === 1 ? 'checked' : 'changed'
      },
    }

    await makeService().enqueueBulk('q', [job])

    expect(reads).toBe(1)
    expect(queues[0]?.addBulk).toHaveBeenCalledWith([{ name: 'a', data: 'checked' }])
  })

  it('refuses a job whose getter throws, with the host error as the cause', async () => {
    const boom = new Error('host getter')
    const job = {
      name: 'a',
      get data(): unknown {
        throw boom
      },
    }

    const refusal = await refusalOf(() => makeService().enqueueBulk('q', [job]))

    expect(refusal.code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
    expect(refusal.cause).toBe(boom)
  })

  it.each([
    ['null', [null]],
    ['undefined', [undefined]],
    ['a string', ['x']],
  ])('refuses a list holding %s instead of a job, with the library code', async (_label, list) => {
    const refusal = await refusalOf(() => makeService().enqueueBulk('q', list as never))

    expect(refusal.code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
  })

  it.each([NaN, -1, 1.5, Infinity])('refuses a list whose length is %s', async (length) => {
    const refusal = await refusalOf(() => makeService().enqueueBulk('q', { length } as never))

    expect(refusal.code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
  })
})

describe('QueueService.upsertJobScheduler — the schedule is the host’s', () => {
  it('sends the schedule that was checked, reading `every` once', async () => {
    let reads = 0
    const repeat = {
      get every(): number {
        reads += 1
        return reads === 1 ? 1000 : -5
      },
    } as unknown as JobSchedulerRepeatOptions
    const service = makeService()

    await service.upsertJobScheduler('q', 'tick', repeat)

    expect(reads).toBe(1)
    const sent = (queues[0]?.upsertJobScheduler.mock.calls as unknown[][])[0]?.[1] as {
      every: number
    }
    expect(sent.every).toBe(1000)
  })

  it('reads the template options once', async () => {
    let reads = 0
    const template = {
      name: 'n',
      get opts(): { attempts: number } {
        reads += 1
        return { attempts: reads === 1 ? 2 : 99 }
      },
    }

    await makeService().upsertJobScheduler('q', 'tick', { every: 1000 }, template)

    expect(reads).toBe(1)
    const sent = (queues[0]?.upsertJobScheduler.mock.calls as unknown[][])[0]?.[2] as {
      opts: { attempts: number }
    }
    expect(sent.opts.attempts).toBe(2)
  })

  it('refuses a schedule whose getter throws, with the host error as the cause', async () => {
    const boom = new Error('host getter')
    const repeat = {
      get every(): number {
        throw boom
      },
    } as unknown as JobSchedulerRepeatOptions

    const refusal = await refusalOf(() => makeService().upsertJobScheduler('q', 'tick', repeat))

    expect(refusal.code).toBe(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS)
    expect(refusal.cause).toBe(boom)
  })

  it('names the schedule in the refusal', async () => {
    const repeat = {
      get every(): number {
        throw new Error('host getter')
      },
    } as unknown as JobSchedulerRepeatOptions

    await expect(makeService().upsertJobScheduler('q', 'tick', repeat)).rejects.toMatchObject({
      response: { error: { details: { reason: 'the schedule could not be read' } } },
    })
  })

  it('reads the name, the data and the options of a template whose fields are getters of a class', async () => {
    class Template {
      private readonly given = { name: 'named', data: { a: 1 }, opts: { attempts: 2 } }
      get name(): string {
        return this.given.name
      }
      get data(): unknown {
        return this.given.data
      }
      get opts(): unknown {
        return this.given.opts
      }
    }

    await makeService().upsertJobScheduler('q', 'tick', { every: 1000 }, new Template() as never)

    const sent = (queues[0]?.upsertJobScheduler.mock.calls as unknown[][])[0]?.[2]
    expect(sent).toMatchObject({ name: 'named', data: { a: 1 }, opts: { attempts: 2 } })
  })

  it('sends a template with no opts key when the host gave none', async () => {
    await makeService().upsertJobScheduler('q', 'tick', { every: 1000 })

    const sent = (queues[0]?.upsertJobScheduler.mock.calls as unknown[][])[0]?.[2]
    expect(sent).toStrictEqual({ name: 'tick', data: {} })
  })
})

describe('the schedule options that are getters on a class prototype', () => {
  /** A schedule with no own field but `own`, whose `name` is a getter on its class prototype. */
  function scheduleWith(name: string, value: unknown, own: object): JobSchedulerRepeatOptions {
    class Schedule {
      constructor() {
        Object.assign(this, own)
      }
    }
    Object.defineProperty(Schedule.prototype, name, { get: () => value, configurable: true })
    return new Schedule() as unknown as JobSchedulerRepeatOptions
  }

  it.each([
    ['every', 1000, {}],
    ['pattern', '* * * * *', {}],
    ['endDate', new Date('2099-01-01T00:00:00Z'), { every: 1000 }],
    ['startDate', new Date('2098-01-01T00:00:00Z'), { every: 1000 }],
    ['limit', 5, { every: 1000 }],
    ['immediately', true, { every: 1000 }],
    ['tz', 'UTC', { pattern: '* * * * *' }],
    ['key', 'k', { every: 1000 }],
    ['count', 2, { every: 1000 }],
    ['offset', 10, { every: 1000 }],
    ['prevMillis', 5, { every: 1000 }],
    ['jobId', 'j', { every: 1000 }],
  ])('sends %s as the getter answers it', async (name, value, own) => {
    await makeService().upsertJobScheduler('q', 'tick', scheduleWith(name, value, own))

    const sent = (queues[0]?.upsertJobScheduler.mock.calls as unknown[][])[0]?.[1]
    expect(sent).toHaveProperty([name], value)
  })
})
