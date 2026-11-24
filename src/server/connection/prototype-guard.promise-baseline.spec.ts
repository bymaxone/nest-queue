/**
 * @fileoverview Unit tests that the guard does not take a `constructor` a host left on the intrinsic
 * promise prototype before the module loaded for the intrinsic constructor: the intrinsic prototype
 * is found from a promise, the constructor is used only when it builds that prototype's promises,
 * and the guard refuses while the baseline is not what the language gives. Each case is
 * synchronous, because the test runner reads the constructor of the promises it awaits.
 * @layer server/connection
 */

import type * as Guard from './prototype-guard'

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
  it('refuses when Promise.prototype.constructor was replaced with Object before the load', () => {
    const guard = loadWith(Object)

    expect(guard.NativePromise).toBe(Object)
    expect(() => {
      guard.assertPrototypeClean()
    }).toThrow()
  })

  it('refuses while the prototype holds a constructor the guard did not start with', () => {
    const guard = loadWith(Promise)
    void Object.defineProperty(proto, 'constructor', { ...realConstructor, value: Object })

    expect(() => {
      guard.assertPrototypeClean()
    }).toThrow()
  })

  it('refuses a host function that was given the real promise prototype as its own', () => {
    function Planted(): void {
      // Stands in for the constructor.
    }
    Planted.prototype = proto
    const guard = loadWith(Planted)
    // The host leaves its constructor in place, so only what the guard knows of the intrinsic one can refuse.
    void Object.defineProperty(proto, 'constructor', { ...realConstructor, value: Planted })

    expect(guard.NativePromise).toBe(Planted)
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
