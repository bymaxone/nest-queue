/**
 * @fileoverview Canonical dead-letter-queue (DLQ) example processor. Once a job
 * exhausts its retries, a `@OnWorkerEvent('failed')` listener copies the payload
 * plus failure metadata onto a `<queue>-dlq` queue using only the public API.
 * The re-enqueue is idempotent (stable DLQ jobId) so a redelivered `failed`
 * event never double-inserts. Consumed by the E2E suite.
 * @layer test/e2e/fixtures
 */

import { Injectable } from '@nestjs/common'
import { OnWorkerEvent, Process, Processor, QueueService } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

/** Payload for the risky job that may fail on purpose. */
interface RiskyData {
  /** When true, the handler throws to drive the job toward exhaustion. */
  willFail: boolean
  /** Arbitrary payload preserved through to the dead-letter record. */
  payload: string
}

/**
 * Processes the `risky` queue and dead-letters exhausted jobs. The handler fails
 * deterministically when `willFail` is set; once BullMQ has used every attempt,
 * the failure listener routes the job to `risky-dlq`.
 */
@Injectable()
@Processor('risky', { concurrency: 2 })
export class DlqProcessor {
  constructor(private readonly queues: QueueService) {}

  /**
   * Handle a `risky` job. Throws on demand so the retry/exhaustion path can be
   * exercised end to end. Handlers are idempotent by contract (at-least-once).
   *
   * @param job - The risky job.
   */
  @Process()
  async handle(job: Job<RiskyData>): Promise<void> {
    await Promise.resolve()
    if (job.data.willFail) throw new Error('intentional failure')
  }

  /**
   * Dead-letter routing: once retries are exhausted, copy the payload and the
   * failure metadata onto the `<queue>-dlq` queue. Idempotent via a stable DLQ
   * `jobId` so a redelivered `failed` event never double-inserts.
   *
   * @param job - The failed job, or `undefined` if it failed before being fetched.
   * @param error - The error that failed the job.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<RiskyData> | undefined, error: Error): Promise<void> {
    if (!job) return
    const maxAttempts = job.opts.attempts ?? 1
    if (job.attemptsMade < maxAttempts) return // not exhausted yet — let BullMQ retry
    await this.queues.enqueue(
      'risky-dlq',
      'dead-letter',
      {
        original: job.data,
        failedReason: error.message,
        attemptsMade: job.attemptsMade,
        jobId: job.id,
      },
      { jobId: `dlq:${job.id ?? 'unknown'}` },
    )
  }
}
