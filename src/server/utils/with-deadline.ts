/**
 * @fileoverview Bounds a promise by a deadline, through the bounded wait and not `Promise.race`.
 * @layer server/utils
 */

import { assertPrototypeClean } from '../connection/prototype-guard'
import { startWait } from './bounded-wait'

/**
 * Settle with `work`, or reject with `onTimeout()` once `timeoutMs` passes first. The timer is
 * cleared when the wait ends, and a rejection of `work` after the deadline is absorbed, so a late
 * failure never surfaces as an unhandled rejection. The work itself is not cancelled. The verdict
 * is read through the bounded wait, so a replaced `Promise` static or a planted `then` cannot
 * decide it: a prototype the guard refuses rejects with the refusal.
 *
 * @param work - The pending operation.
 * @param timeoutMs - The deadline in milliseconds.
 * @param onTimeout - Builds the error the caller receives at the deadline.
 * @returns The outcome of `work`, or the deadline error.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  const wait = startWait(work, timeoutMs)
  try {
    assertPrototypeClean()
    const outcome = await wait.result
    if (outcome.state === 'done') return outcome.v
    throw outcome.state === 'failed' ? outcome.v : onTimeout()
  } finally {
    wait.release()
  }
}
