/**
 * @fileoverview Unit tests for how `QueueService` hands an enqueue to the observers: the add runs
 * inside their enqueue span, the trace headers they write are stored with the job in
 * `opts.telemetry.metadata`, metadata that is already there is kept, BullMQ's own telemetry keeps
 * its own, and with no registry the options are sent as checked. BullMQ's `Queue` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { JobsOptions, Telemetry } from 'bullmq'
import { QueueService } from './queue.service'
import { QueueObserverRegistry } from '../observability/queue-observer'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

/** The mocked Queue instances, in creation order. */
const queues: { add: jest.Mock; addBulk: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue({ id: 'created' }),
      addBulk: jest.fn().mockResolvedValue([]),
      close: jest.fn().mockResolvedValue(undefined),
    })
    queues.push(instance)
    return instance
  }),
}))

const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

/** A service over a stub connection, with the given observers and module telemetry. */
function makeService(
  observers?: QueueObserverRegistry,
  telemetry?: Telemetry,
): { service: QueueService; queue: (typeof queues)[number] } {
  const connection = {
    getClient: jest.fn().mockReturnValue({ id: 'client' }),
    awaitReady: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionResolver
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
    ...(telemetry === undefined ? {} : { telemetry }),
  }
  const service =
    observers === undefined
      ? new QueueService(connection, options)
      : new QueueService(connection, options, observers)
  service.getOrCreateQueue('email')
  const queue = queues.at(-1)
  if (queue === undefined) throw new Error('no queue was created')
  return { service, queue }
}

/** A registry whose one observer writes `traceparent` and records what it is told. */
function writing(): { observers: QueueObserverRegistry; infos: unknown[] } {
  const observers = new QueueObserverRegistry()
  const infos: unknown[] = []
  observers.register({
    traceEnqueue: (info, carrier, run) => {
      infos.push(info)
      carrier.traceparent = traceparent
      return run()
    },
  })
  return { observers, infos }
}

beforeEach(() => {
  queues.length = 0
})

describe('QueueService — enqueue under observers', () => {
  it('stores the headers the observer wrote with the job, apart from its data, and names the queue and job', async () => {
    const { observers, infos } = writing()
    const { service, queue } = makeService(observers)

    await service.enqueue('email', 'send', { to: 'a' }, { attempts: 2 })

    expect(infos).toStrictEqual([{ queue: 'email', job: 'send' }])
    expect(queue.add).toHaveBeenCalledWith(
      'send',
      { to: 'a' },
      { attempts: 2, telemetry: { metadata: JSON.stringify({ traceparent }) } },
    )
  })

  it('stores them on a job that gave no options', async () => {
    const { service, queue } = makeService(writing().observers)

    await service.enqueue('email', 'send', {})

    expect(queue.add).toHaveBeenCalledWith(
      'send',
      {},
      {
        telemetry: { metadata: JSON.stringify({ traceparent }) },
      },
    )
  })

  it('keeps metadata the caller set', async () => {
    const { service, queue } = makeService(writing().observers)
    const options: JobsOptions = { telemetry: { metadata: 'mine' } }

    await service.enqueue('email', 'send', {}, options)

    expect(queue.add).toHaveBeenCalledWith('send', {}, { telemetry: { metadata: 'mine' } })
  })

  it('leaves the metadata to BullMQ when its own telemetry is configured, and still opens the span', async () => {
    const { observers, infos } = writing()
    const { service, queue } = makeService(observers, {} as unknown as Telemetry)

    await service.enqueue('email', 'send', {}, { attempts: 2 })

    expect(infos).toHaveLength(1)
    expect(queue.add).toHaveBeenCalledWith('send', {}, { attempts: 2 })
  })

  it('sends the options as checked when no observer wrote a header', async () => {
    const { service, queue } = makeService(new QueueObserverRegistry())

    await service.enqueue('email', 'send', {}, { attempts: 2 })

    expect(queue.add).toHaveBeenCalledWith('send', {}, { attempts: 2 })
  })

  it('sends the options as checked when there is no registry', async () => {
    const { service, queue } = makeService()

    await service.enqueue('email', 'send', {}, { attempts: 2 })

    expect(queue.add).toHaveBeenCalledWith('send', {}, { attempts: 2 })
  })

  it('passes a rejection of the add through the span', async () => {
    const { service, queue } = makeService(writing().observers)
    queue.add.mockRejectedValueOnce(new Error('refused'))

    await expect(service.enqueue('email', 'send', {})).rejects.toThrow()
  })
})

describe('QueueService — bulk enqueue under observers', () => {
  it('opens one span for the batch without a job name, and stores the headers on each job', async () => {
    const { observers, infos } = writing()
    const { service, queue } = makeService(observers)

    await service.enqueueBulk('email', [
      { name: 'a', data: 1, options: { attempts: 2 } },
      { name: 'b', data: 2 },
    ])

    expect(infos).toStrictEqual([{ queue: 'email' }])
    const metadata = JSON.stringify({ traceparent })
    expect(queue.addBulk).toHaveBeenCalledWith([
      { name: 'a', data: 1, opts: { attempts: 2, telemetry: { metadata } } },
      { name: 'b', data: 2, opts: { telemetry: { metadata } } },
    ])
  })

  it('sends the jobs as given when no observer wrote a header', async () => {
    const { service, queue } = makeService(new QueueObserverRegistry())

    await service.enqueueBulk('email', [{ name: 'b', data: 2 }])

    expect(queue.addBulk).toHaveBeenCalledWith([{ name: 'b', data: 2 }])
  })
})
