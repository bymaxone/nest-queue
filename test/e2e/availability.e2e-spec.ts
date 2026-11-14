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
/** The drain budget the fixture host runs with, and a margin on top of it generous enough for a loaded machine. */
const DRAIN_BUDGET_MS = 1000
const SHUTDOWN_MARGIN_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Whether `call` has settled by the next macrotask. A rejection that needs no I/O settles in a
 * microtask, while a call buffered until a reconnect, or waiting on a timer, does not. The sentinel
 * is a macrotask (`setImmediate`), so it cannot tie with a microtask rejection.
 */
function settlesBeforeNextMacrotask(call: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    call.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((done) => {
      setImmediate(() => {
        done(false)
      })
    }),
  ])
}

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
    const warmCall = outcome(queues.getMetrics('warm'))
    expect(await settlesBeforeNextMacrotask(warmCall)).toBe(true)
    expect(await warmCall).toStrictEqual({
      code: 'queue.connection_timeout',
      details: { operation: 'getMetrics', reason: 'offline' },
    })

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
    // No elapsed-time bound: a call without its deadline stays pending, which the test timeout reports.
    const results = await Promise.all(coldCalls.map(([, call]) => outcome(call())))
    coldCalls.forEach(([operation], index) => {
      expect(results[index]).toStrictEqual({
        code: 'queue.connection_timeout',
        details: { operation, timeoutMs: ENQUEUE_TIMEOUT_MS },
      })
    })

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

describe('E2E — the process after app.close() with a handler that outlasts the drain budget', () => {
  /** Run the fixture host and report when it printed CLOSED, when it exited and what it wrote after. */
  async function runChild(handlerSettlesMs: number): Promise<{
    closingAt: number
    closedAt: number
    exitedAt: number
    killedByHarness: boolean
    stderrAfterClose: string
    stderr: string
  }> {
    const dist = resolve(__dirname, '../../dist/server/index.mjs')
    if (!existsSync(dist)) execFileSync('pnpm', ['build'], { cwd: resolve(__dirname, '../..') })

    const child = spawn(process.execPath, [resolve(__dirname, 'fixtures/stuck-worker.child.mjs')], {
      env: {
        ...process.env,
        REDIS_URL: URL,
        HANDLER_SETTLES_MS: String(handlerSettlesMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let closingAt = 0
    let closedAt = 0
    let stderrAfterClose = ''
    let exitedAt = 0
    let killedByHarness = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (closingAt === 0 && stdout.includes('CLOSING')) closingAt = Date.now()
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
    if (exitedAt === 0) {
      killedByHarness = true
      child.kill('SIGKILL')
    }
    return { closingAt, closedAt, exitedAt, killedByHarness, stderrAfterClose, stderr }
  }

  it('exits by itself within the drain budget plus a small margin when it never settles', async () => {
    const { closingAt, closedAt, exitedAt, killedByHarness, stderrAfterClose, stderr } =
      await runChild(0)

    // The process left on its own: the harness only kills one that is still alive after its own cap.
    expect(killedByHarness).toBe(false)
    expect(exitedAt).toBeGreaterThan(0)
    expect(closedAt).toBeGreaterThan(0)
    // One real-clock check, with a margin made for a loaded machine, to prove the budget is wired:
    // from just before app.close() to the process being gone, the drain budget (1 s) plus the margin.
    expect(exitedAt - closingAt).toBeLessThan(DRAIN_BUDGET_MS + SHUTDOWN_MARGIN_MS)
    expect(stderrAfterClose).not.toContain('Connection is closed')
    expect(stderr).not.toContain('CHILD ERROR')
  }, 90_000)

  // The handler settles 0.5 s after the budget ended: the worker that was stopped must stay stopped.
  it('exits by itself when the handler settles after the budget ended', async () => {
    const { closedAt, exitedAt, killedByHarness, stderrAfterClose, stderr } = await runChild(1500)

    expect(killedByHarness).toBe(false)
    expect(exitedAt).toBeGreaterThan(0)
    expect(closedAt).toBeGreaterThan(0)
    expect(stderrAfterClose).not.toContain('Connection is closed')
    expect(stderr).not.toContain('CHILD ERROR')
  }, 90_000)
})
