/**
 * @fileoverview The one place that reaches into BullMQ's protected `processFn`. A sandboxed worker
 * is given a file, so BullMQ builds its processor itself and the registry has nothing to wrap
 * before construction. Internal: not exported from the package.
 * @layer server/utils
 */

import { isAbandoned } from './abandoned-workers'
import { NativePromise } from '../connection/prototype-guard'
import { own } from './bounded-wait'

/** The member of a sandboxed BullMQ `Worker` that runs one job in the child process or thread. */
interface SandboxRunner {
  processFn?: (...args: unknown[]) => Promise<unknown>
}

/**
 * Drop what a sandboxed job produces, a result or a failure, once the shutdown has stopped its
 * worker. The worker's connection is closed by then: BullMQ would retry the write of a late result
 * without ending, and would record a terminated thread's job as failed. A dropped outcome leaves the
 * job's lock to expire, so the job stalls and is run again.
 *
 * BullMQ assigns `processFn` in the `Worker` constructor and reads it again for every job, so it is
 * replaced right after construction.
 *
 * @param worker - The sandboxed BullMQ `Worker`, just constructed.
 * @returns `false` when the `Worker` has no such member and was left as it is.
 * @example
 * const worker = new Worker(queueName, processorFile, options)
 * const wrapped = dropSandboxOutcomeOnceAbandoned(worker)
 */
export function dropSandboxOutcomeOnceAbandoned(worker: object): boolean {
  const runner = worker as SandboxRunner
  const sandbox = runner.processFn
  if (sandbox === undefined) return false
  const relay = async (args: unknown[]): Promise<unknown> => {
    try {
      return await own(sandbox(...args))
    } finally {
      if (isAbandoned(worker)) await own(new NativePromise<never>(() => undefined))
    }
  }
  runner.processFn = (...args) => own(relay(args))
  return true
}
