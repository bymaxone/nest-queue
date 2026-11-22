/**
 * @fileoverview The own values a job's options carry while its handler runs. BullMQ rebuilds `job.opts`
 * as an ordinary object from the stored JSON and, once the handler settles, reads `removeOnComplete`,
 * `removeOnFail`, `attempts`, `backoff` and others off it by property access. A name the producer did
 * not set is then looked up on `Object.prototype`, so a key planted while the handler ran would delete a
 * job another producer enqueued. An own `undefined` for every name is what an absent option is to
 * BullMQ, and it stops the lookup.
 * @layer server/utils
 */

import { JOB_OPTION_KEYS } from '../config/snapshot-options'

/**
 * Give `job.opts` an own, non-enumerable `undefined` for every job option it does not hold itself.
 * Must run in the same turn as a passing guard, which has just checked the built-ins it calls.
 *
 * @param job - The job BullMQ handed the processor.
 */
export function shadowJobOptions(job: { opts?: object }): void {
  const options = job.opts
  if (options === undefined) return
  // The guard that runs just before has checked the array iterator and these built-ins.
  for (const key of JOB_OPTION_KEYS) {
    if (!Object.hasOwn(options, key)) {
      Object.defineProperty(options, key, {
        value: undefined,
        enumerable: false,
        writable: true,
        configurable: true,
      })
    }
  }
}
