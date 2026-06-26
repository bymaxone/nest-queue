/**
 * @fileoverview Worker tuning options surfaced when registering a processor.
 * @layer server/interfaces
 */

/**
 * Tunables applied when registering a Worker (via decorator or programmatically).
 * Maps to the subset of BullMQ's worker options the library exposes through its
 * defaults.
 *
 * There is intentionally NO `sandboxed` boolean. BullMQ sandboxed processors are
 * created by passing a FILE PATH (not a class) to the Worker constructor, so they
 * run out-of-process and cannot use NestJS dependency injection. A toggle on a
 * DI-managed processor is therefore impossible — sandboxed work uses a separate
 * registration path (`WorkerRegistry.registerSandboxed`).
 *
 * @example
 * const options: WorkerOptions = { concurrency: 5, limiter: { max: 10, duration: 1000 } }
 */
export interface WorkerOptions {
  /** Maximum number of jobs processed concurrently. Default: 2. */
  concurrency?: number
  /** Rate limiter — at most `max` jobs per `duration` milliseconds. */
  limiter?: { max: number; duration: number }
  /** Start the worker automatically on registration. Default: true. */
  autorun?: boolean
  /** Lock duration for active jobs, in milliseconds. Default: 30_000. */
  lockDuration?: number
  /** Interval between stalled-job checks, in milliseconds. Default: 30_000. */
  stalledInterval?: number
}
