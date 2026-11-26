/**
 * @fileoverview Unit tests for the job-option check: a whole group of `null`, and a backoff type.
 * `typeof null` is `'object'`, so a `removeOnComplete`, `removeOnFail` or `backoff` of `null` must
 * be refused by name as a value that is not a number or an object, and never reach the destructuring
 * of its `age`, `count`, `delay` or `jitter`, which would throw a `TypeError` that names nothing.
 * A backoff object is accepted only with a type BullMQ has a strategy for.
 * @layer server/utils
 */

import { jobOptionsProblem, kindOf, received } from './job-defaults-problem'

describe('jobOptionsProblem — a group that holds null', () => {
  it.each(['removeOnComplete', 'removeOnFail', 'backoff'])(
    'refuses %s: null by name, as a value that is not a whole number',
    (key) => {
      expect(jobOptionsProblem({ [key]: null }, 'opts')).toBe(
        `opts.${key} must be a whole number >= 0, received null`,
      )
    },
  )
})

describe('received and kindOf — what a refusal says about a value', () => {
  it.each<[string, unknown, string]>([
    ['a whole number', 5, '5'],
    ['zero', 0, '0'],
    ['a fraction', 1.5, '1.5'],
    ['NaN', Number.NaN, 'a number that is not finite'],
    ['Infinity', Number.POSITIVE_INFINITY, 'a number that is not finite'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'a number that is not finite'],
    ['a string, never its text', 'a-secret', 'a string'],
    ['a boolean', true, 'a boolean'],
    ['a bigint', 1n, 'a bigint'],
    ['a boxed Number, which is an object and not a number', new Number(1), 'an object'],
    ['a symbol', Symbol('s'), 'a symbol'],
    ['a function', () => 1, 'a function'],
    ['null', null, 'null'],
    ['an array', [1], 'an array'],
    ['an object', { key: 'a-secret' }, 'an object'],
  ])('describes %s as it is received', (_label, value, expected) => {
    expect(received(value)).toBe(expected)
  })

  it.each<[string, unknown, string]>([
    ['a finite number', 5, 'a number'],
    ['a number that is not finite', Number.NaN, 'a number'],
    ['a string', 'a-secret', 'a string'],
    ['a boolean', false, 'a boolean'],
    ['a symbol', Symbol('s'), 'a symbol'],
    ['a function', () => 1, 'a function'],
    ['a bigint', 1n, 'a bigint'],
    ['a boxed Number', new Number(1), 'an object'],
    ['null', null, 'null'],
    ['an array', [], 'an array'],
    ['an object', {}, 'an object'],
  ])('names the type of %s and never the value', (_label, value, expected) => {
    expect(kindOf(value)).toBe(expected)
  })
})

describe('jobOptionsProblem — a backoff type with no strategy behind it', () => {
  it.each(['fixed', 'exponential'])('accepts %s', (type) => {
    expect(jobOptionsProblem({ backoff: { type, delay: 10 } }, 'opts')).toBeUndefined()
  })

  it.each<[string, unknown, string]>([
    ['a custom type, without repeating its text', { type: 'a-secret' }, 'a string'],
    ['no type', { delay: 10 }, 'none'],
    ['an empty object', {}, 'none'],
    ['a type of null', { type: null }, 'null'],
    ['a number', { type: 5 }, '5'],
  ])('refuses %s', (_label, backoff, given) => {
    expect(jobOptionsProblem({ backoff }, 'opts')).toBe(
      `opts.backoff.type must be 'fixed' or 'exponential', received ${given}`,
    )
  })

  it('names a wrong delay before a wrong type', () => {
    expect(jobOptionsProblem({ backoff: { type: 'mine', delay: -1 } }, 'opts')).toBe(
      'opts.backoff.delay must be a whole number >= 0, received -1',
    )
  })

  it('names a wrong jitter before a wrong type', () => {
    expect(jobOptionsProblem({ backoff: { type: 'mine', jitter: 2 } }, 'opts')).toBe(
      'opts.backoff.jitter must be a number from 0 to 1, received 2',
    )
  })
})
