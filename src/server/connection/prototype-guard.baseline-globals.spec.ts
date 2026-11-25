/**
 * @fileoverview Unit tests that every built-in the guard keeps a load baseline of is held to it, by
 * a literal list of the names, so a name dropped from the list the guard reads fails its own row. A
 * global replaced after the import, and a method replaced on a prototype, are each refused.
 * @layer server/connection
 */

import { QueueException } from '../errors/queue-exception'
import { assertPrototypeClean } from './prototype-guard'

// Taken before any global is replaced: the restore must not call a built-in the row has replaced.
const define = Object.defineProperty
const describeOwn = Object.getOwnPropertyDescriptor

const GLOBAL_NAMES = [
  'Object',
  'Reflect',
  'Array',
  'Number',
  'String',
  'Function',
  'Symbol',
  'JSON',
  'Set',
  'Map',
  'RegExp',
  'WeakMap',
  'WeakSet',
  'Boolean',
  'BigInt',
]

/** A method of the prototype of each global the baseline names, to replace there. */
const PROTOTYPE_METHODS: readonly (readonly [string, string])[] = [
  ['Array', 'at'],
  ['Number', 'toFixed'],
  ['String', 'trim'],
  ['Function', 'bind'],
  ['Set', 'has'],
  ['Map', 'get'],
  ['RegExp', 'exec'],
  ['WeakMap', 'get'],
  ['WeakSet', 'has'],
  ['Boolean', 'valueOf'],
  ['BigInt', 'toString'],
]

/** What the guard did while `run` held its change. */
function outcomeOf(run: () => () => void): unknown {
  const restore = run()
  try {
    assertPrototypeClean()
    return 'clean'
  } catch (error) {
    return error
  } finally {
    restore()
  }
}

describe('the guard holds every built-in of its baseline', () => {
  it.each(GLOBAL_NAMES)('refuses once the global %s is replaced', (name) => {
    const target = globalThis as unknown as Record<string, unknown>
    const outcome = outcomeOf(() => {
      const original = describeOwn(globalThis, name)!
      define(globalThis, name, { ...original, value: function Replaced() {} })
      return () => {
        define(globalThis, name, original)
      }
    })

    expect(outcome).toBeInstanceOf(QueueException)
    expect(typeof target[name]).not.toBe('undefined')
  })

  it.each(PROTOTYPE_METHODS)('refuses once %s.prototype.%s is replaced', (name, method) => {
    const prototype = (globalThis as unknown as Record<string, { prototype: object }>)[name]!
      .prototype
    const outcome = outcomeOf(() => {
      const original = describeOwn(prototype, method)!
      define(prototype, method, { ...original, value: function replaced() {} })
      return () => {
        define(prototype, method, original)
      }
    })

    expect(outcome).toBeInstanceOf(QueueException)
  })
})
