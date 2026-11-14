/**
 * @fileoverview Which workers the shutdown stopped without draining. Internal: not exported from
 * the package, so a host cannot silently drop a worker's results mid-run.
 * @layer server/utils
 */

const abandoned = new WeakSet<object>()

/**
 * Mark a worker the shutdown stopped while a job was still running. Whatever that job's handler
 * produces afterwards is dropped (see `WorkerRegistry.register`): the job's lock is gone and it is
 * retried elsewhere, and a result delivered late would let BullMQ's `pause` resume and reopen the
 * worker's blocking connection.
 *
 * @param worker - The BullMQ `Worker`.
 */
export function abandonWorker(worker: object): void {
  abandoned.add(worker)
}

/**
 * Whether the shutdown stopped `worker` without draining it.
 *
 * @param worker - The BullMQ `Worker`.
 */
export function isAbandoned(worker: object): boolean {
  return abandoned.has(worker)
}
