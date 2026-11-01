/**
 * @fileoverview Unit tests for describeError.
 * @layer server/utils
 */

import { runInNewContext } from 'node:vm'
import { describeError } from './describe-error'

describe('describeError', () => {
  it('returns the message of an Error', () => {
    // The common case keeps the exact text the Error carries.
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('returns the message of an error-like object that is not an Error', () => {
    // A cross-realm or hand-built error has a string message but fails instanceof Error.
    expect(describeError({ message: 'from another realm' })).toBe('from another realm')
  })

  it('returns the message of an Error created in another realm', () => {
    // An Error from a vm context, a worker or Jest's sandbox fails instanceof Error here, so the
    // message has to be read off the value rather than gated on the constructor.
    const foreign: unknown = runInNewContext('new Error("from another context")')
    expect(foreign instanceof Error).toBe(false)
    expect(describeError(foreign)).toBe('from another context')
  })

  it('returns an empty message as is', () => {
    // A message that exists but is empty is still the message; it is not replaced by a phrase.
    expect(describeError(new Error(''))).toBe('')
  })

  it.each([
    ['a string', 'auth_failed', 'auth_failed'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an object with a non-string message', { message: 7 }, '[object Object]'],
  ])('stringifies %s', (_label, cause, expected) => {
    // A value without a string message is rendered with String().
    expect(describeError(cause)).toBe(expected)
  })

  it('does not throw for a null-prototype object', () => {
    // String(Object.create(null)) throws a TypeError; the helper falls back to a fixed phrase.
    expect(describeError(Object.create(null))).toBe('unknown error')
  })

  it('does not throw when reading the message throws', () => {
    // A getter that throws must not turn error reporting into a second error.
    const cause = {
      get message(): string {
        throw new Error('getter failed')
      },
    }
    expect(describeError(cause)).toBe('unknown error')
  })

  it('does not throw for a Symbol cause', () => {
    // Symbols convert with String() but not with template literals; both stay non-throwing here.
    expect(describeError(Symbol('s'))).toBe('Symbol(s)')
  })
})
