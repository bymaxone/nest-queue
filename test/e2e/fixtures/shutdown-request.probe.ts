/**
 * @fileoverview Fixture standing in for a request that is still being served
 * while the application closes. NestJS runs `beforeApplicationShutdown` after
 * every `onModuleDestroy` hook and before the HTTP server is stopped, which is
 * the window in which an in-flight request can still enqueue a job.
 * @layer test/e2e/fixtures
 */

import { Inject, Injectable, type BeforeApplicationShutdown } from '@nestjs/common'
import { QueueService } from '@bymax-one/nest-queue'

/** What the late enqueue did: the job id it returned, or the error it threw. */
export type LateEnqueueOutcome = { jobId: string | undefined } | { error: string }

/** Enqueues one job in the window between the destroy hooks and the server stop. */
@Injectable()
export class ShutdownRequestProbe implements BeforeApplicationShutdown {
  /** Set once the late enqueue has settled. */
  outcome: LateEnqueueOutcome | undefined

  constructor(@Inject(QueueService) private readonly queues: QueueService) {}

  /** Enqueue as an in-flight request would, recording the result instead of throwing. */
  async beforeApplicationShutdown(): Promise<void> {
    try {
      const job = await this.queues.enqueue('echo', 'echo', { value: 'late' })
      this.outcome = { jobId: job.id }
    } catch (cause) {
      this.outcome = { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }
}
