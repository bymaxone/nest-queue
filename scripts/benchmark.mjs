/**
 * @fileoverview Local benchmark for `@bymax-one/nest-queue`, run by hand against a disposable
 * Redis. It is not a CI gate: the numbers depend on the machine and on what else is running.
 * @layer scripts
 *
 * Measures, against the built package in `dist/`:
 *
 * - enqueue throughput: sequential `enqueue`, concurrent `enqueue` and `enqueueBulk` of 1000;
 * - end-to-end latency (enqueue to job completed) at worker concurrency 1, 10 and 50, with
 *   the enqueues paced so the queue never backs up, and the drain throughput of a burst;
 * - the Redis commands one job costs, from the `INFO commandstats` delta;
 * - the Redis connections each feature opens, from `INFO clients`.
 *
 * Usage (Redis 8 in Docker, then this script):
 *
 *   docker run --rm -d --name nq-bench -p 6390:6379 redis:8-alpine
 *   pnpm build
 *   REDIS_URL=redis://127.0.0.1:6390 node scripts/benchmark.mjs
 *
 * Every key lives under a unique prefix and is deleted at the end, so a shared Redis is left as
 * it was found. Sizes can be changed with BENCH_SEQUENTIAL, BENCH_CONCURRENT, BENCH_BULK_BATCHES,
 * BENCH_LATENCY_JOBS, BENCH_LATENCY_RATE and BENCH_BURST.
 */

import 'reflect-metadata'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Redis } from 'ioredis'
import {
  BymaxQueueModule,
  FlowService,
  QueueEventsRegistry,
  QueueService,
  WorkerRegistry,
} from '../dist/server/index.mjs'

const URL_ = process.env.REDIS_URL
if (!URL_) {
  console.error('Set REDIS_URL, for example redis://127.0.0.1:6390')
  process.exit(1)
}

const number = (name, fallback) => Number(process.env[name] ?? fallback)
const SEQUENTIAL = number('BENCH_SEQUENTIAL', 2000)
const CONCURRENT = number('BENCH_CONCURRENT', 10000)
const IN_FLIGHT = 100
const BULK_BATCHES = number('BENCH_BULK_BATCHES', 20)
const BULK_SIZE = 1000
const LATENCY_JOBS = number('BENCH_LATENCY_JOBS', 1000)
const LATENCY_RATE = number('BENCH_LATENCY_RATE', 200)
const BURST = number('BENCH_BURST', 5000)
const PREFIX = `bench-${String(Date.now())}`

const admin = new Redis(URL_, { maxRetriesPerRequest: 3 })

/** Percentile of an ascending array, nearest rank. */
function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/** The `INFO` section as a plain object. */
async function info(section) {
  const text = await admin.info(section)
  const out = {}
  for (const line of text.split('\r\n')) {
    const at = line.indexOf(':')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

/** Calls per command from `INFO commandstats`. */
async function commandCalls() {
  const stats = await info('commandstats')
  const calls = {}
  for (const [key, value] of Object.entries(stats)) {
    calls[key.replace('cmdstat_', '')] = Number(/calls=(\d+)/.exec(value)?.[1] ?? 0)
  }
  return calls
}

/** Total and per-command call delta between two snapshots, ignoring the admin's own INFO. */
function callDelta(before, after) {
  const delta = {}
  for (const [cmd, count] of Object.entries(after)) {
    const diff = count - (before[cmd] ?? 0)
    if (diff > 0 && cmd !== 'info') delta[cmd] = diff
  }
  return delta
}

/** Connections other than the admin's own. */
async function clients() {
  return Number((await info('clients')).connected_clients) - 1
}

/** Boot a Nest application context around the library with the given module options. */
async function boot(options) {
  const Bench = function BenchModule() {
    return undefined
  }
  Module({ imports: [BymaxQueueModule.forRoot({ prefix: PREFIX, ...options })] })(Bench)
  const app = await NestFactory.createApplicationContext(Bench, { logger: false })
  return {
    app,
    queue: app.get(QueueService),
    workers: app.get(WorkerRegistry),
    events: app.get(QueueEventsRegistry),
    flows: app.get(FlowService),
  }
}

const rate = (count, ms) => Math.round((count / ms) * 1000)
const rows = []
const row = (...cells) => rows.push(`| ${cells.join(' | ')} |`)

/** Wait for a condition, failing after two minutes so a lost job cannot hang the run. */
async function until(condition, what) {
  const deadline = performance.now() + 120_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** Run `count` operations with at most `limit` in flight; resolves with the elapsed ms. */
async function pool(count, limit, task) {
  let next = 0
  const started = performance.now()
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < count) await task(next++)
    }),
  )
  return performance.now() - started
}

async function enqueueThroughput() {
  const { app, queue } = await boot({ connection: { url: URL_ } })
  const sequentialBefore = await commandCalls()
  const sequentialMs = await pool(SEQUENTIAL, 1, (i) => queue.enqueue('seq', 'job', { i }))
  const sequentialCalls = callDelta(sequentialBefore, await commandCalls())
  const concurrentMs = await pool(CONCURRENT, IN_FLIGHT, (i) => queue.enqueue('con', 'job', { i }))
  const bulkBefore = await commandCalls()
  const jobs = Array.from({ length: BULK_SIZE }, (_, i) => ({ name: 'job', data: { i } }))
  const bulkMs = await pool(BULK_BATCHES, 1, () => queue.enqueueBulk('bulk', jobs))
  const bulkCalls = callDelta(bulkBefore, await commandCalls())
  await app.close()
  const bulkTotal = BULK_BATCHES * BULK_SIZE
  console.log('\n## Enqueue throughput\n')
  console.log('| Mode | Jobs | Elapsed ms | Jobs/s | Redis commands per job |')
  console.log('| --- | ---: | ---: | ---: | --- |')
  const perJob = (calls, n) =>
    Object.entries(calls)
      .map(([cmd, c]) => `${cmd} ${(c / n).toFixed(2)}`)
      .join(', ')
  console.log(
    `| single, sequential | ${SEQUENTIAL} | ${Math.round(sequentialMs)} | ${rate(SEQUENTIAL, sequentialMs)} | ${perJob(sequentialCalls, SEQUENTIAL)} |`,
  )
  console.log(
    `| single, ${IN_FLIGHT} in flight | ${CONCURRENT} | ${Math.round(concurrentMs)} | ${rate(CONCURRENT, concurrentMs)} | same call per job |`,
  )
  console.log(
    `| enqueueBulk(${BULK_SIZE}) | ${bulkTotal} | ${Math.round(bulkMs)} | ${rate(bulkTotal, bulkMs)} | ${perJob(bulkCalls, bulkTotal)} |`,
  )
}

async function latency(concurrency) {
  const { app, queue, workers } = await boot({ connection: { url: URL_ } })
  const name = `lat${String(concurrency)}`
  const samples = []
  const worker = workers.register({
    queueName: name,
    handler: async () => undefined,
    options: { concurrency },
  })
  // `completed` fires once the job is marked finished in Redis, so the sample spans the whole
  // path: enqueue, delivery, the handler and the completion write.
  worker.on('completed', (job) => {
    samples.push(performance.now() - job.data.t0)
  })
  await sleep(500)
  const interval = 1000 / LATENCY_RATE
  const startedAt = performance.now()
  for (let i = 0; i < LATENCY_JOBS; i += 1) {
    const due = startedAt + i * interval
    const wait = due - performance.now()
    if (wait > 1) await sleep(wait)
    await queue.enqueue(name, 'job', { t0: performance.now() })
  }
  await until(() => samples.length >= LATENCY_JOBS, 'latency jobs to complete')
  samples.sort((a, b) => a - b)
  const latencyRow = [
    String(concurrency),
    percentile(samples, 50).toFixed(2),
    percentile(samples, 95).toFixed(2),
    percentile(samples, 99).toFixed(2),
  ]
  const burstName = `burst${String(concurrency)}`
  let drained = 0
  const burstWorker = workers.register({
    queueName: burstName,
    handler: async () => undefined,
    options: { concurrency },
  })
  burstWorker.on('completed', () => {
    drained += 1
  })
  await sleep(300)
  const burstJobs = Array.from({ length: BURST }, (_, i) => ({ name: 'job', data: { i } }))
  const burstStart = performance.now()
  for (let at = 0; at < BURST; at += BULK_SIZE) {
    await queue.enqueueBulk(burstName, burstJobs.slice(at, at + BULK_SIZE))
  }
  await until(() => drained >= BURST, 'burst jobs to complete')
  const burstMs = performance.now() - burstStart
  await app.close()
  return [...latencyRow, String(rate(BURST, burstMs))]
}

async function latencyTable() {
  console.log(
    `\n## End-to-end latency (enqueue to job completed), ${LATENCY_JOBS} jobs paced at ${LATENCY_RATE}/s, no-op handler\n`,
  )
  console.log(
    '| Concurrency | p50 ms | p95 ms | p99 ms | Burst drain jobs/s (enqueueBulk, ' +
      String(BURST) +
      ' jobs) |',
  )
  console.log('| ---: | ---: | ---: | ---: | ---: |')
  for (const concurrency of [1, 10, 50])
    console.log(`| ${(await latency(concurrency)).join(' | ')} |`)
}

/** The connections a scenario holds while it is open, then released. */
async function connectionRow(label, scenario, options = {}) {
  const before = await clients()
  const booted = await boot({ connection: { url: URL_ }, ...options })
  await scenario(booted)
  await sleep(300)
  const open = (await clients()) - before
  await booted.app.close()
  await sleep(300)
  const left = (await clients()) - before
  row(label, String(open), String(left))
}

/** Scenarios where the caller owns the client (Mode A) and the module opens none of its own. */
async function consumerOwnedConnections(sharedClient) {
  await connectionRow('module, Mode B (library-owned)', async () => undefined)
  await connectionRow('module, Mode A (your client, not counted)', async () => undefined, {
    connection: { client: sharedClient },
  })
  await connectionRow(
    'Mode A + 1 worker',
    ({ workers }) => {
      workers.register({ queueName: 'aw1', handler: async () => undefined })
    },
    { connection: { client: sharedClient } },
  )
  await connectionRow(
    'Mode A + QueueEvents on 1 queue',
    ({ events }) => {
      events.getOrCreate('ae1')
    },
    { connection: { client: sharedClient } },
  )
}

/** Scenarios where the module owns its connection (Mode B). */
async function libraryOwnedConnections() {
  await connectionRow('Mode B + 1 queue (one enqueue)', ({ queue }) => queue.enqueue('c1', 'j', {}))
  await connectionRow('Mode B + 10 queues', async ({ queue }) => {
    for (let i = 0; i < 10; i += 1) await queue.enqueue(`c${String(i)}`, 'j', {})
  })
  await connectionRow('Mode B + 1 worker', ({ workers }) => {
    workers.register({ queueName: 'w1', handler: async () => undefined })
  })
  await connectionRow('Mode B + 5 workers', ({ workers }) => {
    for (let i = 0; i < 5; i += 1)
      workers.register({ queueName: `w${String(i)}`, handler: async () => undefined })
  })
  await connectionRow('Mode B + QueueEvents on 1 queue', ({ events }) => {
    events.getOrCreate('e1')
  })
  await connectionRow('Mode B + QueueEvents on 5 queues', ({ events }) => {
    for (let i = 0; i < 5; i += 1) events.getOrCreate(`e${String(i)}`)
  })
  await connectionRow(
    'Mode B + flows enabled (FlowProducer, one flow)',
    ({ flows }) =>
      flows.add({
        name: 'p',
        queueName: 'fp',
        data: {},
        children: [{ name: 'c', queueName: 'fc', data: {} }],
      }),
    { flows: { enabled: true } },
  )
}

async function connections() {
  const sharedClient = new Redis(URL_)
  // Counted before the baseline is read, so its own connection is not billed to a scenario.
  await sharedClient.ping()
  console.log('\n## Redis connections held (INFO clients delta, admin excluded)\n')
  await consumerOwnedConnections(sharedClient)
  await libraryOwnedConnections()
  console.log('| Scenario | Connections while open | Left after close |')
  console.log('| --- | ---: | ---: |')
  console.log(rows.join('\n'))
  await sharedClient.quit()
}

/** Delete every key this run created. */
async function cleanup() {
  let cursor = '0'
  do {
    const [next, keys] = await admin.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 1000)
    cursor = next
    if (keys.length > 0) await admin.del(...keys)
  } while (cursor !== '0')
}

async function main() {
  const server = await info('server')
  const stats = await info('memory')
  console.log(`# nest-queue benchmark\n`)
  console.log(`- Redis: ${server.redis_version} (${server.redis_mode}), os ${server.os}`)
  console.log(`- Node: ${process.version}, ${process.platform} ${process.arch}`)
  console.log(`- Prefix: ${PREFIX}; Redis used_memory at start: ${stats.used_memory_human}`)
  try {
    await enqueueThroughput()
    await latencyTable()
    await connections()
  } finally {
    await cleanup()
    await admin.quit()
  }
}

await main()
