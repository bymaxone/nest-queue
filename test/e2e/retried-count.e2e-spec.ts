/**
 * @fileoverview Counts the outcome of failed attempts against a real Redis, for the routes where the
 * job's options promise a retry that BullMQ does not schedule: `retried` is counted only when BullMQ
 * moved the job to be run again. Each row uses its own queue, so its counts are its own.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { DelayedError, UnrecoverableError } from 'bullmq'
import type { Job, JobsOptions, Worker } from 'bullmq'
import {
  BymaxQueueModule,
  FlowService,
  QueueObserverRegistry,
  QueueService,
  WorkerRegistry,
} from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

let redis: RedisContainer
let app: INestApplicationContext
let queues: QueueService
const outcomes: { queue: string; outcome: string }[] = []

/** What the observers were told about the attempts of one queue, in order. */
function countedFor(queue: string): string[] {
  return outcomes.filter((event) => event.queue === queue).map((event) => event.outcome)
}

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

/** A worker on `queue` whose handler always throws `thrown()`, and the errors it emits. */
function failingWorker(
  queue: string,
  thrown: (job: Job) => Promise<unknown> = () => Promise.resolve(new Error('boom')),
): { worker: Worker; errors: string[]; ran: () => number } {
  let runs = 0
  const errors: string[] = []
  const worker = app.get(WorkerRegistry).register({
    queueName: queue,
    handler: async (job) => {
      runs += 1
      throw await thrown(job)
    },
  })
  worker.on('error', (error: Error) => errors.push(error.message))
  return { worker, errors, ran: () => runs }
}

/** Give a refused or dropped move time to show: nothing more is expected to happen. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500))

/** Add one job through the BullMQ queue itself, which skips the checks of `enqueue`. */
async function addRaw(queue: string, options: JobsOptions): Promise<void> {
  await queues.enqueue(queue, 'warm-up', {}, { delay: 600_000 })
  await queues.getCachedQueues().get(queue)?.add('job', {}, options)
}

beforeAll(async () => {
  redis = await startRedisContainer()
  app = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [
        BymaxQueueModule.forRoot({ connection: { url: redis.url }, flows: { enabled: true } }),
      ],
    },
    { logger: false },
  )
  queues = app.get(QueueService)
  app.get(QueueObserverRegistry).register({
    jobFinished: ({ queue, outcome }) => {
      outcomes.push({ queue, outcome })
    },
  })
}, 60_000)

afterAll(async () => {
  await app.close()
  await redis.stop()
})

describe('E2E — a backoff type with no strategy behind it', () => {
  it.each([
    ['a custom type', { type: 'mine' }],
    ['no type', { delay: 10 }],
  ])('is refused by enqueue and enqueueBulk: %s', async (_label, backoff) => {
    const options = { attempts: 3, backoff } as JobsOptions
    const refusal = { response: { error: { code: 'queue.invalid_options' } } }

    await expect(queues.enqueue('refused', 'job', {}, options)).rejects.toMatchObject(refusal)
    await expect(
      queues.enqueueBulk('refused', [{ name: 'job', data: {}, options }]),
    ).rejects.toMatchObject(refusal)
  })

  it('is refused on a node of a flow', async () => {
    const flow = {
      name: 'root',
      queueName: 'refused-flow',
      opts: { attempts: 3, backoff: { type: 'mine' } },
    }

    await expect(app.get(FlowService).add(flow)).rejects.toMatchObject({
      response: { error: { code: 'queue.invalid_options' } },
    })
  })
})

describe('E2E — the retried count follows what BullMQ scheduled', () => {
  it('counts a retry BullMQ scheduled as retried, and the last attempt as failed', async () => {
    const { ran } = failingWorker('scheduled')

    await queues.enqueue(
      'scheduled',
      'job',
      {},
      { attempts: 2, backoff: { type: 'fixed', delay: 20 } },
    )
    await waitFor(() => countedFor('scheduled').length === 2)

    expect(ran()).toBe(2)
    expect(countedFor('scheduled')).toEqual(['retried', 'failed'])
  })

  it.each([
    ['an UnrecoverableError', () => new UnrecoverableError('final')],
    [
      'an error that only has its name',
      () => Object.assign(new Error('final'), { name: 'UnrecoverableError' }),
    ],
  ])('counts failed for %s, whatever attempts remain', async (label, thrown) => {
    const queue = `final-${label.replaceAll(' ', '-')}`
    const { ran } = failingWorker(queue, () => Promise.resolve(thrown()))

    await queues.enqueue(queue, 'job', {}, { attempts: 3 })
    await waitFor(() => countedFor(queue).length === 1)
    await settle()

    expect(ran()).toBe(1)
    expect(countedFor(queue)).toEqual(['failed'])
  })

  it('counts a thrown string as BullMQ treats it, retried while attempts remain', async () => {
    failingWorker('thrown-string', () => Promise.resolve('boom'))

    await queues.enqueue('thrown-string', 'job', {}, { attempts: 2, backoff: 0 })
    await waitFor(() => countedFor('thrown-string').length === 2)

    expect(countedFor('thrown-string')).toEqual(['retried', 'failed'])
  })

  it('counts an immediate retry, with no backoff, as retried', async () => {
    failingWorker('immediate')

    await queues.enqueue('immediate', 'job', {}, { attempts: 2, backoff: 0 })
    await waitFor(() => countedFor('immediate').length === 2)

    expect(countedFor('immediate')).toEqual(['retried', 'failed'])
  })

  it('counts failed for an unknown backoff type added through the BullMQ queue, left active', async () => {
    const { errors, ran } = failingWorker('unknown-type')

    await addRaw('unknown-type', { attempts: 3, backoff: { type: 'mine' } })
    await waitFor(() => errors.some((message) => message.includes('Unknown backoff strategy')))
    await settle()

    expect(ran()).toBe(1)
    expect(countedFor('unknown-type')).toEqual(['failed'])
  })

  it('counts failed for a delay of -1 added through the BullMQ queue', async () => {
    const { ran } = failingWorker('no-retry-delay')

    await addRaw('no-retry-delay', { attempts: 3, backoff: { type: 'fixed', delay: -1 } })
    await waitFor(() => countedFor('no-retry-delay').length === 1)
    await settle()

    expect(ran()).toBe(1)
    expect(countedFor('no-retry-delay')).toEqual(['failed'])
  })

  it('counts failed when a strategy set on the registered worker answers -1', async () => {
    const { worker, ran } = failingWorker('own-strategy')
    worker.opts.settings = { backoffStrategy: () => -1 }

    await addRaw('own-strategy', { attempts: 3, backoff: { type: 'mine' } })
    await waitFor(() => countedFor('own-strategy').length === 1)
    await settle()

    expect(ran()).toBe(1)
    expect(countedFor('own-strategy')).toEqual(['failed'])
  })

  it.each([
    ['an unknown type', { type: 'mine' }],
    ['a delay of -1', { type: 'fixed', delay: -1 }],
  ])('counts failed for %s added through the flow producer', async (label, backoff) => {
    const queue = `producer-${label.replaceAll(' ', '-')}`
    const { ran } = failingWorker(queue)

    await app
      .get(FlowService)
      .getProducer()
      .add({ name: 'root', queueName: queue, opts: { attempts: 3, backoff } })
    await waitFor(() => countedFor(queue).length === 1)
    await settle()

    expect(ran()).toBe(1)
    expect(countedFor(queue)).toEqual(['failed'])
  })

  it('counts nothing for a job the handler moved itself', async () => {
    let moved = false
    const { ran } = failingWorker('handed-back', async (job) => {
      if (moved) return new Error('boom')
      moved = true
      await job.moveToDelayed(Date.now() + 20, job.token)
      return new DelayedError()
    })

    await queues.enqueue('handed-back', 'job', {}, { attempts: 1 })
    await waitFor(() => countedFor('handed-back').length === 1)

    expect(ran()).toBe(2)
    expect(countedFor('handed-back')).toEqual(['failed'])
  })

  it('counts nothing for an error BullMQ cannot read', async () => {
    const { errors } = failingWorker('unreadable', () => Promise.resolve(null))

    await queues.enqueue('unreadable', 'job', {}, { attempts: 3 })
    await waitFor(() => errors.length > 0)
    await settle()

    expect(countedFor('unreadable')).toEqual([])
  })
})
