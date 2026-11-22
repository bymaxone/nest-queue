/**
 * @fileoverview Unit tests for a guard that cannot be blinded by replacing a built-in after the
 * library was imported. The guard runs on the built-ins as they were at load and reads nothing through
 * an iterator or a method of an object it did not make, so a built-in made to answer with nothing, or
 * with everything, still lets it refuse a planted key.
 * @layer server/connection
 */

import { QueueException } from '../errors/queue-exception'
import { assertPrototypeClean } from './prototype-guard'

/** A built-in to replace, where it lives, and what to put there. */
type Replacement = readonly [label: string, owner: object, name: PropertyKey, instead: unknown]

const nothing = (): unknown[] => []
const everything = (): boolean => true
const none = (): undefined => undefined

const REPLACEMENTS: readonly Replacement[] = [
  ['Object.getOwnPropertyNames', Object, 'getOwnPropertyNames', nothing],
  ['Object.getOwnPropertyDescriptor', Object, 'getOwnPropertyDescriptor', none],
  ['Object.hasOwn', Object, 'hasOwn', everything],
  ['Object.is', Object, 'is', everything],
  ['Object.create', Object, 'create', () => ({})],
  ['Reflect.apply', Reflect, 'apply', none],
  ['Array.prototype.filter', Array.prototype, 'filter', nothing],
  ['Array.prototype.map', Array.prototype, 'map', nothing],
  ['Array.prototype.push', Array.prototype, 'push', none],
  ['Array.prototype.indexOf', Array.prototype, 'indexOf', () => -1],
  ['Array.prototype.includes', Array.prototype, 'includes', everything],
  ['Array.prototype.some', Array.prototype, 'some', () => false],
  [
    'Array.prototype[Symbol.iterator]',
    Array.prototype,
    Symbol.iterator,
    () => ({ next: () => ({ done: true }) }),
  ],
  ['Set.prototype.has', Set.prototype, 'has', everything],
  ['Set.prototype.add', Set.prototype, 'add', none],
  ['Array.isArray', Array, 'isArray', () => false],
  ['Function.prototype.call', Function.prototype, 'call', none],
  ['Function.prototype.apply', Function.prototype, 'apply', none],
  ['RegExp.prototype.test', RegExp.prototype, 'test', () => false],
  ['String.prototype.indexOf', String.prototype, 'indexOf', () => -1],
]

/** What the guard did while `name` of `owner` held `instead` and a key was planted. */
function outcomeBlinded(
  owner: object,
  name: PropertyKey,
  instead: unknown,
  planted: boolean,
): unknown {
  const original = Object.getOwnPropertyDescriptor(owner, name)
  Object.defineProperty(owner, name, { ...original, value: instead })
  let outcome: unknown = 'clean'
  try {
    if (planted) (Object.prototype as Record<string, unknown>).zzBlind = 1
    assertPrototypeClean()
  } catch (error) {
    outcome = error
  } finally {
    Reflect.deleteProperty(Object.prototype, 'zzBlind')
    Object.defineProperty(owner, name, original!)
  }
  return outcome
}

describe('the guard keeps refusing when a built-in is replaced after the import', () => {
  it.each(REPLACEMENTS)(
    'refuses a planted key while %s is replaced',
    (_label, owner, name, instead) => {
      const outcome = outcomeBlinded(owner, name, instead, true)

      expect(outcome).toBeInstanceOf(QueueException)
    },
  )

  it.each(REPLACEMENTS)(
    'stays quiet on a clean prototype while %s is replaced',
    (_label, owner, name, instead) => {
      expect(outcomeBlinded(owner, name, instead, false)).toBe('clean')
    },
  )

  it('refuses a replaced standard method while the descriptor lookup is also replaced', () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toString')
    const lookup = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')
    let outcome: unknown = 'clean'
    try {
      Object.defineProperty(Object.prototype, 'toString', { ...original, value: () => 'x' })
      Object.defineProperty(Object, 'getOwnPropertyDescriptor', { ...lookup, value: none })
      assertPrototypeClean()
    } catch (error) {
      outcome = error
    } finally {
      Object.defineProperty(Object, 'getOwnPropertyDescriptor', lookup!)
      Object.defineProperty(Object.prototype, 'toString', original!)
    }

    expect(outcome).toBeInstanceOf(QueueException)
  })
})
