/**
 * @fileoverview Unit tests for the own values a job's options carry while its handler runs.
 * @layer server/utils
 */

import { JOB_OPTION_KEYS } from '../config/snapshot-options'
import { shadowJobOptions } from './shadow-job-options'

afterEach(() => {
  for (const key of JOB_OPTION_KEYS) Reflect.deleteProperty(Object.prototype, key)
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
})
