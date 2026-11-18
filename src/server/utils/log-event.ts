/**
 * @fileoverview The operational log events of the library. Every one is an object message handed to
 * the plain Nest `Logger`: `{ event, message, ...fields }`, with fields of closed or numeric values
 * only, so a logger that writes objects as fields (`@bymax-one/nest-logger`) keeps them as data and
 * Nest's default console logger still prints them readably. The text a host's logs already carried
 * stays word for word inside `message`.
 * @layer server/utils
 */

/** Every code a log event of the library carries, in the order the README lists them. */
export const QUEUE_LOG_EVENTS = {
  /** The module finished closing its queues, flow producer and connection. */
  SHUTDOWN_COMPLETE: 'QUEUE_SHUTDOWN_COMPLETE',
  /** A worker did not drain within the shutdown budget and was stopped. */
  WORKER_DRAIN_TIMEOUT: 'QUEUE_WORKER_DRAIN_TIMEOUT',
  /** A worker failed to close and was stopped. */
  WORKER_CLOSE_FAILED: 'QUEUE_WORKER_CLOSE_FAILED',
  /** A queue could not be drained on shutdown. */
  QUEUE_DRAIN_FAILED: 'QUEUE_DRAIN_FAILED',
  /** A Redis connection the module uses emitted an error. */
  CLIENT_ERROR: 'QUEUE_CLIENT_ERROR',
  /** A Queue, Worker, QueueEvents or FlowProducer emitted an error. */
  EMITTER_ERROR: 'QUEUE_EMITTER_ERROR',
  /** An `@OnWorkerEvent` or `@OnQueueEvent` handler threw or rejected. */
  EVENT_HANDLER_FAILED: 'QUEUE_EVENT_HANDLER_FAILED',
  /** A processor registered without a concurrency got the default. */
  CONCURRENCY_DEFAULTED: 'QUEUE_CONCURRENCY_DEFAULTED',
  /** An observer threw from the hook that reports how an attempt ended. */
  OBSERVER_FAILED: 'QUEUE_OBSERVER_FAILED',
  /** The shared client keeps commands queued for as long as an outage lasts. */
  UNBOUNDED_RETRIES: 'QUEUE_UNBOUNDED_RETRIES',
} as const

/** A code of {@link QUEUE_LOG_EVENTS}. */
export type QueueLogEvent = (typeof QUEUE_LOG_EVENTS)[keyof typeof QUEUE_LOG_EVENTS]

/** One log event: its code, the text, and fields of closed or numeric values. */
export interface QueueLogMessage {
  /** The code of the event. */
  readonly event: QueueLogEvent
  /** The text a log reader sees. */
  readonly message: string
  /** The error that caused the event, as the value itself and never as text in `message`. */
  readonly err?: unknown
  /** Closed or numeric fields of the event. */
  readonly [field: string]: unknown
}

/**
 * Build a log event.
 *
 * @param event - The code of the event.
 * @param message - The text.
 * @param fields - Fields of closed or numeric values; never a value the host supplied.
 */
export function logEvent(
  event: QueueLogEvent,
  message: string,
  fields: Readonly<Record<string, string | number | boolean>> = {},
): QueueLogMessage {
  return { event, message, ...fields }
}

/**
 * Build the log event of a failure. The error is carried as the value itself, under `err`, where a
 * logger that knows errors serialises and redacts it; it is never put in `message`, which holds the
 * library's own text only, because the text of an error can hold anything the failing code did.
 *
 * @param event - The code of the event.
 * @param message - The text, with nothing of the error in it.
 * @param err - What was thrown or emitted.
 * @param fields - Fields of closed or numeric values; never a value the host supplied.
 */
export function logFailure(
  event: QueueLogEvent,
  message: string,
  err: unknown,
  fields: Readonly<Record<string, string | number | boolean>> = {},
): QueueLogMessage {
  return { event, message, ...fields, err }
}
