/**
 * @fileoverview The element of a list at a position the caller keeps inside it. The guard and the
 * shadow loops index with a counter instead of iterating, because iteration runs a method that a
 * polluted `Object.prototype` can replace; a counter that runs past the end must stop the loop's
 * caller at once, not hand it `undefined`.
 * @layer server/utils
 */

/**
 * The element of `list` at `position`.
 *
 * @param list - The list to read.
 * @param position - A whole number from zero up to one less than the length of `list`.
 * @returns The element at `position`.
 * @throws {RangeError} When `position` is below zero or at or past the length of `list`.
 *
 * @example
 * at(['a', 'b'], 1) // 'b'
 */
export function at<T>(list: readonly T[], position: number): T {
  if (position < 0 || position >= list.length) throw new RangeError('position outside the list')
  return list[position] as T
}
