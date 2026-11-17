/**
 * @fileoverview Runs the README dead-letter recipe as written, against a real BullMQ `Worker` and a
 * real Redis. The snippet gate only type-checks the README, and a type-correct recipe can still do
 * nothing: BullMQ refuses a job id with a colon, and a comparison of `attemptsMade` with `attempts`
 * never matches a job that fails with `UnrecoverableError`. The method below is taken from the
 * README text itself, so the recipe and what is tested cannot drift apart.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import * as ts from 'typescript'
import { BymaxQueueModule, QueueService, WorkerRegistry } from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** The dead-letter snippet of the README, as the README writes it. */
function readmeDlqSnippet(): string {
  const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8')
  const start = readme.indexOf('**DLQ pattern.**')
  return /```typescript\n([\s\S]*?)```/.exec(readme.slice(start))?.[1] ?? ''
}

/** The recipe's listener type: a method that takes the job and the error. */
type FailedListener = (job: Job | undefined, err: Error) => Promise<void>

/**
 * Compile the README method into a class the test can instantiate. The decorator is replaced by a
 * no-op, because the test attaches the method to the worker's `failed` event itself.
 */
function buildListener(queue: QueueService): FailedListener {
  const method = readmeDlqSnippet()
  const source = `class Recipe {\n constructor(queue) { this.queue = queue }\n${method}\n}\nRecipe`
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText
  const OnWorkerEvent = (): MethodDecorator => () => undefined
  const Recipe = runInNewContext(js, {
    OnWorkerEvent,
    __decorate: (...args: unknown[]) => args[3],
  }) as new (queue: QueueService) => { onFailed: FailedListener }
  const recipe = new Recipe(queue)
  return (job, err) => recipe.onFailed(job, err)
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

/** The error a job fails with, by job id; BullMQ treats an error that only carries the name as unrecoverable. */
function failureFor(id: string | undefined): Error {
  if (id === 'named') return Object.assign(new Error('final'), { name: 'UnrecoverableError' })
  if (id === 'fatal' || id === 'gone-fatal') return new UnrecoverableError('final')
  return new Error('always')
}

/** A handler that counts the runs of every job, succeeds on the second run of `flaky`, and fails the rest. */
function countingHandler(attempts: Map<string, number>): (job: Job) => Promise<string> {
  return (job) => {
    attempts.set(String(job.id), (attempts.get(String(job.id)) ?? 0) + 1)
    if (job.id === 'flaky' && job.attemptsMade === 0) return Promise.reject(new Error('once'))
    if (job.id === 'flaky') return Promise.resolve('ok')
    return Promise.reject(failureFor(job.id))
  }
}

/** Enqueue the scenario's jobs; the last two are removed on failure, so they have no state left to read. */
async function enqueueScenario(queues: QueueService, name: string): Promise<void> {
  const options = { attempts: 3, backoff: { type: 'fixed', delay: 50 } } as const
  const ids = ['exhausted', 'fatal', 'named', 'flaky']
  for (const jobId of ids) await queues.enqueue(name, 'j', {}, { jobId, ...options })
  const removed = { ...options, removeOnFail: true } as const
  for (const jobId of ['gone', 'gone-fatal']) {
    await queues.enqueue(name, 'j', {}, { jobId, ...removed })
  }
}

@Module({})
class RootModule {}

let redis: RedisContainer
let app: INestApplicationContext

beforeAll(async () => {
  redis = await startRedisContainer()
  app = await NestFactory.createApplicationContext(
    {
      module: RootModule,
      imports: [BymaxQueueModule.forRoot({ connection: { url: redis.url } })],
    },
    { logger: false },
  )
}, 60_000)

afterAll(async () => {
  await app.close()
  await redis.stop()
})

describe('E2E — the README dead-letter recipe', () => {
  it('still says what this test runs', () => {
    // The listener below is the README's; if the README changes, this test must change with it.
    const snippet = readmeDlqSnippet()
    expect(snippet).toContain("@OnWorkerEvent('failed')")
    expect(snippet).toContain('async onFailed(job: Job | undefined, err: Error)')
    expect(snippet).toContain('-dlq')
  })

  it('dead-letters a job that exhausted its attempts and one that failed for good at once, removed or not', async () => {
    const queues = app.get(QueueService)
    const listener = buildListener(queues)
    const name = 'dlq-recipe'
    const attempts = new Map<string, number>()
    const worker = app.get(WorkerRegistry).register({
      queueName: name,
      handler: countingHandler(attempts),
    })
    // The recipe's own listener, which is what a `@OnWorkerEvent('failed')` method becomes.
    const seen: Promise<void>[] = []
    worker.on('failed', (job, err) => {
      seen.push(listener(job, err).catch(() => undefined))
    })

    await enqueueScenario(queues, name)

    await waitFor(async () => (await queues.getMetrics(`${name}-dlq`)).counts.waiting >= 5, 15_000)
    await Promise.all(seen)

    const dead = await queues.getJobs(`${name}-dlq`, 'waiting')
    expect(dead.map((j) => j.id).sort()).toEqual([
      'dlq-exhausted',
      'dlq-fatal',
      'dlq-gone',
      'dlq-gone-fatal',
      'dlq-named',
    ])
    // The retried attempts of `exhausted` and the single failure of `flaky` did not dead-letter.
    expect(attempts.get('exhausted')).toBe(3)
    expect(attempts.get('fatal')).toBe(1)
    expect(attempts.get('named')).toBe(1)
    expect(attempts.get('flaky')).toBe(2)
  }, 30_000)

  it('never runs for a job whose keys were removed while it ran', async () => {
    const queues = app.get(QueueService)
    const listener = jest.fn(buildListener(queues))
    const name = 'dlq-recipe-removed'
    const worker = app.get(WorkerRegistry).register({
      queueName: name,
      handler: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 600))
        throw new Error('late')
      },
    })
    worker.on('failed', (job, err) => void listener(job, err))
    await queues.enqueue(name, 'j', {}, { jobId: 'running', attempts: 1 })
    await waitFor(async () => (await queues.getMetrics(name)).counts.active === 1, 10_000)
    // An active job is locked, so `job.remove()` refuses it; obliterating the queue is what removes it.
    await queues.getCachedQueues().get(name)?.obliterate({ force: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500))
    expect(listener).not.toHaveBeenCalled()
    expect((await queues.getMetrics(`${name}-dlq`)).counts.waiting).toBe(0)
  }, 30_000)
})
