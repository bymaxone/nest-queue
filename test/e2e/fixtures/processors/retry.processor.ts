/**
 * @fileoverview Retry processor fixture. Fails its first two attempts then
 * succeeds, so the E2E suite can prove the failure → exponential-backoff retry →
 * eventual-success path across exactly three attempts.
 * @layer test/e2e/fixtures
 */

import { Injectable } from '@nestjs/common'
import { Process, Processor } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

/** Number of attempts before the handler succeeds. */
const SUCCEED_ON_ATTEMPT = 3

/** Processes the `retry` queue, failing until the success threshold. */
@Injectable()
@Processor('retry')
export class RetryProcessor {
  /** Count of handler invocations across retries. */
  attempts = 0
  /** Set once the handler finally succeeds. */
  succeeded = false

  /**
   * Fail until {@link SUCCEED_ON_ATTEMPT} is reached, then succeed.
   *
   * @param _job - The retry job (payload unused).
   */
  @Process()
  async handle(_job: Job): Promise<void> {
    await Promise.resolve()
    this.attempts += 1
    if (this.attempts < SUCCEED_ON_ATTEMPT) {
      throw new Error(`transient failure on attempt ${String(this.attempts)}`)
    }
    this.succeeded = true
  }
}
