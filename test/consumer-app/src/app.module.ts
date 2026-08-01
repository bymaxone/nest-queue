/**
 * @fileoverview Root application module — wires BymaxQueueModule in Mode A using
 * a dedicated ioredis client, registers the email processor, and exposes queue metrics.
 * @layer application
 */

import { Module } from '@nestjs/common'
import { Redis } from 'ioredis'
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import { RedisModule, QUEUE_REDIS_CLIENT } from './redis.module.js'
import { EmailProcessor } from './email.processor.js'
import { EmailService } from './email.service.js'
import { HealthController } from './health.controller.js'

/**
 * Root module that demonstrates end-to-end integration of `@bymax-one/nest-queue`.
 *
 * Connection: **Mode A** — a dedicated ioredis client is created by `RedisModule`
 * and injected into `BymaxQueueModule.forRootAsync`. The library duplicates the
 * client per role and applies the correct `maxRetriesPerRequest` policy.
 *
 * Features demonstrated:
 * - `@Processor` / `@Process` decorators
 * - Job Scheduler via `upsertJobScheduler` (registered in `EmailService.onModuleInit`)
 * - Flow via the opt-in `FlowService`
 * - Queue metrics via `MetricsService` on the `/health` endpoint
 */
@Module({
  imports: [
    RedisModule.forRoot({
      url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    }),
    BymaxQueueModule.forRootAsync({
      inject: [QUEUE_REDIS_CLIENT],
      // The parameter is named with the type `inject` resolves to, which is the
      // shape the README and the module's own `@example` document. It compiles
      // because `BymaxQueueModuleAsyncOptions.useFactory` takes `never[]`; while
      // it took `unknown[]`, this exact line was rejected and the fixture had to
      // narrow a variadic `unknown[]` by hand.
      useFactory: (queueRedis: Redis) => ({
        connection: { client: queueRedis },
        isGlobal: true,
        flows: { enabled: true },
        metrics: { enabled: true, cacheTtlMs: 5_000 },
        shutdown: { drainTimeoutMs: 30_000 },
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [EmailProcessor, EmailService],
})
export class AppModule {}
