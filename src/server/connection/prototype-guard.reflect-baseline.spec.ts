/**
 * @fileoverview Unit tests that the guard baselines only the functions the language puts on `Reflect`:
 * a `reflect-metadata` copy that defines its own functions there after the guard loaded is a host
 * setup, not a replaced built-in, while replacing any of the language's own functions is refused.
 * @layer server/connection
 */

import { assertPrototypeClean } from './prototype-guard'
import type * as Guard from './prototype-guard'

/** The functions the language defines on `Reflect`. */
const LANGUAGE_FUNCTIONS = [
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'ownKeys',
  'preventExtensions',
  'set',
  'setPrototypeOf',
] as const

/** Captured before any case replaces a `Reflect` function, so the harness survives them. */
const define = Object.defineProperty
const keysOf = Reflect.ownKeys
const remove = Reflect.deleteProperty
const describe_ = Object.getOwnPropertyDescriptor

/** Every own descriptor `Reflect` had before a case ran. */
const original = new Map<PropertyKey, PropertyDescriptor>()

beforeEach(() => {
  original.clear()
  for (const key of keysOf(Reflect)) {
    original.set(key, describe_(Reflect, key)!)
  }
})

afterEach(() => {
  for (const key of keysOf(Reflect)) {
    if (!original.has(key)) void remove(Reflect, key)
  }
  for (const [key, descriptor] of original) void define(Reflect, key, descriptor)
})

/** Whether the guard refuses the current state, by the code of its refusal. */
function refusalCode(): string | undefined {
  try {
    assertPrototypeClean()
  } catch (error) {
    return (error as { getResponse: () => { error: { code: string } } }).getResponse().error.code
  }
  return undefined
}

describe('a function a polyfill defines on Reflect is not a replaced built-in', () => {
  it('accepts a metadata function redefined after the guard loaded', () => {
    expect(typeof Reflect.defineMetadata).toBe('function')
    const before = Reflect.defineMetadata
    void define(Reflect, 'defineMetadata', {
      ...describe_(Reflect, 'defineMetadata')!,
      value: (...args: Parameters<typeof before>): void => {
        before(...args)
      },
    })

    expect(refusalCode()).toBeUndefined()
  })

  it('accepts a second reflect-metadata copy evaluated after the guard loaded', () => {
    jest.isolateModules(() => {
      jest.requireActual('reflect-metadata')
    })

    expect(refusalCode()).toBeUndefined()
  })

  it('accepts a function added to Reflect after the guard loaded', () => {
    void define(Reflect, 'addedLater', { value: () => 1, configurable: true })

    expect(refusalCode()).toBeUndefined()
  })
})

describe('a function the language defines on Reflect is still baselined', () => {
  it.each(LANGUAGE_FUNCTIONS)('refuses a replaced %s', (name) => {
    void define(Reflect, name, { ...describe_(Reflect, name)!, value: () => undefined })

    expect(refusalCode()).toBe('queue.invalid_options')
  })

  it('refuses a deleted function', () => {
    void remove(Reflect, 'has')

    expect(refusalCode()).toBe('queue.invalid_options')
  })

  it('refuses a replaced toStringTag', () => {
    void define(Reflect, Symbol.toStringTag, {
      ...describe_(Reflect, Symbol.toStringTag)!,
      value: 'Planted',
    })

    expect(refusalCode()).toBe('queue.invalid_options')
  })
})

describe('a language function a host removed from Reflect before the guard loaded', () => {
  it.each(['has', 'getPrototypeOf', 'isExtensible'] as const)(
    'does not stop the module from loading when %s is missing',
    (name) => {
      void remove(Reflect, name)

      let loaded: typeof Guard | undefined
      jest.isolateModules(() => {
        loaded = jest.requireActual<typeof Guard>('./prototype-guard')
      })

      expect(typeof loaded?.assertPrototypeClean).toBe('function')
    },
  )
})
