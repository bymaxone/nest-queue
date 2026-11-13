/**
 * @fileoverview Races a promise against a deadline.
 * @layer server/utils
 */

/**
 * Settle with `work`, or reject with `onTimeout()` once `timeoutMs` passes first. The timer is
 * cleared when `work` settles, and a rejection of `work` after the deadline is absorbed here, so
 * a late failure never surfaces as an unhandled rejection. The work itself is not cancelled.
 *
 * @param work - The pending operation.
 * @param timeoutMs - The deadline in milliseconds.
 * @param onTimeout - Builds the error the caller receives at the deadline.
 * @returns The outcome of `work`, or the deadline error.
 */
export function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout())
    }, timeoutMs)
  })
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer)
  })
}
