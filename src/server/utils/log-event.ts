/**
 * @fileoverview The operational log events of the library. Every one is an object message handed to
 * the plain Nest `Logger`: `{ event, message, ...fields }`, so a logger that writes objects as
 * fields (`@bymax-one/nest-logger`) keeps them as data and Nest's default console logger still
 * prints them readably. `message` holds the library's own text, and the error that caused an event
 * travels as its own value under `err`.
 * @layer server/utils
 */

import type { Logger } from '@nestjs/common'
import { isGuardRefusal } from '../connection/prototype-guard'

/** The logger methods the library writes through. */
type EventLogger = Pick<Logger, 'log' | 'warn' | 'error'>

/** Every code a log event of the library carries, in the order the README lists them. */
export const QUEUE_LOG_EVENTS = {
  /** The module finished closing its queues, flow producer and connection. */
  SHUTDOWN_COMPLETE: 'QUEUE_SHUTDOWN_COMPLETE',
  /** A worker did not drain within the shutdown budget and was stopped. */
  WORKER_DRAIN_TIMEOUT: 'QUEUE_WORKER_DRAIN_TIMEOUT',
  /** A worker failed to close and was stopped. */
  WORKER_CLOSE_FAILED: 'QUEUE_WORKER_CLOSE_FAILED',
  /** What a sandboxed job of this worker produces after the shutdown is not dropped. */
  SANDBOX_SHUTDOWN_UNGUARDED: 'QUEUE_SANDBOX_SHUTDOWN_UNGUARDED',
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
  /** The prototype guard refused where the library could not throw, so it failed closed. */
  GUARD_REFUSED: 'QUEUE_GUARD_REFUSED',
  /** The guard refused before a job ran, so the job went back to the delayed set. */
  JOB_DEFERRED_GUARD_REFUSED: 'QUEUE_JOB_DEFERRED_GUARD_REFUSED',
  /** An attempt of a job failed. */
  JOB_FAILED: 'QUEUE_JOB_FAILED',
} as const

/** A code of {@link QUEUE_LOG_EVENTS}. */
export type QueueLogEvent = (typeof QUEUE_LOG_EVENTS)[keyof typeof QUEUE_LOG_EVENTS]

/** One log event: its code, the text, and its fields. */
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
 * @param fields - Closed or numeric values, queue names, and for a failed job its name and id;
 * never a payload or the text of an error.
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
  fields: Readonly<Record<string, string | number | boolean>>,
): QueueLogMessage {
  return { event, message, ...fields, err }
}

/**
 * Hand a log event to the logger, and absorb a throw of that logger. A host may replace Nest's
 * logger with `app.useLogger`, and a logger of its own can throw; the throw would escape from the
 * library code that reports a fault: a listener of an `error` event, a shutdown step, a failure
 * path. A promise the host logger returns is out of reach: Nest's `Logger` does not return it, so
 * the rejection of an asynchronous transport is dropped, becomes an unhandled rejection and ends
 * the process with exit code 1 unless the application handles `unhandledRejection`.
 *
 * @param logger - The logger of the class that reports the event.
 * @param level - How serious the event is.
 * @param message - The event, built with {@link logEvent} or {@link logFailure}.
 */
export function writeLog(
  logger: EventLogger,
  level: 'log' | 'warn' | 'error',
  message: QueueLogMessage,
): void {
  try {
    logger[level](message)
  } catch {
    // A logger that throws must not fail the code that was reporting something else.
  }
}

/**
 * Report a refusal of the prototype guard where the code cannot throw it (a health check, a
 * teardown) and fails closed instead, as loudly as the outage that would otherwise be reported. Any
 * other error is left to its own handler.
 *
 * @param logger - Where the refusal is written.
 * @param err - What was caught.
 * @param site - Which path failed closed.
 */
export function reportRefusal(logger: EventLogger, err: unknown, site: string): void {
  if (!isGuardRefusal(err)) return
  writeLog(
    logger,
    'error',
    logFailure(QUEUE_LOG_EVENTS.GUARD_REFUSED, 'The prototype guard refused; failed closed', err, {
      site,
    }),
  )
}

/** How long after a line the next one of the same worker waits. */
const REPORT_INTERVAL_MS = 60_000

// Taken when the module is loaded: the report runs while the guard is refusing. The clock is
// monotonic, so a change of the wall clock does not silence the line.
const monotonic = performance.now.bind(performance)

/**
 * Build the report of one worker's deferred jobs. The first deferred job is logged at once; the ones
 * deferred in the minute after a line are counted and carried by the line of the first job deferred
 * after that minute. No timer is armed, so the count of a last burst is not
 * written.
 *
 * @param logger - Where the line is written.
 * @param queue - The queue of the worker.
 * @param now - The clock, in milliseconds.
 * @returns Call it once for each job moved to the delayed set.
 * @example
 * const deferred = deferredJobReport(logger, 'email')
 * deferred()
 */
export function deferredJobReport(
  logger: Pick<Logger, 'log' | 'warn' | 'error'>,
  queue: string,
  now: () => number = monotonic,
): () => void {
  let deferred = 0
  let reportedAt = -Infinity
  return () => {
    deferred += 1
    const at = now()
    if (at - reportedAt < REPORT_INTERVAL_MS) return
    writeLog(
      logger,
      'warn',
      logEvent(
        QUEUE_LOG_EVENTS.JOB_DEFERRED_GUARD_REFUSED,
        'The prototype guard refused before a job ran; it went back to the delayed set',
        { queue, deferred },
      ),
    )
    reportedAt = at
    deferred = 0
  }
}
