/**
 * @fileoverview Unit tests that the guard counts a `then` planted on `Array.prototype` or on
 * `Function.prototype` as one defect, and reports the count only: an array or a function resolved
 * into a promise would call it, so a host that planted one decides what the promise settles with.
 * @layer server/connection
 */

import { assertPrototypeClean } from './prototype-guard'

/** The details of the refusal `assertPrototypeClean` throws, or `undefined` when it does not refuse. */
function refusalDetails(): unknown {
  try {
    assertPrototypeClean()
  } catch (error) {
    return (error as { getResponse: () => { error: { details: unknown } } }).getResponse().error
      .details
  }
  return undefined
}

describe('a then planted on a prototype an array or a function reaches', () => {
  it.each([
    ['Array.prototype', Array.prototype],
    ['Function.prototype', Function.prototype],
  ])('is counted once on %s, and only the count is reported', (_name, owner) => {
    void Object.defineProperty(owner, 'then', { value: 1, configurable: true })
    let details: unknown
    try {
      details = refusalDetails()
    } finally {
      void Reflect.deleteProperty(owner, 'then')
    }

    expect(details).toEqual({
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count: 1,
    })
    expect(JSON.stringify(details)).not.toContain('then')
  })

  it('is counted on both at once', () => {
    void Object.defineProperty(Array.prototype, 'then', { value: 1, configurable: true })
    void Object.defineProperty(Function.prototype, 'then', { value: 1, configurable: true })
    let details: unknown
    try {
      details = refusalDetails()
    } finally {
      void Reflect.deleteProperty(Array.prototype, 'then')
      void Reflect.deleteProperty(Function.prototype, 'then')
    }

    expect(details).toMatchObject({ count: 2 })
  })

  it('does not refuse once both are gone', () => {
    expect(refusalDetails()).toBeUndefined()
  })
})
