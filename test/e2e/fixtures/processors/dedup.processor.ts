/**
 * @fileoverview Deduplication processor fixture. Counts how many jobs are
 * actually processed so the E2E suite can prove that many rapid same-key
 * enqueues collapse into a single processed job.
 * @layer test/e2e/fixtures
 */

import { Injectable } from '@nestjs/common'
import { Process, Processor } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

/** Processes the `dedup` queue, counting real (non-deduplicated) jobs. */
@Injectable()
@Processor('dedup')
export class DedupProcessor {
  /** Number of jobs that reached the handler. */
  processed = 0

  /**
   * Count a processed job after a brief delay (so concurrent enqueues collapse).
   *
   * @param _job - The dedup job (payload unused).
   */
  @Process()
  async handle(_job: Job): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    this.processed += 1
  }
}
