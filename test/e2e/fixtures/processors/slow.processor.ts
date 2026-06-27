/**
 * @fileoverview Slow processor fixture. Sleeps for the requested duration so the
 * E2E suite can prove that graceful shutdown drains an in-flight job before the
 * application context closes.
 * @layer test/e2e/fixtures
 */

import { Injectable } from '@nestjs/common'
import { Process, Processor } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

/** Input payload for the slow job. */
export interface SlowData {
  /** How long the handler should sleep, in milliseconds. */
  ms: number
}

/** Processes the `slow` queue with a deliberate delay. */
@Injectable()
@Processor('slow')
export class SlowProcessor {
  /** Set once the handler begins processing (the job is active). */
  started = false
  /** Set once the handler finishes (the in-flight job completed). */
  completed = false

  /**
   * Sleep for `job.data.ms` then mark completion.
   *
   * @param job - The slow job.
   */
  @Process()
  async handle(job: Job<SlowData>): Promise<void> {
    this.started = true
    await new Promise<void>((resolve) => setTimeout(resolve, job.data.ms))
    this.completed = true
  }
}
