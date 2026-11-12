/**
 * @fileoverview Runs the README "Mode A" wiring against the real `BymaxCacheModule` and a real
 * Redis. The snippet gate only type-checks the README, and a type-correct snippet can still wire
 * nothing: the factory below is the README's, and what is asserted is that the queue ends up on the
 * cache's own client and a job round-trips through it.
 * @layer test/e2e
 */

import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Injectable, Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { BymaxCacheModule, ConnectionManager } from '@bymax-one/nest-cache'
import type { Redis } from 'ioredis'
import {
  BymaxQueueModule,
  ConnectionResolver,
  Process,
  Processor,
  QueueService,
} from '@bymax-one/nest-queue'
import { startRedisContainer, type RedisContainer } from './setup/testcontainers'

/** The Mode A snippet of the README, as the README writes it. */
function readmeModeASnippet(): string {
  const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8')
  const start = readme.indexOf('### Mode A')
  const section = readme.slice(start, readme.indexOf('### Mode B', start))
  return /```typescript\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
}

/** Records the payloads the README-wired queue delivered. */
const received: string[] = []

/** A handler on a queue of its own, so the test does not depend on the shared fixtures. */
@Injectable()
@Processor('mode-a')
class ModeAProcessor {
  /** Record the payload. */
  @Process()
  handle(job: { data: { value: string } }): void {
    received.push(job.data.value)
  }
}

let redis: RedisContainer
let app: INestApplicationContext | undefined

beforeAll(async () => {
  redis = await startRedisContainer()
}, 60_000)

afterEach(async () => {
  await app?.close()
  app = undefined
  received.length = 0
})

afterAll(async () => {
  await redis.stop()
})

describe('E2E — the README Mode A wiring', () => {
  it('still says what this test runs', () => {
    // The module below is the README's wiring; if the README changes, this test must change with it.
    const snippet = readmeModeASnippet()
    expect(snippet).toContain('inject: [ConnectionManager]')
    expect(snippet).toContain('useFactory: (cache: ConnectionManager) => ({')
    expect(snippet).toContain('connection: { client: cache.getClient() as Redis },')
  })

  it('queues on the cache client and processes a job through it', async () => {
    @Module({
      imports: [
        BymaxCacheModule.forRoot({ connection: { url: redis.url } }),
        BymaxQueueModule.forRootAsync({
          inject: [ConnectionManager],
          useFactory: (cache: ConnectionManager) => ({
            connection: { client: cache.getClient() as Redis },
          }),
        }),
      ],
      providers: [ModeAProcessor],
    })
    class ModeAModule {}

    app = await NestFactory.createApplicationContext(ModeAModule, { logger: false })

    expect(app.get(ConnectionResolver).getClient()).toBe(app.get(ConnectionManager).getClient())
    await app.get(QueueService).enqueue('mode-a', 'mode-a', { value: 'via-cache' })
    const deadline = Date.now() + 10_000
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    expect(received).toEqual(['via-cache'])
  })
})
