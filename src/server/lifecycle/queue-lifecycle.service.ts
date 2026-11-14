/**
 * @fileoverview `QueueLifecycle` — the single, ordered graceful-shutdown
 * orchestrator, split across the two NestJS hooks that bracket the HTTP server.
 * On `onModuleDestroy` it stops consumption: it drains every worker within a
 * bounded budget, then closes queue-events and the connections the library
 * opened for them. On `onApplicationShutdown`, which NestJS runs only after the
 * HTTP server has stopped, it releases what a request can still be using: the
 * flow producer, the cached queues, and finally the Queue-role connection.
 *
 * Delivery is at-least-once: when a worker exceeds the drain budget it is stopped
 * without waiting for its job, whose lock then expires so the job becomes `stalled`
 * and is retried by another worker. Handlers must therefore be idempotent, and `lockDuration` should
 * comfortably exceed the worst-case handler runtime so healthy long jobs are
 * never treated as stalled.
 * @layer server/lifecycle
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { describeError } from '../utils/describe-error'
import { withDeadline } from '../utils/with-deadline'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { ConnectionResolver } from '../services/connection-resolver.service'
import { FlowService } from '../services/flow.service'
import { QueueService } from '../services/queue.service'
import { WorkerRegistry } from '../services/worker-registry.service'
import { QueueEventsRegistry } from '../services/queue-events-registry.service'

/** How long a worker's forced close may take, in milliseconds, once the drain budget has ended. */
const FORCE_CLOSE_GRACE_MS = 1000

/** The rejection of a graceful worker close that ran out of the drain budget. */
class DrainTimeoutError extends Error {}

/**
 * Ordered graceful-shutdown service. Implementing the protocol in one place
 * guarantees the teardown order — workers drain first, then queue-events, then
 * the duplicated connections; once the HTTP server has stopped, the flow
 * producer, the queues, and finally the Queue-role connection. Every step
 * swallows its own errors so a single failure never aborts the rest of the
 * sequence.
 *
 * Why two hooks: NestJS runs `onModuleDestroy` before it stops the HTTP server,
 * so a request that is still being served can enqueue a job after that hook has
 * returned. The producer side (queues, flow producer, Queue-role connection)
 * therefore waits for `onApplicationShutdown`, while consumption stops early.
 *
 * Connection ownership: in **Mode B** the library-owned Queue-role client is
 * quit by the connection resolver; in **Mode A** that step is a no-op and only
 * the duplicated worker/queue-events connections the library created are closed
 * — the consumer's shared client is never touched.
 */
@Injectable()
export class QueueLifecycle implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(QueueLifecycle.name)
  private startedAt: number | undefined
  private forcedWorkers = 0

  constructor(
    @Inject(WorkerRegistry) private readonly workers: WorkerRegistry,
    @Inject(QueueEventsRegistry) private readonly events: QueueEventsRegistry,
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(ConnectionResolver) private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly resolved: ResolvedQueueOptions,
  ) {}

  /**
   * Stop consumption: drain the workers within the bounded budget, then close
   * queue-events and the connections the library opened for them. Called by
   * NestJS when the application context closes (e.g. on `SIGTERM` with shutdown
   * hooks enabled), before the HTTP server stops.
   */
  async onModuleDestroy(): Promise<void> {
    this.startedAt = Date.now()
    // One budget for the whole consumption side: every step below gets what is left of it, so the
    // time a stuck worker costs is the drain budget once, not once per worker and again per step.
    const deadline = this.startedAt + this.resolved.shutdown.drainTimeoutMs
    this.forcedWorkers = await this.closeWorkers(deadline)
    await this.closeQueueEvents(deadline)
    await this.closeDuplicatedConnections(deadline)
  }

  /**
   * Release the producer side once the HTTP server has stopped: the optional
   * queue drain, the flow producer, the cached queues, and the Queue-role
   * connection, then log the total shutdown time.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.drainQueuesIfRequested()
    await this.closeFlowProducer()
    await this.closeQueues()
    await this.teardownConnection()
    this.logger.log(
      `Queue shutdown complete in ${String(Date.now() - (this.startedAt ?? Date.now()))}ms ` +
        `(${String(this.forcedWorkers)} worker(s) stopped without draining)`,
    )
  }

  /**
   * Stop every worker in parallel, each bounded by what is left of the shutdown budget. A worker
   * is paused first (it stops fetching and waits for its active jobs) and then closed. One that is
   * still busy when the budget ends is closed with `close(true)`: because `pause` does not start a
   * close, that is the worker's FIRST close, so it does not wait for the job and stops the lock
   * renewal that would otherwise keep running and keep the process alive. The job's lock then
   * expires, and it stalls and is retried elsewhere. Returns how many workers were stopped
   * without draining.
   *
   * @param deadline - The epoch millisecond at which the shutdown budget ends.
   * @returns The count of workers stopped without draining.
   */
  private async closeWorkers(deadline: number): Promise<number> {
    let undrained = 0
    await Promise.all(
      Array.from(this.workers.getAll(), async ([name, worker]) => {
        try {
          await bounded(
            worker.pause().then(() => worker.close()),
            deadline,
          )
        } catch (cause) {
          undrained++
          const stopped =
            'it is stopped without waiting for its in-flight job, which becomes stalled and is retried'
          this.logger.warn(
            cause instanceof DrainTimeoutError
              ? `Worker "${name}" exceeded the ${String(this.resolved.shutdown.drainTimeoutMs)}ms drain budget ` +
                  `(${QUEUE_ERROR_CODES.SHUTDOWN_TIMEOUT_EXCEEDED}); ${stopped}`
              : `Worker "${name}" failed to close gracefully (${describeError(cause)}); ${stopped}`,
          )
          // Bounded: a close that never settles must not hold the rest of the teardown.
          // Stryker disable next-line ArrowFunction: equivalent — the deadline error is swallowed by the catch below, so no caller can observe its value
          const deadlineError = (): DrainTimeoutError => new DrainTimeoutError()
          await withDeadline(worker.close(true), FORCE_CLOSE_GRACE_MS, deadlineError).catch(
            () => undefined,
          )
        }
      }),
    )
    return undrained
  }

  /** Close every cached `QueueEvents` in parallel within the budget, swallowing failures. */
  private async closeQueueEvents(deadline: number): Promise<void> {
    await Promise.all(
      Array.from(this.events.getAll().values(), async (queueEvents) => {
        await bounded(queueEvents.close(), deadline).catch(() => undefined)
      }),
    )
  }

  /**
   * Close the duplicated worker/queue-events connections the library opened, in parallel. BullMQ
   * treats a passed-in client as shared and never closes it, so the library must release these
   * explicitly. A connection that does not quit within the budget is disconnected, which also
   * releases anything still blocked on it. In Mode A the consumer's shared client is never among
   * them.
   */
  private async closeDuplicatedConnections(deadline: number): Promise<void> {
    const connections = [
      ...this.workers.getConnections().values(),
      ...this.events.getConnections().values(),
    ]
    await Promise.all(
      connections.map(async (connection) => {
        await bounded(connection.quit(), deadline).catch(() => {
          connection.disconnect()
        })
      }),
    )
  }

  /**
   * Drain every cached queue when `drainOnShutdown` is enabled (dev/test only).
   * Removes waiting jobs and leaves delayed and active ones; off by default to stay production-safe.
   */
  private async drainQueuesIfRequested(): Promise<void> {
    if (!this.resolved.shutdown.drainOnShutdown) return
    for (const [name, queue] of this.queues.getCachedQueues()) {
      await queue.drain().catch((cause: unknown) => {
        this.logger.warn(
          `Queue "${name}" could not be drained on shutdown (drainOnShutdown): ` +
            `${describeError(cause)}; its waiting jobs remain`,
        )
      })
    }
  }

  /** Close the flow producer (idempotent), swallowing any failure. */
  private async closeFlowProducer(): Promise<void> {
    await this.flow.close().catch(() => undefined)
  }

  /** Close every cached queue and clear the cache, swallowing individual failures. */
  private async closeQueues(): Promise<void> {
    await this.queues.closeAll().catch(() => undefined)
  }

  /**
   * Tear down the Queue-role connection. Mode B quits the library-owned client;
   * Mode A is a no-op for the consumer's shared client.
   */
  private async teardownConnection(): Promise<void> {
    await this.connection.teardown().catch(() => undefined)
  }
}

/**
 * Wait for `work` until the epoch millisecond `deadline`, then give up with a
 * {@link DrainTimeoutError}. `worker.close()` already drains active jobs and takes no timeout
 * argument, so a timer is the only way to bound it. The work itself is not cancelled.
 */
function bounded<T>(work: Promise<T>, deadline: number): Promise<T> {
  return withDeadline(work, Math.max(0, deadline - Date.now()), () => new DrainTimeoutError())
}
