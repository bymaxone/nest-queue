/**
 * @fileoverview Unit tests for the refusal of a polluted `Object.prototype`: what counts as planted,
 * what the refusal carries, that a planted accessor is never run by the comparison, and the baseline
 * the module takes at load.
 * @layer server/connection
 */

import { QueueException } from '../errors/queue-exception'
import * as guardModule from './prototype-guard'

const { STANDARD_KEYS, assertPrototypeClean } = guardModule

/** The twelve string keys of `Object.prototype`. */
const TWELVE = [
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]

/** The shape of what a refusal carries. */
interface Refusal {
  readonly code: string
  readonly details: unknown
}

/** What `run` throws, as its code and details; fails when it does not throw a `QueueException`. */
function refusalOf(run: () => void): { error: QueueException; body: Refusal } {
  try {
    run()
  } catch (error) {
    if (!(error instanceof QueueException)) throw error
    const { error: body } = error.getResponse() as { error: Refusal }
    return { error, body }
  }
  throw new Error('expected a refusal')
}

/** The descriptor of a key of `Object.prototype`, which must exist. */
function descriptorOf(name: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, name)
  if (descriptor === undefined) throw new Error(`Object.prototype has no ${name}`)
  return descriptor
}

/** Run `body` with `descriptor` on `Object.prototype` under `name`, and put the original back. */
function withDescriptor<T>(
  name: string,
  descriptor: PropertyDescriptor | undefined,
  body: () => T,
): T {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, name)
  if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, name)
  else Object.defineProperty(Object.prototype, name, descriptor)
  try {
    return body()
  } finally {
    if (original === undefined) Reflect.deleteProperty(Object.prototype, name)
    else Object.defineProperty(Object.prototype, name, original)
  }
}

afterEach(() => {
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !TWELVE.includes(n))
  if (extra.length > 0) {
    for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
    throw new Error(`a test left ${String(extra.length)} key(s) on Object.prototype`)
  }
})

describe('assertPrototypeClean on a clean realm', () => {
  it('passes', () => {
    expect(() => {
      assertPrototypeClean()
    }).not.toThrow()
  })

  it('holds the twelve standard keys, and this Node has nothing beyond them', () => {
    expect([...STANDARD_KEYS].sort()).toEqual([...TWELVE].sort())
    expect(STANDARD_KEYS.size).toBe(12)
    const beyond = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD_KEYS.has(n))
    expect(beyond).toEqual([])
  })
})

describe('assertPrototypeClean refuses a planted key', () => {
  it.each(['client', 'path', 'ca', 'get', 'set', 'value', 'then'])(
    'counts a planted %s once and reports the count only',
    (name) => {
      const { error, body } = withDescriptor(
        name,
        { value: 'planted-value-xyz', configurable: true, writable: true },
        () =>
          refusalOf(() => {
            assertPrototypeClean()
          }),
      )

      expect(body.code).toBe('queue.invalid_options')
      expect(body.details).toEqual({
        reason: 'Object.prototype holds keys the libraries would read as their own',
        count: 1,
      })
      const text = JSON.stringify(error)
      expect(text).not.toContain(name === 'value' ? 'planted-value-xyz' : `"${name}"`)
      expect(text).not.toContain('planted-value-xyz')
    },
  )

  it('counts each planted key', () => {
    const { body } = withDescriptor('zzOne', { value: 1, configurable: true }, () =>
      withDescriptor('zzTwo', { value: 2, configurable: true }, () =>
        refusalOf(() => {
          assertPrototypeClean()
        }),
      ),
    )

    expect((body.details as { count: number }).count).toBe(2)
  })

  it('reports a count capped at the most the table holds, as one frozen refusal', () => {
    const names = Array.from({ length: 70 }, (_, i) => `zzMany${String(i)}`)
    for (const name of names) {
      Object.defineProperty(Object.prototype, name, { value: 1, configurable: true })
    }
    try {
      const first = refusalOf(() => {
        assertPrototypeClean()
      })
      const second = refusalOf(() => {
        assertPrototypeClean()
      })
      expect((first.body.details as { count: number }).count).toBe(64)
      expect(second.error).toBe(first.error)
      expect(Object.isFrozen(first.error)).toBe(true)
      expect(Object.isFrozen(first.body.details)).toBe(true)
    } finally {
      for (const name of names) Reflect.deleteProperty(Object.prototype, name)
    }
  })

  /** The code of the refusal while `symbol` sits on `Object.prototype` with `descriptor`, or `clean`. */
  function whileSymbol(symbol: symbol, descriptor: PropertyDescriptor): Refusal | 'clean' {
    Object.defineProperty(Object.prototype, symbol, descriptor)
    try {
      return refusalOf(() => {
        assertPrototypeClean()
      }).body
    } catch {
      return 'clean'
    } finally {
      Reflect.deleteProperty(Object.prototype, symbol)
    }
  }

  it.each([
    ['an unregistered symbol', Symbol('planted'), { value: 1, configurable: true }],
    [
      'an unregistered symbol that is enumerable',
      Symbol('planted'),
      { value: 1, configurable: true, enumerable: true },
    ],
    [
      'a registry symbol that is not the runner’s',
      Symbol.for('zzOther'),
      { value: 1, configurable: true },
    ],
    [
      'an unregistered symbol with the runner’s description',
      Symbol('$$jest-protect-from-deletion'),
      { value: [], configurable: true },
    ],
  ])('counts %s', (_label, symbol, descriptor) => {
    const outcome = whileSymbol(symbol, descriptor)

    expect(outcome).not.toBe('clean')
    expect((outcome as Refusal).details).toEqual({
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count: 1,
    })
  })

  it('counts a planted Symbol.iterator, which changes how objects are iterated', () => {
    const outcome = whileSymbol(Symbol.iterator, {
      value: () => ({ next: () => ({ done: true }) }),
      configurable: true,
    })

    expect(outcome).not.toBe('clean')
  })

  it('does not count the runner’s own registered symbol while it is not enumerable', () => {
    const key = Symbol.for('$$jest-protect-from-deletion')

    expect(Object.getOwnPropertyDescriptor(Object.prototype, key)?.enumerable).toBe(false)
    expect(() => {
      assertPrototypeClean()
    }).not.toThrow()
  })

  it('counts the runner’s own registered symbol once it is enumerable', () => {
    const key = Symbol.for('$$jest-protect-from-deletion')
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key)!
    Object.defineProperty(Object.prototype, key, { ...original, enumerable: true })
    try {
      const { body } = refusalOf(() => {
        assertPrototypeClean()
      })

      expect((body.details as { count: number }).count).toBe(1)
    } finally {
      Object.defineProperty(Object.prototype, key, original)
    }
  })

  it('does not run an accessor planted under a name the descriptor comparison reads', () => {
    const ran: string[] = []
    for (const name of ['get', 'set', 'value']) {
      const result = withDescriptor(
        name,
        {
          get() {
            ran.push(name)
            throw new Error('the accessor ran')
          },
          configurable: true,
        },
        () => {
          try {
            assertPrototypeClean()
            return 'clean'
          } catch (error) {
            return error instanceof QueueException
              ? (error.getResponse() as { error: Refusal }).error.details
              : 'foreign'
          }
        },
      )
      expect(result).toEqual({
        reason: 'Object.prototype holds keys the libraries would read as their own',
        count: 1,
      })
    }
    expect(ran).toEqual([])
  })
})

describe('assertPrototypeClean refuses a standard key that is not what it was', () => {
  /** A function that behaves like `Object.prototype[name]` but is not it. */
  function lookalike(name: 'hasOwnProperty' | 'toString' | 'constructor'): PropertyDescriptor {
    const original = descriptorOf(name).value as (...args: unknown[]) => unknown
    if (name === 'constructor') {
      return { value: Object, writable: true, configurable: true, enumerable: false }
    }
    const value = {
      [name](this: unknown, ...args: unknown[]): unknown {
        return Reflect.apply(original, this, args)
      },
    }[name]
    return { value, writable: true, configurable: true, enumerable: false }
  }

  it.each(['hasOwnProperty', 'toString'] as const)('counts an overwritten %s', (name) => {
    const { body } = withDescriptor(name, lookalike(name), () =>
      refusalOf(() => {
        assertPrototypeClean()
      }),
    )

    expect((body.details as { count: number }).count).toBe(1)
  })

  it('counts an overwritten constructor', () => {
    const replacement = function Object2(): void {
      return undefined
    }
    const { body } = withDescriptor(
      'constructor',
      { value: replacement, writable: true, configurable: true, enumerable: false },
      () =>
        refusalOf(() => {
          assertPrototypeClean()
        }),
    )

    expect((body.details as { count: number }).count).toBe(1)
  })

  it('counts an accessor planted under a standard name', () => {
    const { body } = withDescriptor(
      'toLocaleString',
      { get: () => undefined, configurable: true },
      () =>
        refusalOf(() => {
          assertPrototypeClean()
        }),
    )

    expect((body.details as { count: number }).count).toBe(1)
  })

  it('counts a getter and a setter of __proto__ that are other functions', () => {
    const was = descriptorOf('__proto__')
    const fresh = (descriptor: PropertyDescriptor): number =>
      withDescriptor('__proto__', descriptor, () => {
        const { body } = refusalOf(() => {
          assertPrototypeClean()
        })
        return (body.details as { count: number }).count
      })

    expect(
      fresh({
        ...was,
        get(this: unknown) {
          return (was.get as () => unknown).call(this)
        },
      }),
    ).toBe(1)
    expect(
      fresh({
        ...was,
        set(this: unknown, value: unknown) {
          ;(was.set as (v: unknown) => void).call(this, value)
        },
      }),
    ).toBe(1)
  })

  it('counts a standard key made enumerable', () => {
    const { body } = withDescriptor(
      'valueOf',
      { ...descriptorOf('valueOf'), enumerable: true },
      () =>
        refusalOf(() => {
          assertPrototypeClean()
        }),
    )

    expect((body.details as { count: number }).count).toBe(1)
  })

  it('counts a standard key made read-only', () => {
    const { body } = withDescriptor(
      'isPrototypeOf',
      { ...descriptorOf('isPrototypeOf'), writable: false },
      () =>
        refusalOf(() => {
          assertPrototypeClean()
        }),
    )

    expect((body.details as { count: number }).count).toBe(1)
  })

  it('counts a standard key that was deleted', () => {
    const { body } = withDescriptor('propertyIsEnumerable', undefined, () =>
      refusalOf(() => {
        assertPrototypeClean()
      }),
    )

    expect((body.details as { count: number }).count).toBe(1)
  })
})

/** The module under test, as a copy of it is loaded. */
type GuardModule = typeof guardModule

/** What a fresh copy of the module did when it was loaded and used under a changed key. */
interface CopyOutcome {
  readonly loadThrew: boolean
  readonly useThrew: boolean
  readonly body: Refusal | undefined
}

/**
 * Load a fresh copy of the module while `name` holds `descriptor` (`undefined` deletes it), use the
 * copy while it still does (or after the original is back, with `restoreBeforeUse`), and put the
 * original back. The state at load and at use is the same unless asked otherwise, so what is measured
 * is the baseline the copy took and not its comparison against that baseline.
 */
function copyUnder(
  name: string,
  descriptor: PropertyDescriptor | undefined,
  restoreBeforeUse = false,
): CopyOutcome {
  const original = descriptorOf(name)
  const restore = (): void => {
    Object.defineProperty(Object.prototype, name, original)
  }
  if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, name)
  else Object.defineProperty(Object.prototype, name, descriptor)
  let fresh: (() => void) | undefined
  let loadThrew = false
  let useThrew = false
  let body: Refusal | undefined
  try {
    try {
      jest.isolateModules(() => {
        fresh = jest.requireActual<GuardModule>('./prototype-guard').assertPrototypeClean
      })
    } catch {
      loadThrew = true
    }
    if (restoreBeforeUse) restore()
    try {
      ;(fresh as () => void)()
    } catch (error) {
      useThrew = true
      body = (error as { getResponse: () => { error: Refusal } }).getResponse().error
    }
  } finally {
    restore()
  }
  return { loadThrew, useThrew, body }
}

describe('the baseline the module takes at load', () => {
  const nonNative = (): void => undefined
  const native = descriptorOf('hasOwnProperty').value as unknown

  /** The data descriptor of a key that holds `value`. */
  const holding = (value: unknown): PropertyDescriptor => ({
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })

  it.each([
    ['a function written in JavaScript', 'hasOwnProperty', holding(nonNative)],
    ['a value that is not a function', 'toString', holding(42)],
    ['a proxy of a native function', 'isPrototypeOf', holding(new Proxy(native as () => void, {}))],
    ['a native function with another name', 'valueOf', holding(native)],
    ['a constructor that is not Object', 'constructor', holding(nonNative)],
    ['a key that is not there', 'toLocaleString', undefined],
  ])('refuses at use, and not at import, when %s was there at load', (_label, name, descriptor) => {
    const outcome = copyUnder(name, descriptor)

    expect(outcome.loadThrew).toBe(false)
    expect(outcome.useThrew).toBe(true)
    expect(outcome.body?.code).toBe('queue.invalid_options')
    expect(outcome.body?.details).toEqual({
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count: 1,
    })
  })

  it('refuses a __proto__ without a native getter and setter', () => {
    const was = descriptorOf('__proto__')
    const javaScript: PropertyDescriptor = {
      get(this: unknown) {
        return Object.getPrototypeOf(this) as unknown
      },
      set(this: unknown, value: object | null) {
        Object.setPrototypeOf(this, value)
      },
      configurable: true,
      enumerable: false,
    }
    const onlyGetterNative: PropertyDescriptor = { ...javaScript, get: was.get as () => unknown }

    for (const descriptor of [javaScript, onlyGetterNative]) {
      const outcome = copyUnder('__proto__', descriptor)

      expect(outcome.loadThrew).toBe(false)
      expect(outcome.useThrew).toBe(true)
    }
  })

  it('treats a missing __proto__ accessor as expected, as on a runtime without one', () => {
    const outcome = copyUnder('__proto__', undefined)

    expect(outcome.loadThrew).toBe(false)
    expect(outcome.useThrew).toBe(false)
  })

  it('refuses a __proto__ accessor that appears after a load without one, counting it once', () => {
    const outcome = copyUnder('__proto__', undefined, true)

    expect(outcome.loadThrew).toBe(false)
    expect(outcome.useThrew).toBe(true)
    expect(outcome.body?.details).toEqual({
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count: 1,
    })
  })

  it('refuses a key that was missing at load and is back at use', () => {
    const outcome = copyUnder('toLocaleString', undefined, true)

    expect(outcome.loadThrew).toBe(false)
    expect(outcome.useThrew).toBe(true)
  })

  it('is clean in a copy loaded under the standard keys', () => {
    const outcome = copyUnder('toString', descriptorOf('toString'))

    expect(outcome.useThrew).toBe(false)
  })
})
