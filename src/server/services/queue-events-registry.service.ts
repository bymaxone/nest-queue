/**
 * @fileoverview `QueueEventsRegistry` — lazily creates and caches one BullMQ
 * `QueueEvents` instance per queue. A `QueueEvents` connection is opened only
 * when at least one `@OnQueueEvent` listener is registered for that queue,
 * avoiding unnecessary Redis connections. Each duplicated connection is tracked
 * so the shutdown orchestrator can close exactly what the library opened.
 * @layer server/services
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { QueueEvents } from 'bullmq'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { duplicateConnection } from '../utils/duplicate-connection'
import { attachDefaultErrorListener } from '../utils/attach-error-listener'

/**
 * Lazily creates and caches one BullMQ `QueueEvents` instance per queue.
 * The backing Redis connection uses `maxRetriesPerRequest: null` (via
 * `duplicateConnection`) because `QueueEvents` subscribes via blocking
 * `SUBSCRIBE` commands.
 *
 * A single `QueueEvents` is shared across all `@OnQueueEvent` listeners for
 * the same queue. Connections are opened on demand — only when
 * `getOrCreate(queueName)` is first called for a given queue. Shutdown is
 * orchestrated centrally by the queue lifecycle service, which closes each
 * `QueueEvents` and then releases the duplicated connection exposed here.
 *
 * @example
 * const qe = registry.getOrCreate('email')
 * qe.on('completed', ({ jobId }) => console.log(jobId))
 */
@Injectable()
export class QueueEventsRegistry {
  private readonly logger = new Logger(QueueEventsRegistry.name)
  readonly #events = new Map<string, QueueEvents>()
  readonly #connections = new Map<string, Redis>()

  constructor(
    @Inject(ConnectionResolver) private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly options: ResolvedQueueOptions,
  ) {}

  /**
   * Returns the cached `QueueEvents` for `queueName`, creating one on first
   * call. Subsequent calls for the same name return the same instance without
   * opening a second Redis connection.
   *
   * @param queueName - The BullMQ queue to observe.
   * @returns The `QueueEvents` instance for the queue.
   */
  getOrCreate(queueName: string): QueueEvents {
    const existing = this.#events.get(queueName)
    if (existing) return existing
    const conn = duplicateConnection(this.connection.getClient())
    let qe: QueueEvents
    try {
      qe = new QueueEvents(queueName, { connection: conn, prefix: this.options.prefix })
    } catch (err) {
      // Disconnect the duplicated connection to prevent a Redis resource leak.
      conn.disconnect()
      throw err
    }
    attachDefaultErrorListener(qe, this.logger, 'QueueEvents', queueName)
    this.#events.set(queueName, qe)
    this.#connections.set(queueName, conn)
    return qe
  }

  /**
   * Returns the queue names for which a `QueueEvents` connection is open.
   *
   * @returns An immutable array of queue names.
   */
  list(): readonly string[] {
    return Array.from(this.#events.keys())
  }

  /**
   * Returns the live `QueueEvents` map. Intended for the shutdown orchestrator.
   *
   * @returns A read-only view of the internal map.
   */
  getAll(): ReadonlyMap<string, QueueEvents> {
    return this.#events
  }

  /**
   * Returns a read-only view of the duplicated connections the library opened
   * for its `QueueEvents`, keyed by queue name. Intended for the shutdown
   * orchestrator so it can close exactly the connections the library created
   * (Mode A never exposes the consumer's shared client here).
   *
   * Returns a copy. `ReadonlyMap` is a compile-time claim only — handing back the
   * live registry lets any consumer cast it away and delete a connection the
   * shutdown sequence is about to close. The allocation costs nothing on a path
   * that runs once per shutdown.
   *
   * @returns A read-only snapshot of queue name to duplicated connection.
   */
  getConnections(): ReadonlyMap<string, Redis> {
    return new Map(this.#connections)
  }
}
