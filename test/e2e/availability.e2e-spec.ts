/**
 * @fileoverview End-to-end checks, against a real Redis, of what a host sees when Redis goes away
 * and when the application closes with a handler that never settles: a call made while the
 * connection is down, the first call on a queue name during the outage, the listeners the client
 * carries through it, and a process that must exit by itself after `app.close()`.
 * @layer test/e2e
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Module, type INestApplicationContext } from '@nestjs/common'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import {
  BymaxQueueModule,
  ConnectionResolver,
  QueueException,
  QueueService,
} from '@bymax-one/nest-queue'

/** The same pinned image the other end-to-end suites use. */
const REDIS_IMAGE =
  'redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'
/** A fixed host port, so a stopped container comes back on the same address. */
const HOST_PORT = 46_397
const URL = `redis://127.0.0.1:${String(HOST_PORT)}`
const ENQUEUE_TIMEOUT_MS = 1500

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** The code and details of a rejected call, or what it was if it was not a QueueException. */
async function outcome(call: Promise<unknown>): Promise<{ code?: string; details?: unknown }> {
  try {
    await call
    return {}
  } catch (err) {
    if (!(err instanceof QueueException)) return { code: String(err) }
    const { error } = err.getResponse() as { error: { code: string; details: unknown } }
    return { code: error.code, details: error.details }
  }
}

/** The host module the suite boots, wired to the container's fixed address. */
@Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: URL },
      enqueueTimeoutMs: ENQUEUE_TIMEOUT_MS,
      shutdown: { drainTimeoutMs: 1000 },
    }),
  ],
})
class Host {}

let container: StartedTestContainer
let app: INestApplicationContext
let queues: QueueService
let client: ReturnType<ConnectionResolver['getClient']>

beforeAll(async () => {
  container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts({ container: 6379, host: HOST_PORT })
    .start()
  app = await NestFactory.createApplicationContext(Host, { logger: false })
  queues = app.get(QueueService)
  client = app.get(ConnectionResolver).getClient()
}, 90_000)

afterAll(async () => {
  await Promise.race([app.close(), sleep(10_000)])
  await container.stop().catch(() => undefined)
})

describe('E2E — a Redis that goes away and comes back', () => {
  it('rejects every call with CONNECTION_TIMEOUT, keeps the client listeners bounded, and recovers', async () => {
    await queues.getMetrics('warm')
    const baseline = client.listenerCount('ready')

    execFileSync('docker', ['stop', container.getId()])
    await sleep(1500)

    // A queue already in use: refused at once by the disabled offline queue, now as the documented code.
    const started = Date.now()
    expect(await outcome(queues.getMetrics('warm'))).toStrictEqual({
      code: 'queue.connection_timeout',
      details: { operation: 'getMetrics', reason: 'offline' },
    })
    expect(Date.now() - started).toBeLessThan(500)

    // A queue name never used: bounded by the per-call deadline, for every call that can wait.
    const cold = 'cold'
    const coldCalls: [string, () => Promise<unknown>][] = [
      ['getMetrics', () => queues.getMetrics(`${cold}-1`)],
      ['getJob', () => queues.getJob(`${cold}-2`, '1')],
      ['getJobs', () => queues.getJobs(`${cold}-3`, 'waiting')],
      ['getJobSchedulers', () => queues.getJobSchedulers(`${cold}-4`)],
      ['removeJobScheduler', () => queues.removeJobScheduler(`${cold}-5`, 'tick')],
      ['pauseQueue', () => queues.pauseQueue(`${cold}-6`)],
      ['resumeQueue', () => queues.resumeQueue(`${cold}-7`)],
      ['cleanQueue', () => queues.cleanQueue(`${cold}-8`, 1000, 10)],
      ['enqueue', () => queues.enqueue(`${cold}-9`, 'job', {})],
      ['enqueueBulk', () => queues.enqueueBulk(`${cold}-10`, [{ name: 'job', data: {} }])],
    ]
    const coldStart = Date.now()
    const results = await Promise.all(coldCalls.map(([, call]) => outcome(call())))
    const elapsed = Date.now() - coldStart
    coldCalls.forEach(([operation], index) => {
      expect(results[index]).toStrictEqual({
        code: 'queue.connection_timeout',
        details: { operation, timeoutMs: ENQUEUE_TIMEOUT_MS },
      })
    })
    expect(elapsed).toBeLessThan(ENQUEUE_TIMEOUT_MS + 1500)

    // Fifty more cold calls on fifty more names, polled the way a health check would.
    const polls = await Promise.all(
      Array.from({ length: 50 }, (_, index) => outcome(queues.getMetrics(`poll-${String(index)}`))),
    )
    expect(polls.every((result) => result.code === 'queue.connection_timeout')).toBe(true)
    expect(client.listenerCount('ready')).toBeLessThanOrEqual(baseline + 1)

    execFileSync('docker', ['start', container.getId()])
    for (let i = 0; i < 100 && client.status !== 'ready'; i++) await sleep(200)
    expect(client.status).toBe('ready')
    expect(client.listenerCount('ready')).toBe(baseline)
    await expect(queues.getMetrics('after-recovery')).resolves.toMatchObject({
      queue: 'after-recovery',
    })
  }, 120_000)
})

describe('E2E — the process after app.close() with a handler that never settles', () => {
  it('exits by itself within the drain budget plus a small margin, with no renewal errors', async () => {
    const dist = resolve(__dirname, '../../dist/server/index.mjs')
    if (!existsSync(dist)) execFileSync('pnpm', ['build'], { cwd: resolve(__dirname, '../..') })

    const child = spawn(process.execPath, [resolve(__dirname, 'fixtures/stuck-worker.child.mjs')], {
      env: { ...process.env, REDIS_URL: URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let closedAt = 0
    let stderrAfterClose = ''
    let exitedAt = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (closedAt === 0 && stdout.includes('CLOSED')) closedAt = Date.now()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (closedAt > 0) stderrAfterClose += chunk.toString()
    })
    child.on('exit', () => {
      exitedAt = Date.now()
    })

    const waitUntil = Date.now() + 30_000
    while (exitedAt === 0 && Date.now() < waitUntil) await sleep(100)
    if (exitedAt === 0) child.kill('SIGKILL')

    expect(exitedAt).toBeGreaterThan(0)
    expect(closedAt).toBeGreaterThan(0)
    // The close itself took the drain budget (1 s); the process was gone within a few seconds more.
    expect(exitedAt - closedAt).toBeLessThan(3000)
    expect(stderrAfterClose).not.toContain('Connection is closed')
    expect(stderr).not.toContain('CHILD ERROR')
  }, 90_000)
})
