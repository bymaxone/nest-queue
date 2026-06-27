/**
 * @fileoverview Email queue processor — handles outbound email jobs.
 * Demonstrates `@Processor` + `@Process` decorator usage with typed job data.
 * @layer application
 */

import { Injectable, Logger } from '@nestjs/common'
import { Processor, Process, OnWorkerEvent } from '@bymax-one/nest-queue'
import type { Job } from '@bymax-one/nest-queue'

/** Payload for a welcome email job. */
export interface WelcomeEmailPayload {
  /** The user's email address. */
  email: string
  /** The user's display name. */
  name: string
}

/** Payload for a digest email job. */
export interface DigestEmailPayload {
  /** The user's email address. */
  email: string
  /** Items to include in the digest. */
  items: string[]
}

/**
 * Processes jobs on the `email` queue.
 * Handles `welcome` and `digest` job types with typed payloads.
 *
 * @example
 * ```typescript
 * // Enqueue a welcome email
 * await queueService.enqueue<WelcomeEmailPayload, void>('email', 'welcome', {
 *   email: 'user@example.com',
 *   name: 'Alice',
 * })
 * ```
 */
@Injectable()
@Processor('email')
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name)

  /**
   * Handle a welcome email job.
   *
   * @param job - The BullMQ job with `WelcomeEmailPayload` data.
   */
  @Process('welcome')
  async handleWelcome(job: Job<WelcomeEmailPayload, void>): Promise<void> {
    this.logger.log(`Sending welcome email to ${job.data.email} (${job.data.name})`)
    // In production, call an email service here
  }

  /**
   * Handle a digest email job.
   *
   * @param job - The BullMQ job with `DigestEmailPayload` data.
   */
  @Process('digest')
  async handleDigest(job: Job<DigestEmailPayload, void>): Promise<void> {
    this.logger.log(
      `Sending digest email to ${job.data.email} with ${job.data.items.length} items`,
    )
    // In production, call an email service here
  }

  /**
   * Log failed jobs for observability.
   *
   * @param job - The failed job (may be undefined if the job was lost).
   * @param err - The error that caused the failure.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.logger.error(`Email job ${job?.id ?? 'unknown'} failed: ${err.message}`)
  }
}
