/**
 * @fileoverview Unit tests for the probes the guard takes at load: the iterator prototypes it
 * records come from an empty array and an empty string, and `Function.prototype.toString` is called
 * with no argument. Each row loads the guard in an isolated registry while the built-in that answers
 * the probe is replaced by one that reports what it was given, and puts the built-in back afterwards.
 * @layer server/connection
 */

import * as Guard from './prototype-guard'

/** The error the guard refuses with, as far as these rows read it. */
interface Refusal {
  readonly getResponse: () => { error: { details: { count: number } } }
}

/** An iterator whose prototype is its own, so what the baseline holds of it can be tampered with. */
function distinctIterator(): { iterator: object; proto: { next: () => { done: boolean } } } {
  const proto = {
    next(): { done: boolean } {
      return { done: true }
    },
  }
  return { iterator: Object.create(proto) as object, proto }
}

/** Runs `body` while `owner[key]` is `value`, restoring the original in `finally`. */
function whileReplaced<T>(owner: object, key: PropertyKey, value: unknown, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(owner, key)!
  Object.defineProperty(owner, key, { ...original, value })
  try {
    return body()
  } finally {
    Object.defineProperty(owner, key, original)
  }
}

/** Evaluates the guard in an isolated registry. */
function loadGuard(): typeof Guard {
  let loaded: typeof Guard | undefined
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof Guard>('./prototype-guard')
  })
  return loaded!
}

/** How many defects the guard reports now, `0` when it stays quiet. */
function defects(guard: typeof Guard): number {
  try {
    guard.assertPrototypeClean()
  } catch (error) {
    return (error as Refusal).getResponse().error.details.count
  }
  return 0
}

describe('the probes the guard takes at load', () => {
  /**
   * Scenario: the guard is loaded through `loadGuard` and through an ordinary import.
   * Expectation: they are two copies. The rows below read what the copy loaded under a replaced
   * built-in recorded, which only says something about the module registry they isolate. The
   * ordinary import is also what keeps this file among the tests that Stryker runs for the guard:
   * its runner selects tests by the modules they import, and a type-only import selects none.
   */
  it('loads a copy of the guard that is not the one an import returns', () => {
    expect(loadGuard().assertPrototypeClean).not.toBe(Guard.assertPrototypeClean)
  })

  /**
   * Scenario: the iterator factory of `owner` answers a distinct iterator for an empty subject and the
   * real one for any other, and the guard is loaded while it does. The distinct iterator's prototype
   * then has its `next` replaced.
   * Expectation: the guard is quiet before that and reports one defect after, which it can only do if
   * its baseline took the prototype of the iterator answered for the empty subject.
   */
  it.each([
    ['an array', Array.prototype, (subject: unknown) => (subject as unknown[]).length === 0],
    ['a string', String.prototype, (subject: unknown) => String(subject).length === 0],
  ] as const)('takes the iterator prototype of %s from an empty one', (_name, owner, isEmpty) => {
    const forEmpty = distinctIterator()
    const real = Reflect.get(owner, Symbol.iterator) as (this: unknown) => unknown
    const factory = function (this: unknown): unknown {
      return isEmpty(this) ? forEmpty.iterator : Reflect.apply(real, this, [])
    }

    whileReplaced(owner, Symbol.iterator, factory, () => {
      const guard = loadGuard()
      expect(defects(guard)).toBe(0)

      forEmpty.proto.next = (): { done: boolean } => ({ done: true })

      expect(defects(guard)).toBe(1)
    })
  })

  it('calls Function.prototype.toString with no argument', () => {
    /**
     * Scenario: `Function.prototype.toString` records how many arguments each call gets, and the guard
     * is loaded while it does.
     * Expectation: the guard called it, and every call it made passed none.
     */
    const counts: number[] = []
    const real = Function.prototype.toString
    const recording = function (this: unknown, ...received: unknown[]): string {
      counts.push(received.length)
      return Reflect.apply(real, this, [])
    }

    whileReplaced(Function.prototype, 'toString', recording, () => {
      loadGuard()
    })

    expect(counts.length).toBeGreaterThan(0)
    expect(counts.every((count) => count === 0)).toBe(true)
  })
})
