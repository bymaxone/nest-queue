/**
 * @fileoverview `QueueEventsRegistry` — lazily creates and caches one BullMQ
 * `QueueEvents` instance per queue. A `QueueEvents` connection is opened only
 * when at least one `@OnQueueEvent` listener is registered for that queue,
 * avoiding unnecessary Redis connections.
 * @layer server/services
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { QueueEvents } from 'bullmq'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'

/**
 * Lazily creates and caches one BullMQ `QueueEvents` instance per queue.
 * The backing Redis connection uses `maxRetriesPerRequest: null` (via
 * `duplicateConnection`) because `QueueEvents` subscribes via blocking
 * `SUBSCRIBE` commands.
 *
 * A single `QueueEvents` is shared across all `@OnQueueEvent` listeners for
 * the same queue. Connections are opened on demand — only when
 * `getOrCreate(queueName)` is first called for a given queue.
 *
 * @example
 * const qe = registry.getOrCreate('email')
 * qe.on('completed', ({ jobId }) => console.log(jobId))
 */
@Injectable()
export class QueueEventsRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(QueueEventsRegistry.name)
  private readonly events = new Map<string, QueueEvents>()

  constructor(private readonly connection: ConnectionResolver) {}

  /**
   * Returns the cached `QueueEvents` for `queueName`, creating one on first
   * call. Subsequent calls for the same name return the same instance without
   * opening a second Redis connection.
   *
   * @param queueName - The BullMQ queue to observe.
   * @returns The `QueueEvents` instance for the queue.
   */
  getOrCreate(queueName: string): QueueEvents {
    const existing = this.events.get(queueName)
    if (existing) return existing
    const conn = duplicateConnection(this.connection.getClient())
    let qe: QueueEvents
    try {
      qe = new QueueEvents(queueName, { connection: conn })
    } catch (err) {
      // Disconnect the duplicated connection to prevent a Redis resource leak.
      conn.disconnect()
      throw err
    }
    this.events.set(queueName, qe)
    return qe
  }

  /**
   * Returns the queue names for which a `QueueEvents` connection is open.
   *
   * @returns An immutable array of queue names.
   */
  list(): readonly string[] {
    return Array.from(this.events.keys())
  }

  /**
   * Returns the live `QueueEvents` map. Intended for the shutdown orchestrator.
   *
   * @returns A read-only view of the internal map.
   */
  getAll(): ReadonlyMap<string, QueueEvents> {
    return this.events
  }

  /**
   * Best-effort close of all `QueueEvents` connections. Failures are logged and
   * swallowed — the module must not throw during shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    const entries = Array.from(this.events.entries())
    await Promise.allSettled(
      entries.map(async ([queueName, qe]) => {
        try {
          await qe.close()
        } catch (err) {
          this.logger.error(
            `Failed to close QueueEvents for queue "${queueName}" during shutdown`,
            err instanceof Error ? err.stack : String(err),
          )
        }
      }),
    )
    this.events.clear()
  }
}
