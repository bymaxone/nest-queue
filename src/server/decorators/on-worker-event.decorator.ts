/**
 * @fileoverview `@OnWorkerEvent` method decorator — binds a method as a
 * worker-local event listener. The handler is attached directly to the BullMQ
 * `Worker` instance (no extra Redis connection) and receives the **full**
 * `Job` object, including `job.data`, `job.returnvalue`, `job.attemptsMade`,
 * and timing fields. Use `'progress'` to observe `job.updateProgress()`.
 * @layer server/decorators
 */

import 'reflect-metadata'
import type { QueueEventListenerMetadata } from '../interfaces/processor-metadata.interface'
import { WORKER_EVENT_LISTENERS_METADATA_KEY } from './metadata-keys.constants'

/**
 * Union of BullMQ `Worker` event names surfaced by this library. Handlers
 * registered with `@OnWorkerEvent` receive the **full** `Job` instance for
 * job-scoped events (completed, failed, active, progress) and scalars for
 * infrastructure events (stalled, closing, closed, error).
 *
 * @see https://docs.bullmq.io/guide/workers/worker-events
 */
export type WorkerEventName =
  | 'completed'
  | 'failed'
  | 'progress'
  | 'active'
  | 'stalled'
  | 'closing'
  | 'closed'
  | 'error'

/**
 * Marks a method as a worker-local event listener for the given event. The
 * method is bound to the BullMQ `Worker` via `worker.on(event, fn)` at
 * discovery time. Because worker-local events are emitted directly on the
 * `Worker` instance, **no extra Redis connection is opened**.
 *
 * Handler receives:
 * - `completed` — `(job: Job, returnValue: unknown, prev: string) => void`
 * - `failed`    — `(job: Job | undefined, error: Error, prev: string) => void`
 * - `progress`  — `(job: Job, progress: number | object) => void`
 * - `active`    — `(job: Job, prev: string) => void`
 * - `stalled`   — `(jobId: string, prev: string) => void`
 * - `error`     — `(error: Error) => void`
 * - `closing`   — `(msg: string) => void`
 * - `closed`    — `() => void`
 *
 * Multiple `@OnWorkerEvent` decorators on the same class accumulate without
 * overwriting each other.
 *
 * Delivery is at-least-once. A `'stalled'` job — for example after a shutdown
 * force-close or a lock expiry — is re-run by another worker: this is the
 * visible at-least-once path, so handlers must be idempotent. Set `lockDuration`
 * comfortably above the worst-case handler runtime to avoid false stalls.
 *
 * Dead-letter-queue pattern (`'failed'`): the library ships no DLQ service, but
 * the endorsed pattern is a `'failed'` listener that, once retries are exhausted
 * (`job.attemptsMade >= (job.opts.attempts ?? 1)`), re-enqueues the payload plus
 * failure metadata onto a `<queue>-dlq` queue via `QueueService.enqueue`. Use a
 * stable DLQ `jobId` (e.g. `dlq-${job.id}`) so a redelivered `'failed'` event is
 * idempotent and never double-inserts (a custom BullMQ job id must not contain `:`).
 *
 * @param eventName - The worker event to listen for.
 *
 * @example
 * `@OnWorkerEvent`('completed')
 * onCompleted(job: Job, returnValue: unknown) {
 *   this.logger.log(`Job ${job.id} done`, returnValue)
 * }
 */
export function OnWorkerEvent(eventName: WorkerEventName): MethodDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    // getOwnMetadata prevents walking the prototype chain and mutating an ancestor's array.
    const existing = (Reflect.getOwnMetadata(
      WORKER_EVENT_LISTENERS_METADATA_KEY,
      target.constructor,
    ) ?? []) as QueueEventListenerMetadata[]
    Reflect.defineMetadata(
      WORKER_EVENT_LISTENERS_METADATA_KEY,
      [...existing, { eventName, methodKey: propertyKey }],
      target.constructor,
    )
  }
}
