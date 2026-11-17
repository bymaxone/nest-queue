/**
 * @fileoverview Runs the README dead-letter recipe as written: the class is taken from the README
 * text, compiled, and registered as a provider, so Nest builds it with its real constructor
 * injection, the library discovers its `@Processor`, and its `@OnWorkerEvent('failed')` listener is
 * bound to a real BullMQ `Worker` on a real Redis. The snippet gate only type-checks the README, and
 * a type-correct recipe can still do nothing: BullMQ refuses a job id with a colon, and a comparison
 * of `attemptsMade` with `attempts` never matches a job that fails with `UnrecoverableError`.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInThisContext } from 'node:vm'
import { NestFactory } from '@nestjs/core'
import { Inject, Injectable, Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import { Redis } from 'ioredis'
import * as ts from 'typescript'
import {
  BymaxQueueModule,
  OnWorkerEvent,
  Process,
  Processor,
  QueueService,
} from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** The dead-letter snippet of the README, as the README writes it. */
function readmeDlqSnippet(): string {
  const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8')
  const start = readme.indexOf('**DLQ pattern.**')
  return /```typescript\n([\s\S]*?)```/.exec(readme.slice(start))?.[1] ?? ''
}

/** The class of the recipe: built by Nest, with the one method the test replaces. */
interface RecipeClass {
  new (queue: QueueService): object
  prototype: {
    fulfil: (orderId: string) => Promise<void>
    onFailed: (job: unknown, err: Error) => Promise<void>
  }
}

/** Compile the README class, without its imports, and hand it the real decorators it names. */
function loadRecipe(): RecipeClass {
  const source = readmeDlqSnippet()
    .replace(/^import .*\n/gm, '')
    .replace('export class', 'class')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText
  const build = runInThisContext(
    `(function (Injectable, Inject, Processor, Process, OnWorkerEvent, QueueService) {\n${js}\nreturn OrdersProcessor })`,
  ) as (...decorators: unknown[]) => RecipeClass
  return build(Injectable, Inject, Processor, Process, OnWorkerEvent, QueueService)
}

/** Poll `predicate` until it is truthy or the timeout elapses. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

/** The error a job fails with, by order id; BullMQ treats an error that only carries the name as unrecoverable. */
function failureFor(orderId: string): Error {
  if (orderId === 'named') return Object.assign(new Error('final'), { name: 'UnrecoverableError' })
  if (orderId === 'fatal' || orderId === 'gone-fatal') return new UnrecoverableError('final')
  return new Error('always')
}

/** Replace the recipe's work with one that counts the runs of each order and fails them by id. */
function failByOrder(recipe: RecipeClass, runs: Map<string, number>): void {
  recipe.prototype.fulfil = (orderId) => {
    runs.set(orderId, (runs.get(orderId) ?? 0) + 1)
    if (orderId === 'flaky' && runs.get(orderId) === 1) return Promise.reject(new Error('once'))
    return orderId === 'flaky' ? Promise.resolve() : Promise.reject(failureFor(orderId))
  }
}

/** Enqueue the scenario's jobs; the last two are removed on failure, so they have no state left to read. */
async function enqueueScenario(queues: QueueService, queueName: string): Promise<void> {
  const options = { attempts: 3, backoff: { type: 'fixed', delay: 50 } } as const
  for (const orderId of ['exhausted', 'fatal', 'named', 'flaky']) {
    await queues.enqueue(queueName, 'j', { orderId }, { jobId: orderId, ...options })
  }
  const removed = { ...options, removeOnFail: true } as const
  for (const orderId of ['gone', 'gone-fatal']) {
    await queues.enqueue(queueName, 'j', { orderId }, { jobId: orderId, ...removed })
  }
}

let redis: RedisContainer
let maintenance: Redis
let app: INestApplicationContext | undefined

/** Boot an application whose only provider is the README class. */
async function bootWith(recipe: RecipeClass): Promise<INestApplicationContext> {
  @Module({
    imports: [BymaxQueueModule.forRoot({ connection: { url: redis.url } })],
    providers: [recipe],
  })
  class RootModule {}
  return NestFactory.createApplicationContext(RootModule, { logger: false })
}

beforeAll(async () => {
  redis = await startRedisContainer()
  maintenance = new Redis(redis.url, { maxRetriesPerRequest: null })
}, 60_000)

afterEach(async () => {
  await app?.close()
  app = undefined
  await maintenance.flushall()
})

afterAll(async () => {
  await maintenance.quit()
  await redis.stop()
})

describe('E2E — the README dead-letter recipe', () => {
  it('still says what this test runs', () => {
    // The class below is the README's; if the README changes, this test must change with it.
    const snippet = readmeDlqSnippet()
    expect(snippet).toContain('@Inject(QueueService)')
    expect(snippet).toContain("@Processor('orders')")
    expect(snippet).toContain("@OnWorkerEvent('failed')")
    expect(snippet).toContain('async onFailed(job: Job | undefined, err: Error)')
    expect(snippet).toContain('-dlq')
    expect(snippet).toContain('failedReason: job.failedReason')
  })

  it('dead-letters a job that exhausted its attempts and one that failed for good at once, removed or not', async () => {
    const recipe = loadRecipe()
    const runs = new Map<string, number>()
    failByOrder(recipe, runs)
    // The listener Nest binds is the class's own, so a spy on it sees every `failed` event.
    const listener = jest.spyOn(recipe.prototype, 'onFailed')
    app = await bootWith(recipe)
    const queues = app.get(QueueService)

    await enqueueScenario(queues, 'orders')

    await waitFor(async () => (await queues.getMetrics('orders-dlq')).counts.waiting >= 5, 15_000)
    // Let the retries of `flaky` and the late failures settle before the exact list is read.
    await new Promise<void>((resolve) => setTimeout(resolve, 500))

    const dead = await queues.getJobs('orders-dlq', 'waiting')
    expect(dead.map((j) => j.id).sort()).toEqual([
      'dlq-exhausted',
      'dlq-fatal',
      'dlq-gone',
      'dlq-gone-fatal',
      'dlq-named',
    ])
    // Each dead-letter job carries the original data and why the job failed.
    const dataOf = (id: string): unknown => dead.find((j) => j.id === id)?.data
    expect(dataOf('dlq-exhausted')).toEqual({
      original: { orderId: 'exhausted' },
      failedReason: 'always',
    })
    expect(dataOf('dlq-fatal')).toEqual({ original: { orderId: 'fatal' }, failedReason: 'final' })
    expect(dataOf('dlq-named')).toEqual({ original: { orderId: 'named' }, failedReason: 'final' })
    // Every failed attempt reached the listener (3 + 1 + 1 + 1 + 3 + 1 at least), so the spy works.
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(9)
    // The retried attempts of `exhausted` and the single failure of `flaky` did not dead-letter.
    expect(runs.get('exhausted')).toBe(3)
    expect(runs.get('fatal')).toBe(1)
    expect(runs.get('named')).toBe(1)
    expect(runs.get('flaky')).toBe(2)
  }, 30_000)

  it('never runs for a job whose keys were removed while it ran', async () => {
    const recipe = loadRecipe()
    recipe.prototype.fulfil = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 600))
      throw new Error('late')
    }
    const listener = jest.spyOn(recipe.prototype, 'onFailed')
    app = await bootWith(recipe)
    const queues = app.get(QueueService)
    await queues.enqueue('orders', 'j', { orderId: 'running' }, { jobId: 'running', attempts: 1 })
    await waitFor(async () => (await queues.getMetrics('orders')).counts.active === 1, 10_000)

    // An active job is locked, so `job.remove()` refuses it; obliterating the queue is what removes it.
    await queues.getCachedQueues().get('orders')?.obliterate({ force: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500))

    expect(listener).not.toHaveBeenCalled()
    expect((await queues.getMetrics('orders-dlq')).counts.waiting).toBe(0)
  }, 30_000)
})
