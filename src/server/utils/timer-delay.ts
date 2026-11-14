/**
 * @fileoverview The range of a timer delay in milliseconds that Node honours.
 * @layer server/utils
 */

/** The largest delay a Node timer honours; a larger one fires after 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Whether `value` is a whole number of milliseconds from 1 to {@link MAX_TIMER_DELAY_MS}. A
 * fraction below 1 would be rounded to 1 ms by the timer, and a larger delay overflows it.
 *
 * @param value - The configured delay.
 */
export function isTimerDelayMs(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_TIMER_DELAY_MS
}
