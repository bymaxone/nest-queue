/**
 * @fileoverview The listeners every worker the registry builds gets: the fallback `error` listener,
 * and the log line of a failed job, one warning for each attempt BullMQ reports as failed, naming
 * the job, with its name and id cut to a bound, and the class of its error. The payload, the error and its message stay out of that line,
 * because any of them can hold whatever the job was working on.
 * @layer server/utils
 */

import type { Logger } from '@nestjs/common'
import { attachDefaultErrorListener } from './attach-error-listener'
import { logEvent, QUEUE_LOG_EVENTS, writeLog } from './log-event'

/** The slice of a BullMQ `Worker` this helper needs. */
interface WorkerEmitter {
  on(event: 'error', listener: (err: unknown) => void): unknown
  on(event: 'failed', listener: (job: unknown, error: unknown) => void): unknown
}

/**
 * The name of the class `error` was built from, read off its prototype, so that nothing the value
 * itself holds is read: not its message, not its `name`, not a `constructor` of its own.
 */
function classOf(error: unknown): string {
  let name: unknown
  try {
    name = (Object.getPrototypeOf(error) as { constructor: { name: unknown } }).constructor.name
  } catch {
    // `null`, `undefined` and a value with no prototype have no class.
  }
  return typeof name === 'string' && name !== '' ? name : 'unknown'
}

/** The most characters of a job's name or id a line carries. */
const MAX_NAMED_LENGTH = 128

/**
 * `value` as the line carries it: without control characters or line breaks, and cut to
 * {@link MAX_NAMED_LENGTH} characters and an ellipsis when it is longer, never in the middle of a
 * surrogate pair.
 */
function fit(value: string): string {
  const long = value.length > MAX_NAMED_LENGTH
  const kept = long ? value.slice(0, MAX_NAMED_LENGTH).replace(/[\uD800-\uDBFF]$/, '') : value
  const oneLine = kept.replace(/[\p{Cc}\u2028\u2029]/gu, '')
  return long ? `${oneLine}…` : oneLine
}

/** The name, id and attempt of `job`; BullMQ's types allow `failed` to carry no job. */
function identify(job: unknown): Record<string, string | number> {
  const { name, id, attemptsMade } = (job ?? {}) as Record<string, unknown>
  return {
    ...(typeof name === 'string' && { jobName: fit(name) }),
    ...(typeof id === 'string' && { jobId: fit(id) }),
    ...(typeof attemptsMade === 'number' && { attempt: attemptsMade }),
  }
}

/**
 * Give a worker its fallback `error` listener, and log each failed attempt of its jobs as a
 * `QUEUE_JOB_FAILED` warning, one for each attempt and not one for each job. BullMQ decides what failed: it emits `failed` once it has moved the
 * job, and not for a job the processor handed back (a delay, a rate limit, a wait).
 *
 * @param worker - The worker to listen to.
 * @param logger - Where the lines are written.
 * @param queue - The queue of the worker.
 * @example
 * attachWorkerListeners(worker, this.logger, 'email')
 */
export function attachWorkerListeners(worker: WorkerEmitter, logger: Logger, queue: string): void {
  attachDefaultErrorListener(worker, logger, 'Worker', queue)
  worker.on('failed', (job, error) => {
    writeLog(
      logger,
      'warn',
      logEvent(QUEUE_LOG_EVENTS.JOB_FAILED, 'A job attempt failed', {
        queue,
        ...identify(job),
        errorClass: classOf(error),
      }),
    )
  })
}
