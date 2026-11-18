/**
 * @fileoverview The one place that says whether a processor's rejection hands the job back to BullMQ
 * or fails it. BullMQ's worker reads a rate limit by the message of the error and a delay, a wait for
 * children or a wait by the name, and treats none of them as a failure; the outcome count and the
 * spans read a rejection the same way, through this reader. It is a pure function with no
 * dependency, imported by both bundles, and not part of any entry's exports.
 * @layer shared
 */

/** What a processor says when it hands the job back to BullMQ instead of finishing or failing it. */
export type HandBack = 'delayed' | 'waiting_children' | 'rate_limited' | 'waiting'

/** The message of BullMQ's `RateLimitError`, which its worker reads a manual rate limit by. */
const RATE_LIMIT_MESSAGE = 'bullmq:rateLimitExceeded'

/** The names BullMQ's worker reads as control flow, and what each one means. */
const HAND_BACKS: Readonly<Record<string, HandBack>> = {
  DelayedError: 'delayed',
  WaitingChildrenError: 'waiting_children',
  WaitingError: 'waiting',
}

/**
 * Whether a processor's error hands the job back to BullMQ, decided the way BullMQ's worker decides
 * it in `handleFailed`: a rate limit by its message, the others by the name of the error (which is
 * also how a second copy of the package is recognised). A spec pins the message and the names to
 * BullMQ's own classes. An error BullMQ does not read as control flow is a failure of the work.
 *
 * @param error - What the processor threw.
 * @returns What the processor handed back, or `undefined` for a failure.
 * @example
 * handBackOf(new DelayedError()) // 'delayed'
 * handBackOf(new Error('boom')) // undefined
 */
export function handBackOf(error: unknown): HandBack | undefined {
  // BullMQ reads the message first and the name after it, and each read is guarded on its own, so a
  // member that throws, or a value that has none (`null`), never hides the other one.
  if (memberOf(error, 'message') === RATE_LIMIT_MESSAGE) return 'rate_limited'
  const name = memberOf(error, 'name')
  return typeof name === 'string' && Object.hasOwn(HAND_BACKS, name) ? HAND_BACKS[name] : undefined
}

/**
 * A member of what a processor threw. Reading it can itself throw (a getter), and that must never
 * replace the processor's own error, so an unreadable member reads as absent.
 */
export function memberOf(error: unknown, key: 'name' | 'message'): unknown {
  try {
    return (error as Record<string, unknown>)[key]
  } catch {
    // An unreadable member is absent.
  }
  return undefined
}
