/**
 * @fileoverview Never-throwing description of a caught value, for error details.
 * @layer server/utils
 */

/**
 * Describe whatever was thrown, without ever throwing itself.
 *
 * `String()` throws a `TypeError` for a null-prototype object, and reading `message` can throw
 * from a getter, so describing a failure with either directly can replace the original failure
 * with a second one. Anything with a string `message` is described by it; any other value is
 * rendered with `String()`, and a value neither can describe becomes a fixed phrase.
 *
 * @param cause - The caught value, of any type.
 * @returns The message, the `String()` rendering, or `unknown error`.
 * @example
 * describeError(new Error('boom')) // 'boom'
 * describeError(Object.create(null)) // 'unknown error'
 */
export function describeError(cause: unknown): string {
  try {
    if (typeof cause === 'object' && cause !== null && 'message' in cause) {
      if (typeof cause.message === 'string') return cause.message
    }
    return String(cause)
  } catch {
    return 'unknown error'
  }
}
