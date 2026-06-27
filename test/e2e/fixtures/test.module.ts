/**
 * @fileoverview Test application module factory for the E2E suite. Wires the
 * library via `forRootAsync` and registers every fixture processor plus the
 * flow recorder so one application context can exercise all scenarios.
 * @layer test/e2e/fixtures
 */

import { Module, type DynamicModule } from '@nestjs/common'
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import type { QueueConnectionConfig } from '@bymax-one/nest-queue'
import { EchoProcessor } from './processors/echo.processor'
import { SlowProcessor } from './processors/slow.processor'
import { RetryProcessor } from './processors/retry.processor'
import { DedupProcessor } from './processors/dedup.processor'
import { DlqProcessor } from './processors/dlq.processor'
import {
  FlowChildProcessor,
  FlowLeafProcessor,
  FlowRecorder,
  FlowRootProcessor,
} from './processors/flow.processors'

/** Empty host module; all wiring is supplied by {@link buildTestModule}. */
@Module({})
export class TestRootModule {}

/**
 * Build the E2E application module for a given connection (Mode A or Mode B).
 * Flows and metrics are enabled and the drain budget is bounded so graceful
 * shutdown can be exercised quickly.
 *
 * @param connection - The Redis connection configuration under test.
 * @returns A dynamic module wiring the library and all fixtures.
 */
export function buildTestModule(connection: QueueConnectionConfig): DynamicModule {
  return {
    module: TestRootModule,
    imports: [
      BymaxQueueModule.forRootAsync({
        useFactory: () => ({
          connection,
          flows: { enabled: true },
          metrics: { enabled: true },
          shutdown: { drainTimeoutMs: 5_000 },
        }),
      }),
    ],
    providers: [
      EchoProcessor,
      SlowProcessor,
      RetryProcessor,
      DedupProcessor,
      DlqProcessor,
      FlowRecorder,
      FlowLeafProcessor,
      FlowChildProcessor,
      FlowRootProcessor,
    ],
  }
}
