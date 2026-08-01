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
      // The variadic signature and the narrowing below are NOT a style choice.
      // `BymaxQueueModuleAsyncOptions.useFactory` is declared as
      // `(...args: unknown[]) => …`, and a parameter of type `unknown` accepts
      // no narrower parameter under `strictFunctionTypes` — so the shape both
      // the README and the module's own `@example` show,
      // `useFactory: (client: Redis) => …`, does not compile:
      //
      //   TS2322: Type '(client: Redis) => …' is not assignable to
      //           type '(...args: unknown[]) => …'
      //
      // This is the fixture doing its job: it reproduces what a consumer must
      // actually write. Tidying it away here would hide the defect rather than
      // fix it. Once the declared parameter type accepts a narrower factory,
      // this collapses to the one-liner the documentation already promises.
      useFactory: (...args: unknown[]) => {
        const queueRedis = args[0]
        if (!(queueRedis instanceof Redis)) {
          throw new TypeError(
            `BymaxQueueModule.forRootAsync expected the QUEUE_REDIS_CLIENT provider ` +
              `to resolve to an ioredis client, but received ${typeof queueRedis}. ` +
              `Check that RedisModule is imported and exports QUEUE_REDIS_CLIENT.`,
          )
        }
        return {
          connection: { client: queueRedis },
          isGlobal: true,
          flows: { enabled: true },
          metrics: { enabled: true, cacheTtlMs: 5_000 },
          shutdown: { drainTimeoutMs: 30_000 },
        }
      },
    }),
  ],
  controllers: [HealthController],
  providers: [EmailProcessor, EmailService],
})
export class AppModule {}
