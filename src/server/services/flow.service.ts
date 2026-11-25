/**
 * @fileoverview FlowService — a guarded wrapper over the BullMQ `FlowProducer`
 * for hierarchical (parent/child) job graphs. Opt-in: the provider is always
 * registered so injecting it never fails, but every method throws
 * `FLOW_DISABLED` (503) unless `flows.enabled` was set.
 * @layer server/services
 */

import { assertPrototypeClean } from '../connection/prototype-guard'
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FlowProducer, type FlowJob, type JobNode, type Telemetry } from 'bullmq'
import type { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { attachDefaultErrorListener } from '../utils/attach-error-listener'
import { timeoutException, withCommandTimeoutCode } from '../utils/command-timeout'
import { withDeadline } from '../utils/with-deadline'
import type { QueueObserverRegistry } from '../observability/queue-observer'
import { stampFlow } from '../observability/trace-carrier'
import { assertFlowTree } from '../utils/assert-job-inputs'
import { batchTimeout, runFlowBulk } from '../utils/add-flow-trees'
import {
  DEFAULT_ENQUEUE_TIMEOUT_MS,
  MAX_BULK_SIZE,
  MAX_FLOW_TREES_IN_FLIGHT,
} from '../constants/default-options'
import { own } from '../utils/bounded-wait'

/**
 * Wrapper over the BullMQ `FlowProducer` for hierarchical (parent/child) job
 * graphs. The producer runs on the main connection (Mode A received client or
 * Mode B library-owned client) and is created only when flows are enabled.
 *
 * Opt-in: this provider is registered unconditionally so that injecting it never
 * raises `UnknownDependenciesException`; instead, every operation throws
 * `QueueException(FLOW_DISABLED, HttpStatus.SERVICE_UNAVAILABLE)` when `flows.enabled !== true`.
 *
 * @example
 * await flowService.add({
 *   name: 'generate-pdf',
 *   queueName: 'pdf',
 *   data: { reportId: '123' },
 *   children: [{ name: 'fetch-data', queueName: 'data', data: { reportId: '123' } }],
 * })
 */
@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name)
  private readonly producer?: FlowProducer
  readonly #connection: ConnectionResolver
  readonly #deadlineMs: number
  readonly #observers: QueueObserverRegistry | undefined
  readonly #telemetry: boolean

  constructor(
    connection: ConnectionResolver,
    enabled: boolean,
    prefix: string,
    telemetry?: Telemetry,
    enqueueTimeoutMs: number = DEFAULT_ENQUEUE_TIMEOUT_MS,
    observers?: QueueObserverRegistry,
  ) {
    this.#connection = connection
    this.#observers = observers
    this.#telemetry = telemetry !== undefined
    this.#deadlineMs = enqueueTimeoutMs
    if (enabled) {
      this.producer = new FlowProducer({
        connection: connection.getClient(),
        // Match the producer Queue's key prefix so flow jobs land in the same
        // keyspace the workers poll; a non-default prefix breaks flows otherwise.
        prefix,
        ...(telemetry ? { telemetry } : {}),
      })
      attachDefaultErrorListener(this.producer, this.logger, 'FlowProducer', '*')
    }
  }

  /**
   * Add a flow tree (a parent with its descendant children). The root job
   * becomes processable only after every descendant has completed.
   *
   * By BullMQ default a failed (retry-exhausted) child does NOT fail its parent:
   * the parent stays in the `waiting-children` state until the child eventually
   * completes. To make a child's failure propagate upward and fail its parent,
   * set `failParentOnFailure: true` on that child (it cascades when ancestors
   * also set it). To let a parent proceed despite a failed child, set
   * `ignoreDependencyOnFailure: true` on that child. Bound each child's
   * `attempts` so an unrecoverable child cannot leave the parent waiting forever.
   *
   * @param flow - Flow tree definition.
   * @returns The root `JobNode` containing the created job and its children.
   *   A job whose custom `jobId` already exists is not added again: its node carries the EXISTING
   *   id with the data of this call, so the tree does not describe what is stored; call
   *   `QueueService.getJob` when you need it.
   * @throws {QueueException} `FLOW_DISABLED` (503) when flows are not enabled; `CONNECTION_TIMEOUT`
   *   when Redis does not answer within `enqueueTimeoutMs` (the flow may still have been added).
   */
  async add(flow: FlowJob): Promise<JobNode> {
    assertPrototypeClean()
    const producer = this.requireProducer()
    const checked = assertFlowTree(flow, 'flow')
    return this.bounded('addFlow', this.addTree(producer, checked))
  }

  /**
   * Add multiple flow trees, one BullMQ `add` per tree with at most 50 in flight, so that a tree
   * that fails is reported instead of being skipped: BullMQ's own bulk call resolves with ids of
   * trees Redis refused. After the first failure no further tree is started.
   *
   * @param flows - Flow tree definitions.
   * @returns The root `JobNode` for each flow, in input order.
   *   A job whose custom `jobId` already exists is not added again; see {@link FlowService.add}.
   * @throws {QueueException} `FLOW_DISABLED` (503) when flows are not enabled;
   *   `INVALID_JOB_ID` (400) for a reserved `jobId`; `BULK_ENQUEUE_FAILED` (400) for more than 1000
   *   flows. When a tree fails, `STORAGE_FULL` (503) if Redis is out of memory, `CONNECTION_TIMEOUT`
   *   (503) for a timeout or a down connection, otherwise `BULK_ENQUEUE_FAILED` (500), with
   *   `details: { operation, landed, failed, notStarted, unknown }`, each an array of indexes into
   *   `flows`. `landed` was stored; `failed` was rejected, because Redis refused it or the connection was down, and may have left child jobs behind;
   *   `notStarted` was never sent and is safe to resend; `unknown` was in flight when the deadline
   *   passed, or its command timed out, and may still land, so resend it only with a stable `jobId`.
   */
  async addBulk(flows: readonly FlowJob[]): Promise<JobNode[]> {
    assertPrototypeClean()
    const producer = this.requireProducer()
    const checked = flows.map((flow, index) => assertFlowTree(flow, `flows[${String(index)}]`))
    if (flows.length > MAX_BULK_SIZE) {
      throw new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, HttpStatus.BAD_REQUEST, {
        reason: 'batch size exceeds limit',
        limit: MAX_BULK_SIZE,
        received: flows.length,
      })
    }
    // One `add` per tree, not `FlowProducer.addBulk`: that reads each tree's result as `[err, id]` and
    // skips a failed one, so a bulk Redis refused resolves with ids of jobs that were never stored.
    const run = runFlowBulk(
      checked,
      (flow) =>
        withCommandTimeoutCode(
          'addFlowBulk',
          () => this.commandTimeout(),
          this.addTree(producer, flow),
        ),
      'addFlowBulk',
      MAX_FLOW_TREES_IN_FLIGHT,
    )
    return withDeadline(run.done, this.#deadlineMs, () =>
      batchTimeout('addFlowBulk', this.#deadlineMs, run),
    )
  }

  /**
   * Add one tree inside the observers' enqueue span, storing the trace headers they write with every
   * node, unless BullMQ's own telemetry is configured, which stores its own.
   */
  private addTree(producer: FlowProducer, flow: FlowJob): Promise<JobNode> {
    // The guard runs in the turn of each BullMQ `add`, after the observers' hooks and between the trees
    // of a bulk, as `QueueService.call` does for its calls.
    const add = (): Promise<JobNode> => {
      assertPrototypeClean()
      return producer.add(flow)
    }
    if (this.#observers === undefined) return add()
    return this.#observers.traceEnqueue({ queue: flow.queueName, job: flow.name }, (carrier) => {
      if (!this.#telemetry) stampFlow(flow, carrier)
      return add()
    })
  }

  /**
   * Hold the caller to `enqueueTimeoutMs`, and report a command timeout or a down connection as
   * `CONNECTION_TIMEOUT`. A call that timed out may still have been added: BullMQ is not asked to
   * cancel it.
   */
  private bounded<T>(operation: string, work: Promise<T>): Promise<T> {
    return withCommandTimeoutCode(
      operation,
      () => this.commandTimeout(),
      withDeadline(work, this.#deadlineMs, () => timeoutException(operation, this.#deadlineMs)),
    )
  }

  /** The command deadline of the producer connection, read when a command has timed out. */
  private commandTimeout(): number {
    return this.#connection.getClient().options.commandTimeout ?? 0
  }

  /**
   * Escape hatch returning the underlying `FlowProducer` for advanced use cases.
   * Prefer {@link FlowService.add} / {@link FlowService.addBulk} when possible.
   *
   * @returns The underlying BullMQ `FlowProducer`.
   * @throws {QueueException} `FLOW_DISABLED` (503) when flows are not enabled.
   */
  getProducer(): FlowProducer {
    return this.requireProducer()
  }

  /**
   * Close the producer when active; a no-op when inactive. A failed `close()` is
   * swallowed so it never aborts the shutdown sequence.
   *
   * Deliberately NOT named `onModuleDestroy`: NestJS invokes lifecycle hooks by
   * method name, so a hook here would run in addition to the call the ordered
   * sequence already makes, closing the producer twice. `QueueLifecycle` is the
   * only caller.
   */
  async close(): Promise<void> {
    try {
      // Stryker disable next-line OptionalChaining: equivalent — with no producer, `this.producer.close()` throws a TypeError into the catch below, which swallows it
      await own(this.producer?.close())
    } catch {
      // A producer that fails to close is gone either way.
    }
  }

  /**
   * Return the active producer or throw when flows are disabled. The producer is
   * present if and only if flows were enabled at construction time.
   *
   * @throws {QueueException} `FLOW_DISABLED` (503) when no producer exists.
   */
  private requireProducer(): FlowProducer {
    if (!this.producer) {
      throw new QueueException(QUEUE_ERROR_CODES.FLOW_DISABLED, HttpStatus.SERVICE_UNAVAILABLE)
    }
    return this.producer
  }
}
