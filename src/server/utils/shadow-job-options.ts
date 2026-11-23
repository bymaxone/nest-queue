/**
 * @fileoverview The own values a job's options carry while its handler runs. BullMQ rebuilds `job.opts`
 * as an ordinary object from the stored JSON and, once the handler settles, reads `removeOnComplete`,
 * `removeOnFail`, `attempts`, `backoff` and others off it by property access. A name the
 * producer did not set is then looked up on `Object.prototype`, so a key planted while the handler ran
 * would delete a job another producer enqueued. An own `undefined` for every name is what an absent
 * option is to BullMQ, and it stops the lookup. It runs on the built-ins as they were when this module
 * loaded, because it also runs for a job the guard refused.
 * @layer server/utils
 */

import { JOB_OPTION_KEYS } from '../config/snapshot-options'
import { at } from './at'

/** The built-ins this module runs on, taken when it loaded. */
const hasOwn = Object.hasOwn
const defineProperty = Object.defineProperty

/**
 * The descriptor every shadow is defined with. `defineProperty` reads `get` and `set` off a descriptor
 * through its prototype chain, so a literal would throw while either name is planted on
 * `Object.prototype`; one that has no prototype never meets them.
 */
const SHADOW_DESCRIPTOR = Object.assign(Object.create(null) as object, {
  value: undefined,
  enumerable: false,
  writable: true,
  configurable: true,
})

/**
 * The names BullMQ reads off `job.opts`: every job option, and `repeat`, which the type of the job
 * options does not list and which BullMQ reads for a scheduler job (where it is stored with the job, so
 * the shadow is a safeguard here). `debounce` is left out on purpose: BullMQ asks whether the job holds
 * it of its own.
 */
const SHADOWED_NAMES: readonly string[] = [...JOB_OPTION_KEYS, 'repeat']

/**
 * Give `job.opts` an own, non-enumerable `undefined` for every job option it does not hold itself.
 *
 * @param job - The job BullMQ handed the processor.
 */
export function shadowJobOptions(job: { opts?: object }): void {
  const options = job.opts
  if (options === undefined) return
  let position = 0
  while (position < SHADOWED_NAMES.length) {
    const key = at(SHADOWED_NAMES, position)
    if (!hasOwn(options, key)) {
      defineProperty(options, key, SHADOW_DESCRIPTOR)
    }
    position += 1
  }
}
