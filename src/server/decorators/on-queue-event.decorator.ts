/**
 * @fileoverview `@OnQueueEvent` method decorator — binds a method as a global
 * queue-event listener. The handler is attached to a per-queue `QueueEvents`
 * instance (one extra Redis connection per queue, opened lazily) and receives
 * a **serialized** payload — only `jobId` and stringified fields such as
 * `returnvalue` (a string, not the actual return value) or `failedReason`.
 * To inspect the full `Job`, call `QueueService.getJob(jobId)`.
 * @layer server/decorators
 */

import 'reflect-metadata'
import type { QueueEventListenerMetadata } from '../interfaces/processor-metadata.interface'
import { QUEUE_EVENT_LISTENERS_METADATA_KEY } from './metadata-keys.constants'

/**
 * Union of BullMQ `QueueEvents` event names surfaced by this library. Listeners
 * registered with `@OnQueueEvent` receive a serialized event payload, NOT the
 * full `Job` instance.
 *
 * @see https://docs.bullmq.io/guide/workers/queueevents
 */
export type QueueEventName =
  | 'completed'
  | 'failed'
  | 'active'
  | 'progress'
  | 'stalled'
  | 'waiting'
  | 'delayed'
  | 'paused'
  | 'resumed'
  | 'cleaned'

/**
 * Marks a method as a global queue-event listener. The method is bound to a
 * lazily-created `QueueEvents` instance via `queueEvents.on(event, fn)` at
 * discovery time. A single `QueueEvents` connection is shared across all
 * `@OnQueueEvent` listeners for the same queue.
 *
 * The handler receives a **serialized** payload, e.g.:
 * - `completed` — `{ jobId: string, returnvalue: string, prev?: string }`
 * - `failed`    — `{ jobId: string, failedReason: string, prev?: string }`
 * - `active`    — `{ jobId: string, prev?: string }`
 * - `progress`  — `{ jobId: string, data: number | object }`
 * - `waiting`   — `{ jobId: string }`
 *
 * To retrieve the full job, call `QueueService.getJob(payload.jobId)`, which
 * may return `null` if the job was already evicted by `removeOnComplete`.
 *
 * Multiple `@OnQueueEvent` decorators on the same class accumulate without
 * overwriting each other.
 *
 * @param eventName - The queue event to listen for.
 *
 * @example
 * `@OnQueueEvent`('completed')
 * async onCompleted({ jobId, returnvalue }: { jobId: string; returnvalue: string }) {
 *   this.logger.log(`Job ${jobId} finished with result ${returnvalue}`)
 * }
 */
export function OnQueueEvent(eventName: QueueEventName): MethodDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    // getOwnMetadata prevents walking the prototype chain and mutating an ancestor's array.
    const existing = (Reflect.getOwnMetadata(
      QUEUE_EVENT_LISTENERS_METADATA_KEY,
      target.constructor,
    ) ?? []) as QueueEventListenerMetadata[]
    Reflect.defineMetadata(
      QUEUE_EVENT_LISTENERS_METADATA_KEY,
      [...existing, { eventName, methodKey: propertyKey }],
      target.constructor,
    )
  }
}
