/**
 * @fileoverview Unit tests for the load baseline of the prototype guard: replacing any own property
 * of a baselined built-in, or the global that names it, makes the guard refuse on a clean
 * `Object.prototype`; `Promise` and `Date` are exempt; the refusal is built at load, so a planted
 * `message` or replaced string and array built-ins cannot change its type or message; and the count
 * is one per entry that differs, never a name or a value.
 * @layer server/connection
 */

import { QueueException } from '../errors/queue-exception'
import { assertPrototypeClean } from './prototype-guard'

/** The keys `Object.prototype` holds before any test plants one. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

/** The shape of what a refusal carries. */
interface Body {
  readonly code: string
  readonly message: string
  readonly details: { reason: string; count: number }
}

/** Run `body` with `value` swapped in for `name` of `owner`, restoring the original in `finally`. */
function swapped<T>(owner: object, name: PropertyKey, value: unknown, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(owner, name)
  if (original === undefined) throw new Error('nothing to replace')
  Object.defineProperty(owner, name, { ...original, value })
  try {
    return body()
  } finally {
    Object.defineProperty(owner, name, original)
  }
}

/** A function that does what `original` does, so the test keeps working while it is installed. */
function passthrough(original: unknown, marker = 'zzMarker'): unknown {
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    return Reflect.apply(original as (...a: unknown[]) => unknown, this, args)
  }
  Object.defineProperty(wrapper, 'name', { value: marker })
  return wrapper
}

/** What the guard did: `undefined` when it stayed quiet, else the thrown value. */
function outcomeOf(guard: () => void): unknown {
  try {
    guard()
  } catch (error) {
    return error
  }
  return undefined
}

/** The code and details of a refusal; fails when the value is not a `QueueException`. */
function bodyOf(error: unknown): Body {
  if (!(error instanceof QueueException)) throw new Error('expected a QueueException')
  return (error.getResponse() as { error: Body }).error
}

/** Replace `name` of `owner` with a passthrough and run the guard on a clean prototype. */
function outcomeWhileReplaced(owner: object, name: PropertyKey): unknown {
  const original = (owner as Record<PropertyKey, unknown>)[name]
  return swapped(owner, name, passthrough(original), () => outcomeOf(assertPrototypeClean))
}

afterEach(() => {
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD.has(n))
  for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
  const blinded = outcomeOf(assertPrototypeClean)
  if (extra.length > 0)
    throw new Error(`a test left keys on Object.prototype: ${String(extra.length)}`)
  if (blinded !== undefined) throw new Error('a test left a baseline built-in replaced')
})

const REPLACED: readonly [string, object, PropertyKey][] = [
  ['Object.keys', Object, 'keys'],
  ['Object.defineProperty', Object, 'defineProperty'],
  ['Object.hasOwn', Object, 'hasOwn'],
  ['Object.getOwnPropertyDescriptor', Object, 'getOwnPropertyDescriptor'],
  ['Reflect.get', Reflect, 'get'],
  ['Reflect.ownKeys', Reflect, 'ownKeys'],
  ['Reflect.getPrototypeOf', Reflect, 'getPrototypeOf'],
  ['Number.isSafeInteger', Number, 'isSafeInteger'],
  ['Array.prototype[Symbol.iterator]', Array.prototype, Symbol.iterator],
  ['Function.prototype.call', Function.prototype, 'call'],
  ['Function.prototype.apply', Function.prototype, 'apply'],
  ['Function.prototype.bind', Function.prototype, 'bind'],
  ['String.prototype.match', String.prototype, 'match'],
  ['Array.prototype.join', Array.prototype, 'join'],
  ['JSON.stringify', JSON, 'stringify'],
  ['Map.prototype.get', Map.prototype, 'get'],
  ['Symbol.for', Symbol, 'for'],
  ['the Array iterator next', Object.getPrototypeOf([][Symbol.iterator]()), 'next'],
  ['the Set iterator next', Object.getPrototypeOf(new Set()[Symbol.iterator]()), 'next'],
  ['the Map iterator next', Object.getPrototypeOf(new Map()[Symbol.iterator]()), 'next'],
  ['the String iterator next', Object.getPrototypeOf(''[Symbol.iterator]()), 'next'],
  [
    'the iterator prototype [Symbol.iterator]',
    Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
    Symbol.iterator,
  ],
]

describe('a replaced built-in is refused on a clean Object.prototype', () => {
  it.each(REPLACED)('refuses while %s is replaced', (_label, owner, name) => {
    const error = outcomeWhileReplaced(owner, name)

    expect(bodyOf(error).code).toBe('queue.invalid_options')
  })

  it('refuses a built-in that is deleted', () => {
    const original = Object.getOwnPropertyDescriptor(Number, 'isSafeInteger')!
    let error: unknown
    try {
      Reflect.deleteProperty(Number, 'isSafeInteger')
      error = outcomeOf(assertPrototypeClean)
    } finally {
      Object.defineProperty(Number, 'isSafeInteger', original)
    }

    expect(error).toBeInstanceOf(QueueException)
  })

  it('refuses a built-in that is made read-only', () => {
    const original = Object.getOwnPropertyDescriptor(Number, 'isSafeInteger')!
    let error: unknown
    try {
      Object.defineProperty(Number, 'isSafeInteger', { writable: false })
      error = outcomeOf(assertPrototypeClean)
    } finally {
      Object.defineProperty(Number, 'isSafeInteger', original)
    }

    expect(error).toBeInstanceOf(QueueException)
  })

  // Measured: the baseline is the own properties at load, so a name a built-in prototype gains later
  // is not counted; only the replacement or removal of an entry that existed is.
  it('does not count a name a built-in prototype gains after the load', () => {
    let error: unknown
    try {
      Object.defineProperty(Array.prototype, 'zzExtra', { value: 1, configurable: true })
      error = outcomeOf(assertPrototypeClean)
    } finally {
      Reflect.deleteProperty(Array.prototype, 'zzExtra')
    }

    expect(error).toBeUndefined()
  })

  it.each(['Object', 'Reflect', 'Array'] as const)(
    'refuses while the global %s names another object',
    (name) => {
      const holder = globalThis as unknown as Record<string, unknown>
      const original = holder[name]
      const guard = assertPrototypeClean
      const run = outcomeOf
      let error: unknown
      try {
        holder[name] = function Other() {
          return undefined
        }
        error = run(guard)
      } finally {
        holder[name] = original
      }

      expect(error).toBeInstanceOf(QueueException)
    },
  )
})

describe('Promise and Date are exempt', () => {
  it.each([
    ['Promise.prototype.then', Promise.prototype, 'then'],
    ['Date.now', Date, 'now'],
  ] as const)('stays quiet while %s is replaced', (_label, owner, name) => {
    expect(outcomeWhileReplaced(owner, name)).toBeUndefined()
  })

  it.each(['Promise', 'Date'] as const)('stays quiet while the global %s is swapped', (name) => {
    const holder = globalThis as unknown as Record<string, unknown>
    const original = holder[name]
    const guard = assertPrototypeClean
    const run = outcomeOf
    let error: unknown
    try {
      holder[name] = function Other() {
        return undefined
      }
      error = run(guard)
    } finally {
      holder[name] = original
    }

    expect(error).toBeUndefined()
  })
})

describe('the refusal cannot be changed after the import', () => {
  it('stays a QueueException with its normal message while message is planted and string and array built-ins are replaced', () => {
    const normal = bodyOf(
      outcomeOf(() => {
        swapped(Array.prototype, 'join', 1, assertPrototypeClean)
      }),
    )
    let error: unknown
    try {
      ;(Object.prototype as Record<string, unknown>).message = 'planted-message'
      error = swapped(
        String.prototype,
        'match',
        () => null,
        () =>
          swapped(
            Array.prototype,
            'join',
            () => 'planted-join',
            () => outcomeOf(assertPrototypeClean),
          ),
      )
    } finally {
      Reflect.deleteProperty(Object.prototype, 'message')
    }

    expect(error).toBeInstanceOf(QueueException)
    expect((error as QueueException).message).not.toContain('planted')
    const body = JSON.parse(JSON.stringify((error as QueueException).getResponse())) as {
      error: Body
    }
    expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'message'])
    expect(body.error.message).toBe(normal.message)
    expect(body.error.code).toBe('queue.invalid_options')
    expect(body.error.details.reason).toBe(normal.details.reason)
    expect(body.error.details.count).toBe(3)
  })
})

describe('the count of a refusal', () => {
  it('is 1 for one replaced built-in and carries no name or value', () => {
    const error = outcomeWhileReplaced(Number, 'isSafeInteger')

    expect(bodyOf(error).details.count).toBe(1)
    const text = JSON.stringify((error as QueueException).getResponse())
    expect(text).not.toContain('isSafeInteger')
    expect(text).not.toContain('zzMarker')
  })

  it('adds one per replaced entry, and one per planted key', () => {
    const error = swapped(
      Number,
      'isSafeInteger',
      () => true,
      () =>
        swapped(
          JSON,
          'parse',
          () => 1,
          () => {
            try {
              ;(Object.prototype as Record<string, unknown>).zzCount = 'secret-value'
              return outcomeOf(assertPrototypeClean)
            } finally {
              Reflect.deleteProperty(Object.prototype, 'zzCount')
            }
          },
        ),
    )

    expect(bodyOf(error).details.count).toBe(3)
    expect(JSON.stringify((error as QueueException).getResponse())).not.toContain('secret-value')
  })

  it('counts a swapped global once, apart from the entries of the built-in', () => {
    const holder = globalThis as unknown as Record<string, unknown>
    const original = holder.Array
    const guard = assertPrototypeClean
    const run = outcomeOf
    let error: unknown
    try {
      holder.Array = function Other() {
        return undefined
      }
      error = run(guard)
    } finally {
      holder.Array = original
    }

    expect(bodyOf(error).details.count).toBe(1)
  })

  it('returns to zero once everything is restored', () => {
    outcomeWhileReplaced(Number, 'isSafeInteger')

    expect(outcomeOf(assertPrototypeClean)).toBeUndefined()
  })
})

describe('the baseline of a runtime that lacks one of the built-ins', () => {
  it('loads without it, and counts nothing for it while it stays missing', () => {
    const holder = globalThis as unknown as Record<string, unknown>
    const original = holder.JSON
    let isolated: { assertPrototypeClean: () => void } | undefined
    // The modules the guard imports are handed over as they are, so loading a second copy of the guard
    // does not evaluate them again and rewrite the built-ins they extend.
    const nest = jest.requireActual<object>('@nestjs/common')
    const exception = jest.requireActual<object>('../errors/queue-exception')
    const codes = jest.requireActual<object>('../constants/error-codes')
    jest.doMock('@nestjs/common', () => nest)
    jest.doMock('../errors/queue-exception', () => exception)
    jest.doMock('../constants/error-codes', () => codes)
    try {
      jest.isolateModules(() => {
        holder.JSON = undefined
        isolated = jest.requireActual<{ assertPrototypeClean: () => void }>('./prototype-guard')
      })
      const loaded = isolated
      expect(
        outcomeOf(() => {
          loaded?.assertPrototypeClean()
        }),
      ).toBeUndefined()
    } finally {
      holder.JSON = original
      jest.dontMock('@nestjs/common')
      jest.dontMock('../errors/queue-exception')
      jest.dontMock('../constants/error-codes')
    }

    expect(isolated).toBeDefined()
  })
})
