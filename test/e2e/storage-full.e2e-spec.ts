/**
 * @fileoverview Runs the calls that write against a real Redis that is out of memory
 * (`maxmemory` below the memory in use, with `noeviction`), and a flow bulk in which one tree fails
 * for another reason. The unit suite stubs the Redis reply, so only this file can show the reply
 * Redis really gives, that nothing of a refused call is stored, and what a bulk reports.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import type { FlowJob } from 'bullmq'
import { Redis } from 'ioredis'
import { BymaxQueueModule, FlowService, QueueService } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

@Module({})
class RootModule {}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext

/** A payload large enough that a few jobs push a small Redis past its limit. */
const BIG = 'x'.repeat(100_000)

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

afterAll(async () => {
  await app.close()
  await maintenance.quit()
  await redis.stop()
})

/** Run `work`, return the exception it rejected with as its status, code and details. */
async function failure(
  work: () => Promise<unknown>,
): Promise<{ status: number; code: string; details: Record<string, unknown>; text: string }> {
  try {
    await work()
  } catch (err) {
    const exception = err as { getStatus: () => number; getResponse: () => unknown }
    const { error } = exception.getResponse() as {
      error: { code: string; details: Record<string, unknown> }
    }
    return {
      status: exception.getStatus(),
      code: error.code,
      details: error.details,
      text: JSON.stringify(exception.getResponse()),
    }
  }
  throw new Error('the call did not reject')
}

/** A two-job flow whose ids are derived from `id`. */
function tree(queueName: string, id: string): FlowJob {
  return {
    name: 'root',
    queueName,
    data: { big: BIG },
    opts: { jobId: id },
    children: [{ name: 'child', queueName, data: { big: BIG }, opts: { jobId: `${id}-c` } }],
  }
}

describe('E2E — Redis out of memory', () => {
  it('reports STORAGE_FULL from every write, stores nothing of a refused call, and recovers', async () => {
    const queues = app.get(QueueService)
    const flows = app.get(FlowService)
    for (let i = 0; i < 5; i += 1) {
      await queues.enqueue('full', 'j', { big: BIG }, { jobId: `seed-${String(i)}` })
    }
    // Below the memory in use: Redis refuses every further write, deterministically.
    await maintenance.config('SET', 'maxmemory', '1mb')
    await maintenance.config('SET', 'maxmemory-policy', 'noeviction')
    const waiting = (await queues.getMetrics('full')).counts.waiting

    const single = await failure(() => queues.enqueue('full', 'j', { big: BIG }))
    const bulk = await failure(() =>
      queues.enqueueBulk('full', [
        { name: 'j', data: { big: BIG } },
        { name: 'j', data: { big: BIG } },
      ]),
    )
    const flow = await failure(() => flows.add(tree('full-flow', 'one')))
    const flowBulk = await failure(() =>
      flows.addBulk([tree('full-flow', 'a'), tree('full-flow', 'b'), tree('full-flow', 'c')]),
    )

    expect([single.status, bulk.status, flow.status, flowBulk.status]).toEqual([503, 503, 503, 503])
    expect([single.code, bulk.code, flow.code, flowBulk.code]).toEqual(
      Array.from({ length: 4 }, () => 'queue.storage_full'),
    )
    expect(single.details).toEqual({ operation: 'enqueue', reason: 'out_of_memory' })
    expect(bulk.details).toEqual({ operation: 'enqueueBulk', reason: 'out_of_memory' })
    expect(flow.details).toEqual({ operation: 'addFlow', reason: 'out_of_memory' })
    // The bulk of flows says what became of every tree; none landed, and nothing was left behind.
    expect(flowBulk.details).toMatchObject({
      operation: 'addFlowBulk',
      reason: 'out_of_memory',
      landed: [],
      unknown: [],
    })
    const reported = [
      ...(flowBulk.details.failed as number[]),
      ...(flowBulk.details.notStarted as number[]),
    ]
    expect(reported.sort()).toEqual([0, 1, 2])
    for (const text of [single.text, bulk.text, flow.text, flowBulk.text]) {
      expect(text).not.toMatch(/maxmemory|OOM|user_script/)
    }
    expect(await maintenance.keys('bull:full-flow:*')).toEqual([])
    // Reads still answer, and nothing of the refused writes was stored.
    expect((await queues.getMetrics('full')).counts.waiting).toBe(waiting)

    await maintenance.config('SET', 'maxmemory', '0')
    await expect(queues.enqueue('full', 'j', {}, { jobId: 'after' })).resolves.toMatchObject({
      id: 'after',
    })
  })

  it('reports which trees of a flow bulk landed when one fails for another reason', async () => {
    const flows = app.get(FlowService)
    // A string under the root's key makes that tree fail with WRONGTYPE, whatever the memory.
    await maintenance.set('bull:partial:bad', 'not a job hash')

    const err = await failure(() =>
      flows.addBulk([tree('partial', 'ok-1'), tree('partial', 'bad'), tree('partial', 'ok-3')]),
    )

    expect(err.status).toBe(500)
    expect(err.code).toBe('queue.bulk_enqueue_failed')
    expect(err.details).toMatchObject({
      operation: 'addFlowBulk',
      landed: [0, 2],
      failed: [1],
      notStarted: [],
      unknown: [],
    })
    expect(err.text).not.toMatch(/WRONGTYPE/)
    expect(await maintenance.exists('bull:partial:ok-1', 'bull:partial:ok-3')).toBe(2)
    // The failed tree's child was written before its root failed, and nothing removes it.
    expect(await maintenance.exists('bull:partial:bad-c')).toBe(1)
  })
})
