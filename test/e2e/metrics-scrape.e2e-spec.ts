/**
 * @fileoverview Scrapes the `/metrics` endpoint `@bymax-one/nest-core` serves, over HTTP, while a
 * real Redis is frozen. The endpoint bounds the whole collection (`scrapeTimeoutMs`, 5000 ms by
 * default) and a Redis command waits as long by default, so the depth gauge has to give up on its
 * own, well before either: the scrape answers with every other series and no depth.
 * @layer test/e2e
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** nest-core's default scrape bound, and the library's default command deadline. */
const SCRAPE_BOUND_MS = 5000

let redis: RedisContainer
let host: ChildProcessWithoutNullStreams
let url: string
let paused = false

/** Freeze or thaw the Redis process: its sockets stay open and answer nothing while frozen. */
function setFrozen(frozen: boolean): void {
  execFileSync('docker', [frozen ? 'pause' : 'unpause', redis.container.getId()])
  paused = frozen
}

/** One scrape: the status, the body and how long the answer took. */
async function scrape(): Promise<{ status: number; body: string; ms: number }> {
  const started = performance.now()
  const response = await fetch(`${url}/metrics`)
  const body = await response.text()
  return { status: response.status, body, ms: performance.now() - started }
}

/** The depth samples of a scrape. */
function depthOf(body: string): string[] {
  return body.split('\n').filter((line) => line.startsWith('bymax_queue_depth{'))
}

/** The URL the host prints once it serves, or a failure with what it wrote instead. */
function ready(child: ChildProcessWithoutNullStreams): Promise<string> {
  let written = ''
  return new Promise((done, fail) => {
    const read = (chunk: Buffer): void => {
      written += chunk.toString()
      const found = /READY (\S+)/.exec(written)?.[1]
      if (found !== undefined) done(found)
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', (code) => {
      fail(new Error(`the host exited with ${String(code)}: ${written}`))
    })
  })
}

beforeAll(async () => {
  redis = await startRedisContainer()
  const root = resolve(__dirname, '../..')
  if (!existsSync(resolve(root, 'dist/observability/index.mjs'))) {
    execFileSync('pnpm', ['build'], { cwd: root })
  }
  host = spawn(process.execPath, [resolve(__dirname, 'fixtures/metrics-host.child.mjs')], {
    env: { ...process.env, REDIS_URL: redis.url },
  })
  url = await ready(host)
}, 90_000)

afterAll(async () => {
  if (paused) setFrozen(false)
  if (host.exitCode === null) {
    const exited = once(host, 'exit')
    host.stdin.end()
    await exited
  }
  await redis.stop()
}, 60_000)

describe('E2E — a scrape of /metrics while Redis is frozen', () => {
  it('answers 200 well inside the scrape bound with the depth absent, and reports it again after', async () => {
    const healthy = await scrape()
    expect(healthy.status).toBe(200)
    expect(depthOf(healthy.body)).toHaveLength(4)

    setFrozen(true)
    const frozen = [await scrape(), await scrape()]
    setFrozen(false)

    for (const answer of frozen) {
      expect(answer.status).toBe(200)
      expect(answer.ms).toBeLessThan(SCRAPE_BOUND_MS)
      expect(answer.body).toContain('# TYPE bymax_queue_depth gauge')
      expect(depthOf(answer.body)).toEqual([])
    }

    let recovered: string[] = []
    for (let attempt = 0; attempt < 100 && recovered.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
      recovered = depthOf((await scrape()).body)
    }
    expect(recovered).toContain('bymax_queue_depth{queue="orders",state="waiting"} 1')
  }, 60_000)
})
