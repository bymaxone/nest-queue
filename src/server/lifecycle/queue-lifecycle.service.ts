/**
 * @fileoverview `QueueLifecycle` — the single, ordered graceful-shutdown
 * orchestrator. On `onModuleDestroy` it drains every worker within a bounded
 * budget, then tears down queue-events, the connections the library opened,
 * the flow producer, the cached queues, and finally the Queue-role connection.
 *
 * Delivery is at-least-once: when a worker exceeds the drain budget it is
 * force-closed and its in-flight job becomes `stalled` and is retried by another
 * worker. Handlers must therefore be idempotent, and `lockDuration` should
 * comfortably exceed the worst-case handler runtime so healthy long jobs are
 * never treated as stalled.
 * @layer server/lifecycle
 */

import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import type { Worker } from 'bullmq'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { ConnectionResolver } from '../services/connection-resolver.service'
import { FlowService } from '../services/flow.service'
import { QueueService } from '../services/queue.service'
import { WorkerRegistry } from '../services/worker-registry.service'
import { QueueEventsRegistry } from '../services/queue-events-registry.service'

/**
 * Ordered graceful-shutdown service. Implementing the protocol in one place
 * guarantees the teardown order — workers drain first, then queue-events, then
 * the duplicated connections, then the flow producer, the queues, and finally
 * the Queue-role connection. Every step swallows its own errors so a single
 * failure never aborts the rest of the sequence.
 *
 * Connection ownership: in **Mode B** the library-owned Queue-role client is
 * quit by the connection resolver; in **Mode A** that step is a no-op and only
 * the duplicated worker/queue-events connections the library created are closed
 * — the consumer's shared client is never touched.
 */
@Injectable()
export class QueueLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(QueueLifecycle.name)

  constructor(
    @Inject(WorkerRegistry) private readonly workers: WorkerRegistry,
    @Inject(QueueEventsRegistry) private readonly events: QueueEventsRegistry,
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(ConnectionResolver) private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly resolved: ResolvedQueueOptions,
  ) {}

  /**
   * Run the ordered shutdown sequence. Called by NestJS when the application
   * context closes (e.g. on `SIGTERM` with shutdown hooks enabled).
   */
  async onModuleDestroy(): Promise<void> {
    const start = Date.now()
    const forced = await this.closeWorkers()
    await this.closeQueueEvents()
    await this.closeDuplicatedConnections()
    await this.drainQueuesIfRequested()
    await this.closeFlowProducer()
    await this.closeQueues()
    await this.teardownConnection()
    this.logger.log(
      `Queue shutdown complete in ${String(Date.now() - start)}ms ` +
        `(forced ${String(forced)} worker(s))`,
    )
  }

  /**
   * Close every worker with a bounded drain, force-closing any that exceed the
   * budget. Returns the number of workers that had to be force-closed.
   *
   * @returns The count of force-closed workers.
   */
  private async closeWorkers(): Promise<number> {
    let forced = 0
    const drainTimeoutMs = this.resolved.shutdown.drainTimeoutMs
    for (const [name, worker] of this.workers.getAll()) {
      try {
        await this.closeWorkerWithTimeout(worker, drainTimeoutMs)
      } catch {
        forced++
        this.logger.warn(
          `Worker "${name}" exceeded the ${String(drainTimeoutMs)}ms drain budget — ` +
            `forcing close (${QUEUE_ERROR_CODES.SHUTDOWN_TIMEOUT_EXCEEDED}); ` +
            'the in-flight job becomes stalled and is retried',
        )
        // Best-effort force-close, never awaited: a genuinely stuck worker must
        // not block the remaining teardown steps. A rejection is swallowed.
        void worker.close(true).catch(() => undefined)
      }
    }
    return forced
  }

  /**
   * Race a graceful `worker.close()` against a timer. `worker.close()` already
   * drains active jobs and takes no timeout argument, so the timer is the only
   * way to bound the wait. Rejects with a timeout error when the budget elapses.
   *
   * @param worker - The worker to close.
   * @param timeoutMs - The drain budget in milliseconds.
   */
  private async closeWorkerWithTimeout(worker: Worker, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const closed = worker.close()
    // Keep the abandoned graceful close from surfacing as an unhandled rejection.
    closed.catch(() => undefined)
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('drain timeout'))
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Close every cached `QueueEvents`, swallowing individual failures. */
  private async closeQueueEvents(): Promise<void> {
    for (const [, queueEvents] of this.events.getAll()) {
      await queueEvents.close().catch(() => undefined)
    }
  }

  /**
   * Close the duplicated worker/queue-events connections the library opened.
   * BullMQ treats a passed-in client as shared and never closes it, so the
   * library must release these explicitly. In Mode A the consumer's shared
   * client is never among them.
   */
  private async closeDuplicatedConnections(): Promise<void> {
    const connections = [
      ...this.workers.getConnections().values(),
      ...this.events.getConnections().values(),
    ]
    for (const connection of connections) {
      try {
        await connection.quit()
      } catch {
        connection.disconnect()
      }
    }
  }

  /**
   * Drain every cached queue when `drainOnShutdown` is enabled (dev/test only).
   * Removes waiting and delayed jobs; off by default to stay production-safe.
   */
  private async drainQueuesIfRequested(): Promise<void> {
    if (!this.resolved.shutdown.drainOnShutdown) return
    for (const [, queue] of this.queues.getCachedQueues()) {
      await queue.drain().catch(() => undefined)
    }
  }

  /** Close the flow producer (idempotent), swallowing any failure. */
  private async closeFlowProducer(): Promise<void> {
    await this.flow.onModuleDestroy().catch(() => undefined)
  }

  /** Close every cached queue, swallowing individual failures. */
  private async closeQueues(): Promise<void> {
    for (const [, queue] of this.queues.getCachedQueues()) {
      await queue.close().catch(() => undefined)
    }
  }

  /**
   * Tear down the Queue-role connection. Mode B quits the library-owned client;
   * Mode A is a no-op for the consumer's shared client.
   */
  private async teardownConnection(): Promise<void> {
    await this.connection.onModuleDestroy().catch(() => undefined)
  }
}
