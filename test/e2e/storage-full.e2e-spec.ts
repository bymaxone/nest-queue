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

/** What each kind of write rejected with while Redis was out of memory. */
interface Refusals {
  single: Failure
  bulk: Failure
  flow: Failure
  flowBulk: Failure
}

type Failure = Awaited<ReturnType<typeof failure>>

/** Seed a queue, then put `maxmemory` below the memory in use so Redis refuses every further write. */
async function fillRedis(queues: QueueService): Promise<number> {
  for (let i = 0; i < 5; i += 1) {
    await queues.enqueue('full', 'j', { big: BIG }, { jobId: `seed-${String(i)}` })
  }
  await maintenance.config('SET', 'maxmemory', '1mb')
  await maintenance.config('SET', 'maxmemory-policy', 'noeviction')
  return (await queues.getMetrics('full')).counts.waiting
}

/** Make one write of every kind and collect what each rejected with. */
async function writeWhileFull(queues: QueueService, flows: FlowService): Promise<Refusals> {
  return {
    single: await failure(() => queues.enqueue('full', 'j', { big: BIG })),
    bulk: await failure(() =>
      queues.enqueueBulk('full', [
        { name: 'j', data: { big: BIG } },
        { name: 'j', data: { big: BIG } },
      ]),
    ),
    flow: await failure(() => flows.add(tree('full-flow', 'one'))),
    flowBulk: await failure(() =>
      flows.addBulk([tree('full-flow', 'a'), tree('full-flow', 'b'), tree('full-flow', 'c')]),
    ),
  }
}

/** Every write is a 503 `STORAGE_FULL` with only its operation and reason, and none leaks Redis's text. */
function expectStorageFull(refused: Refusals): void {
  const all = [refused.single, refused.bulk, refused.flow, refused.flowBulk]
  expect(all.map((r) => r.status)).toEqual([503, 503, 503, 503])
  expect(all.map((r) => r.code)).toEqual(Array.from({ length: 4 }, () => 'queue.storage_full'))
  expect(refused.single.details).toEqual({ operation: 'enqueue', reason: 'out_of_memory' })
  expect(refused.bulk.details).toEqual({ operation: 'enqueueBulk', reason: 'out_of_memory' })
  expect(refused.flow.details).toEqual({ operation: 'addFlow', reason: 'out_of_memory' })
  for (const r of all) expect(r.text).not.toMatch(/maxmemory|OOM|user_script/)
}

describe('E2E — Redis out of memory', () => {
  it('reports STORAGE_FULL from every write, stores nothing of a refused call, and recovers', async () => {
    const queues = app.get(QueueService)
    const waiting = await fillRedis(queues)

    const refused = await writeWhileFull(queues, app.get(FlowService))

    expectStorageFull(refused)
    // The bulk of flows says what became of every tree; none landed, and nothing was left behind.
    expect(refused.flowBulk.details).toMatchObject({ landed: [], unknown: [] })
    const reported = [
      ...(refused.flowBulk.details.failed as number[]),
      ...(refused.flowBulk.details.notStarted as number[]),
    ]
    expect(reported.sort()).toEqual([0, 1, 2])
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
