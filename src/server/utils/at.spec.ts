/**
 * @fileoverview Unit tests for `at`: it answers the element at a position inside the list and throws
 * for any position outside it, so a loop whose bound is off by one fails at once.
 * @layer server/utils
 */

import { at } from './at'

describe('at', () => {
  it.each([
    [0, 'a'],
    [1, 'b'],
    [2, 'c'],
  ])('answers the element at position %d', (position, expected) => {
    expect(at(['a', 'b', 'c'], position)).toBe(expected)
  })

  it.each([[-1], [3], [4]])('throws for position %d, outside a list of three', (position) => {
    expect(() => at(['a', 'b', 'c'], position)).toThrow(new RangeError('position outside the list'))
  })

  it('throws for any position of an empty list', () => {
    expect(() => at([], 0)).toThrow(RangeError)
  })

  it('answers an element that is null without throwing', () => {
    const found = at([null], 0)

    expect(found).toBeNull()
  })
})
