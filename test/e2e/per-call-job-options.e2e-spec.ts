/**
 * @fileoverview Runs the per-call job option checks against a real Redis. BullMQ's own flow producer
 * resolves with the node of a child it could not store (a child with `delay: Infinity` is dropped
 * while its parent is added, and the parent runs without it), so the library refuses a bad option on
 * any node before the first Redis call. Only a real Redis shows that nothing is stored.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import type { JobsOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { BymaxQueueModule, FlowService, QueueService } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
  app = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [
        BymaxQueueModule.forRoot({ connection: { url: redis.url }, flows: { enabled: true } }),
      ],
    },
    { logger: false },
  )
}, 60_000)

afterEach(async () => {
  await maintenance.flushall()
})

afterAll(async () => {
  await app.close()
  await maintenance.quit()
  await redis.stop()
})

/** The refusal a call ends in, as its code and reason, or a failure when it resolves. */
async function refusal(work: () => Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    await work()
  } catch (err) {
    const { error } = (
      err as { getResponse: () => { error: { code: string; details: unknown } } }
    ).getResponse()
    const reason = (error.details as { reason?: string }).reason ?? ''
    return { code: error.code, reason }
  }
  throw new Error('the call resolved')
}

/** How many keys of the queue `name` exist in Redis. */
async function keysOf(name: string): Promise<number> {
  return (await maintenance.keys(`bull:${name}*`)).length
}

const BAD_DELAYS: [string, number][] = [
  ['Infinity', Infinity],
  ['NaN', NaN],
  ['-1', -1],
]

describe('E2E — a bad option on any node is refused with nothing stored', () => {
  it.each(BAD_DELAYS)(
    'a child with delay %s rejects and the tree is not stored',
    async (_l, delay) => {
      const flows = app.get(FlowService)

      const err = await refusal(() =>
        flows.add({
          name: 'root',
          queueName: 'tree',
          data: {},
          opts: { jobId: 'root' },
          children: [
            { name: 'child', queueName: 'tree', data: {}, opts: { jobId: 'child', delay } },
          ],
        }),
      )

      expect(err.code).toBe('queue.invalid_options')
      expect(err.reason).toContain('flow.children[0].opts.delay')
      expect(await keysOf('tree')).toBe(0)
    },
  )

  it('addBulk refuses the whole batch when only the second tree has a bad grandchild', async () => {
    const flows = app.get(FlowService)
    const sound = { name: 'r', queueName: 'bulk', data: {}, opts: { jobId: 'good' } }

    const err = await refusal(() =>
      flows.addBulk([
        sound,
        {
          name: 'r',
          queueName: 'bulk',
          data: {},
          children: [
            {
              name: 'c',
              queueName: 'bulk',
              data: {},
              children: [{ name: 'g', queueName: 'bulk', data: {}, opts: { delay: NaN } }],
            },
          ],
        },
      ]),
    )

    expect(err.reason).toContain('flows[1].children[0].children[0].opts.delay')
    expect(await keysOf('bulk')).toBe(0)
  })

  it('enqueue and enqueueBulk refuse a bad option and store nothing', async () => {
    const queues = app.get(QueueService)

    const one = await refusal(() => queues.enqueue('single', 'j', {}, { delay: Infinity }))
    const many = await refusal(() =>
      queues.enqueueBulk('batch', [
        { name: 'j', data: {}, options: { jobId: 'ok' } },
        { name: 'j', data: {}, options: { attempts: NaN } },
      ]),
    )

    expect(one.reason).toContain('options.delay')
    expect(many.reason).toContain('jobs[1].options.attempts')
    expect(await keysOf('single')).toBe(0)
    expect(await keysOf('batch')).toBe(0)
  })

  it('refuses a reserved parent id on a job and on a flow child', async () => {
    const queues = app.get(QueueService)
    const flows = app.get(FlowService)

    const job = await refusal(() =>
      queues.enqueue('p', 'j', {}, { parent: { id: 'failed', queue: 'bull:p' } }),
    )
    const child = await refusal(() =>
      flows.add({
        name: 'r',
        queueName: 'p',
        data: {},
        children: [
          {
            name: 'c',
            queueName: 'p',
            data: {},
            opts: { parent: { id: 'wait', queue: 'bull:p' } } as JobsOptions,
          },
        ],
      }),
    )

    expect(job.code).toBe('queue.invalid_job_id')
    expect(child.code).toBe('queue.invalid_job_id')
    expect(await keysOf('p')).toBe(0)
  })

  it('still stores a tree whose options are sound', async () => {
    const flows = app.get(FlowService)

    await flows.add({
      name: 'root',
      queueName: 'fine',
      data: {},
      opts: { jobId: 'root' },
      children: [{ name: 'c', queueName: 'fine', data: {}, opts: { jobId: 'child', delay: 1000 } }],
    })

    expect(await maintenance.exists('bull:fine:root', 'bull:fine:child')).toBe(2)
  })
})
