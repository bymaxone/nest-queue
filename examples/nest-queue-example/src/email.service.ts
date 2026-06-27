/**
 * @fileoverview Email service — enqueues email jobs and registers a digest job scheduler.
 * Demonstrates enqueue, Job Schedulers, and flow usage via the QueueService and FlowService.
 * @layer application
 */

import { Injectable, type OnModuleInit, Logger } from '@nestjs/common'
import { QueueService, FlowService } from '@bymax-one/nest-queue'
import type { JobNode } from '@bymax-one/nest-queue'
import type { WelcomeEmailPayload, DigestEmailPayload } from './email.processor.js'

/**
 * Provides email-sending operations backed by BullMQ queues.
 * Registers a daily digest Job Scheduler on startup.
 *
 * @example
 * ```typescript
 * await emailService.sendWelcome('user@example.com', 'Alice')
 * ```
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name)

  constructor(
    private readonly queue: QueueService,
    private readonly flows: FlowService,
  ) {}

  /**
   * Register the daily digest Job Scheduler when the module initialises.
   * Uses `upsertJobScheduler` so restarts are idempotent.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'email',
      'daily-digest',
      { pattern: '0 9 * * *' },
      {
        name: 'digest',
        data: { email: 'digest-list@example.com', items: [] } satisfies DigestEmailPayload,
      },
    )
    this.logger.log('Daily digest Job Scheduler registered')
  }

  /**
   * Enqueue a welcome email for a new user.
   *
   * @param email - The recipient's email address.
   * @param name - The recipient's display name.
   */
  async sendWelcome(email: string, name: string): Promise<void> {
    await this.queue.enqueue<WelcomeEmailPayload, void>('email', 'welcome', { email, name })
  }

  /**
   * Enqueue an order-confirmation flow — charges payment and sends a confirmation
   * in a single parent-child flow job, processed atomically.
   *
   * @param orderId - The order identifier.
   * @param email - The buyer's email address.
   * @returns The root job node of the flow.
   */
  async processOrder(orderId: string, email: string): Promise<JobNode> {
    return this.flows.add({
      name: 'process-order',
      queueName: 'orders',
      data: { orderId },
      children: [
        {
          name: 'charge-payment',
          queueName: 'payments',
          data: { orderId },
        },
        {
          name: 'welcome',
          queueName: 'email',
          data: { email, name: 'Customer' } satisfies WelcomeEmailPayload,
        },
      ],
    })
  }
}
