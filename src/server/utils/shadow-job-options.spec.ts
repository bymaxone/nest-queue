/**
 * @fileoverview Unit tests for the own values a job's options carry while its handler runs.
 * @layer server/utils
 */

import { JOB_OPTION_KEYS } from '../config/snapshot-options'
import { shadowJobOptions } from './shadow-job-options'

afterEach(() => {
  for (const key of [...JOB_OPTION_KEYS, 'repeat', 'debounce']) {
    Reflect.deleteProperty(Object.prototype, key)
  }
})

describe('shadowJobOptions', () => {
  it('gives an own, non-enumerable undefined to every job option the options do not hold', () => {
    const opts = {}

    shadowJobOptions({ opts })

    for (const key of JOB_OPTION_KEYS) {
      expect(Object.getOwnPropertyDescriptor(opts, key)).toEqual({
        value: undefined,
        enumerable: false,
        writable: true,
        configurable: true,
      })
    }
    expect(Object.keys(opts)).toEqual([])
  })

  it('leaves the values the producer set, and their enumerability, alone', () => {
    const opts: Record<string, unknown> = { attempts: 3 }
    Object.defineProperty(opts, 'delay', { value: 7, enumerable: false })

    shadowJobOptions({ opts })

    expect(Object.getOwnPropertyDescriptor(opts, 'attempts')).toEqual({
      value: 3,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    expect(Object.getOwnPropertyDescriptor(opts, 'delay')).toEqual({
      value: 7,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  })

  it('stops a key planted afterwards from being found through the options', () => {
    const opts = {} as Record<string, unknown>
    shadowJobOptions({ opts })

    ;(Object.prototype as Record<string, unknown>).removeOnFail = true

    expect(opts.removeOnFail).toBeUndefined()
  })

  it('tolerates a job without options', () => {
    expect(() => {
      shadowJobOptions({})
    }).not.toThrow()
  })

  it('gives `repeat`, which BullMQ reads after a scheduler job completes, an own non-enumerable undefined', () => {
    const opts = {}

    shadowJobOptions({ opts })

    expect(Object.getOwnPropertyDescriptor(opts, 'repeat')).toEqual({
      value: undefined,
      enumerable: false,
      writable: true,
      configurable: true,
    })
  })

  it('stops a `repeat` planted afterwards from being found through the options', () => {
    const opts = {} as Record<string, unknown>
    shadowJobOptions({ opts })

    ;(Object.prototype as Record<string, unknown>).repeat = { every: 1 }

    expect(opts.repeat).toBeUndefined()
  })

  it('leaves `debounce` without an own property, because BullMQ asks whether the job holds it of its own', () => {
    const opts = {} as Record<string, unknown>

    shadowJobOptions({ opts })

    expect(Object.hasOwn(opts, 'debounce')).toBe(false)
    // A planted `debounce` is therefore found through the options; BullMQ's own-property check is
    // what keeps it from being read as the job's.
    ;(Object.prototype as Record<string, unknown>).debounce = { id: 'x' }
    expect(opts.debounce).toEqual({ id: 'x' })
    expect(Object.hasOwn(opts, 'debounce')).toBe(false)
  })

  describe('with a built-in replaced after the module loaded', () => {
    /** Run the shadow while `restore`-able replacement is in place and assert every own key exists. */
    function shadowedWhile(replace: () => () => void): void {
      const opts = {}
      const restore = replace()
      try {
        shadowJobOptions({ opts })
      } finally {
        restore()
      }
      for (const key of [...JOB_OPTION_KEYS, 'repeat']) {
        expect(Object.hasOwn(opts, key)).toBe(true)
      }
    }

    it('still shadows when Object.hasOwn is replaced', () => {
      shadowedWhile(() => {
        const original = Object.hasOwn
        Object.hasOwn = () => true
        return () => {
          Object.hasOwn = original
        }
      })
    })

    it('still shadows when Object.defineProperty is replaced', () => {
      shadowedWhile(() => {
        const original = Object.defineProperty
        Object.defineProperty = (() => {
          throw new Error('replaced')
        }) as typeof Object.defineProperty
        return () => {
          Object.defineProperty = original
        }
      })
    })

    it('still shadows when Array.prototype[Symbol.iterator] is replaced', () => {
      shadowedWhile(() => {
        const original = Array.prototype[Symbol.iterator]
        Array.prototype[Symbol.iterator] = function* empty() {
          // yields nothing
        } as typeof original
        return () => {
          Array.prototype[Symbol.iterator] = original
        }
      })
    })
  })
})
