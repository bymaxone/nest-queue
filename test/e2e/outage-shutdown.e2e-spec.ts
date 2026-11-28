/**
 * @fileoverview What a host sees after `app.close()` while Redis refuses it, against a real Redis:
 * no connection is left reconnecting, so the process exits by itself, and ioredis reports no error
 * that nothing listened for.
 * @layer test/e2e
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** How long the harness lets the host live before it kills it. */
const HOST_CAP_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

let redis: RedisContainer

beforeAll(async () => {
  const root = resolve(__dirname, '../..')
  if (!existsSync(resolve(root, 'dist/server/index.mjs')))
    execFileSync('pnpm', ['build'], { cwd: root })
  redis = await startRedisContainer()
}, 120_000)

afterAll(async () => {
  await redis.stop()
})

/** Run the fixture host until it exits, or kill it after `HOST_CAP_MS`. */
async function runHost(env: Record<string, string>): Promise<{
  killedByHarness: boolean
  closed: boolean
  output: string
}> {
  const child = spawn(process.execPath, [resolve(__dirname, 'fixtures/outage-host.child.mjs')], {
    env: { ...process.env, REDIS_URL: redis.url, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  const waitUntil = Date.now() + HOST_CAP_MS
  while (running() && Date.now() < waitUntil) await sleep(100)
  const killedByHarness = running()
  if (killedByHarness) child.kill('SIGKILL')
  return { killedByHarness, closed: output.includes('CLOSED'), output }
}

describe('E2E — a shutdown while Redis refuses the host', () => {
  it.each([
    ['an idle worker, Redis refusing before the shutdown', 'idle', '0', '2000'],
    ['a job that ends within the drain budget', 'ends-in-budget', '2000', '6000'],
    ['a job that outlasts the drain budget', 'over-budget', '4000', '1500'],
  ])(
    'leaves nothing reconnecting: %s',
    async (_name, queueName, jobMs, drainMs) => {
      const host = await runHost({
        QUEUE_NAME: queueName,
        JOB_MS: jobMs,
        DRAIN_TIMEOUT_MS: drainMs,
      })

      expect(host.closed).toBe(true)
      expect(host.killedByHarness).toBe(false)
      expect(host.output).not.toContain('CHILD ERROR')
      expect(host.output).not.toContain('Unhandled error event')
    },
    90_000,
  )
})
