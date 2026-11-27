/**
 * @fileoverview A host that serves `/metrics` through `@bymax-one/nest-core` with the queue's
 * observability module, on the built package and in plain Node, where nest-core can import
 * `prom-client`. It prints `READY <url>` once a job waits in the `orders` queue, and closes the
 * application and exits when its standard input ends.
 * @layer test/e2e/fixtures
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { BymaxCoreModule } from '@bymax-one/nest-core'
import { BymaxQueueModule, QueueService } from '../../../dist/server/index.mjs'
import { BymaxQueueObservabilityModule } from '../../../dist/observability/index.mjs'

/** The host module: a constructor function, which Nest decorates like a class. */
const Host = Object.assign(function Host() {
  return undefined
}, {})
Module({
  imports: [
    BymaxCoreModule.forRoot({ metrics: { enabled: true, collectDefaultMetrics: false } }),
    BymaxQueueModule.forRoot({
      connection: { url: process.env.REDIS_URL },
      metrics: { enabled: true, cacheTtlMs: 0 },
      shutdown: { drainTimeoutMs: 1000 },
    }),
    BymaxQueueObservabilityModule,
  ],
})(Host)

const app = await NestFactory.create(Host, new FastifyAdapter(), { logger: ['error'] })
await app.listen(0, '127.0.0.1')
await app.get(QueueService).enqueue('orders', 'place', {})
console.log(`READY ${await app.getUrl()}`)

process.stdin.on('end', () => {
  void app.close()
})
process.stdin.resume()
