/**
 * @fileoverview FlowService — a guarded wrapper over the BullMQ `FlowProducer`
 * for hierarchical (parent/child) job graphs. Opt-in: the provider is always
 * registered so injecting it never fails, but every method throws
 * `FLOW_DISABLED` (503) unless `flows.enabled` was set.
 * @layer server/services
 */

import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import { FlowProducer, type FlowJob, type JobNode } from 'bullmq'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Wrapper over the BullMQ `FlowProducer` for hierarchical (parent/child) job
 * graphs. The producer runs on the main connection (Mode A received client or
 * Mode B library-owned client) and is created only when flows are enabled.
 *
 * Opt-in: this provider is registered unconditionally so that injecting it never
 * raises `UnknownDependenciesException`; instead, every operation throws
 * `QueueException(FLOW_DISABLED, 503)` when `flows.enabled !== true`.
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
export class FlowService implements OnModuleDestroy {
  private readonly producer?: FlowProducer

  constructor(connection: ConnectionResolver, enabled: boolean) {
    if (enabled) {
      this.producer = new FlowProducer({ connection: connection.getClient() })
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
   * @throws {QueueException} `FLOW_DISABLED` (503) when flows are not enabled.
   */
  async add(flow: FlowJob): Promise<JobNode> {
    return this.requireProducer().add(flow)
  }

  /**
   * Add multiple flow trees in a single Redis roundtrip.
   *
   * @param flows - Flow tree definitions.
   * @returns The root `JobNode` for each flow, in input order.
   * @throws {QueueException} `FLOW_DISABLED` (503) when flows are not enabled.
   */
  async addBulk(flows: readonly FlowJob[]): Promise<JobNode[]> {
    return this.requireProducer().addBulk([...flows])
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
   * Close the producer on shutdown when active; a no-op when inactive. A failed
   * `close()` is swallowed so it never aborts the shutdown sequence.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.producer) {
      await this.producer.close().catch(() => undefined)
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
      throw new QueueException(QUEUE_ERROR_CODES.FLOW_DISABLED, 503)
    }
    return this.producer
  }
}
