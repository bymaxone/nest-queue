/**
 * @fileoverview Unit tests that the guard does not take a `constructor` a host left on the intrinsic
 * promise prototype before the module loaded for the intrinsic constructor: the intrinsic prototype
 * is found from a promise, the module refuses to load unless the constructor builds that
 * prototype's promises, and the guard refuses while the constructor is not the one it loaded with.
 * Each case is synchronous, because the test runner reads the constructor of the promises it awaits.
 * @layer server/connection
 */

import { runInNewContext } from 'node:vm'
import type * as Guard from './prototype-guard'
import './prototype-guard'

const proto = Promise.prototype
const realConstructor = Object.getOwnPropertyDescriptor(proto, 'constructor')!

afterEach(() => {
  void Object.defineProperty(proto, 'constructor', realConstructor)
})

/** Load a fresh copy of the guard while `Promise.prototype.constructor` is `replacement`. */
function loadWith(replacement: unknown): typeof Guard {
  let loaded: typeof Guard | undefined
  void Object.defineProperty(proto, 'constructor', { ...realConstructor, value: replacement })
  try {
    jest.isolateModules(() => {
      loaded = jest.requireActual<typeof Guard>('./prototype-guard')
    })
  } finally {
    void Object.defineProperty(proto, 'constructor', realConstructor)
  }
  if (loaded === undefined) throw new Error('the guard did not load')
  return loaded
}

describe('a constructor replaced before the guard loaded is not taken for the intrinsic one', () => {
  /** The code of the refusal `run` raised; the module is a fresh copy, so its exception class is too. */
  function refusalCode(run: () => void): string | undefined {
    try {
      run()
    } catch (error) {
      const { error: body } = (
        error as { getResponse: () => { error: { code: string } } }
      ).getResponse()
      return body.code
    }
    return undefined
  }

  /** The code of the refusal the load raised. */
  function refusalCodeOfLoad(replacement: unknown): string | undefined {
    return refusalCode(() => {
      void loadWith(replacement)
    })
  }

  it('refuses to load when Promise.prototype.constructor was replaced with Object', () => {
    expect(refusalCodeOfLoad(Object)).toBe('queue.invalid_options')
  })

  it('refuses to load when a host function was given the real promise prototype as its own', () => {
    function Planted(): void {
      // Stands in for the constructor.
    }
    Planted.prototype = proto

    expect(refusalCodeOfLoad(Planted)).toBe('queue.invalid_options')
  })

  it('refuses to load when the constructor is a native Promise of another realm', () => {
    // Same source text as the intrinsic one, built on a different prototype.
    expect(refusalCodeOfLoad(runInNewContext('Promise'))).toBe('queue.invalid_options')
  })

  it('refuses to load when the constructor is not a function, whatever prototype it carries', () => {
    expect(refusalCodeOfLoad({ prototype: proto })).toBe('queue.invalid_options')
  })

  it('refuses with its own refusal, not a TypeError, when the constructor was deleted', () => {
    const guard = loadWith(Promise)
    void Reflect.deleteProperty(proto, 'constructor')

    expect(
      refusalCode(() => {
        guard.assertPrototypeClean()
      }),
    ).toBe('queue.invalid_options')
  })

  it('refuses while the prototype holds a constructor the guard did not start with', () => {
    const guard = loadWith(Promise)
    void Object.defineProperty(proto, 'constructor', { ...realConstructor, value: Object })

    expect(() => {
      guard.assertPrototypeClean()
    }).toThrow()
  })

  it('accepts a clean baseline', () => {
    const guard = loadWith(Promise)

    expect(guard.NativePromise).toBe(Promise)
    expect(() => {
      guard.assertPrototypeClean()
    }).not.toThrow()
  })
})
