/**
 * @fileoverview What a host with a sandboxed worker sees after `app.close()` ends the drain budget
 * with the job still running, against a real Redis: the process exits by itself, and the job is not
 * recorded by the stopped worker, so the next consumer runs it again.
 * @layer test/e2e
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** How long the harness lets the host live before it kills it. */
const HOST_CAP_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

let redis: RedisContainer
let connection: Redis

beforeAll(async () => {
  const root = resolve(__dirname, '../..')
  if (!existsSync(resolve(root, 'dist/server/index.mjs')))
    execFileSync('pnpm', ['build'], { cwd: root })
  redis = await startRedisContainer()
  connection = new Redis(redis.url, { maxRetriesPerRequest: null })
}, 120_000)

afterAll(async () => {
  await connection.quit()
  await redis.stop()
})

/** Run the fixture host until it exits, or kill it after `HOST_CAP_MS`. */
async function runHost(env: Record<string, string>): Promise<{
  killedByHarness: boolean
  closed: boolean
  stderr: string
}> {
  const child = spawn(process.execPath, [resolve(__dirname, 'fixtures/sandboxed-host.child.mjs')], {
    env: { ...process.env, REDIS_URL: redis.url, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  const waitUntil = Date.now() + HOST_CAP_MS
  while (running() && Date.now() < waitUntil) await sleep(100)
  const killedByHarness = running()
  if (killedByHarness) child.kill('SIGKILL')
  return { killedByHarness, closed: stdout.includes('CLOSED'), stderr }
}

/** The state of the host's only job, read once the host is gone. */
async function stateOfJob(queueName: string): Promise<string> {
  const queue = new Queue(queueName, { connection })
  try {
    return await queue.getJobState('only')
  } finally {
    await queue.close()
  }
}

describe('E2E — a sandboxed job that outlasts the drain budget', () => {
  it('lets the host exit when the job succeeds after the budget ended', async () => {
    const host = await runHost({ QUEUE_NAME: 'late-success', JOB_MS: '4000' })

    expect(host.closed).toBe(true)
    expect(host.killedByHarness).toBe(false)
    expect(host.stderr).not.toContain('CHILD ERROR')
    expect(await stateOfJob('late-success')).toBe('active')
  }, 90_000)

  it('lets the host exit when the job reports progress after the budget ended', async () => {
    const host = await runHost({ QUEUE_NAME: 'late-progress', JOB_MS: '4000', PROGRESS_MS: '300' })

    expect(host.closed).toBe(true)
    expect(host.killedByHarness).toBe(false)
    expect(host.stderr).not.toContain('CHILD ERROR')
    expect(await stateOfJob('late-progress')).toBe('active')
  }, 90_000)

  it('leaves a worker-thread job to be run again instead of recording it as failed', async () => {
    const host = await runHost({
      QUEUE_NAME: 'late-thread',
      JOB_MS: '60000',
      USE_THREADS: 'true',
    })

    expect(host.closed).toBe(true)
    expect(await stateOfJob('late-thread')).toBe('active')
    expect(host.killedByHarness).toBe(false)

    // The next consumer finds the lock expired and runs the stalled job again.
    const successor = new Worker('late-thread', () => Promise.resolve('retried'), {
      connection,
      lockDuration: 2000,
      stalledInterval: 500,
    })
    try {
      const waitUntil = Date.now() + 20_000
      while ((await stateOfJob('late-thread')) !== 'completed' && Date.now() < waitUntil)
        await sleep(200)
      expect(await stateOfJob('late-thread')).toBe('completed')
    } finally {
      await successor.close()
    }
  }, 90_000)

  it('records the result of a job that finishes within the budget', async () => {
    const host = await runHost({
      QUEUE_NAME: 'in-time',
      JOB_MS: '1500',
      DRAIN_TIMEOUT_MS: '15000',
    })

    expect(host.killedByHarness).toBe(false)
    expect(await stateOfJob('in-time')).toBe('completed')
  }, 90_000)
})
