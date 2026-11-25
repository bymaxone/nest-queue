/**
 * @fileoverview Unit tests that every place the library defines a property survives a `get` or a `set`
 * planted on the root prototype: `Object.defineProperty` reads those names off its descriptor through
 * the chain, so a descriptor literal would turn a planted key into a raw `TypeError`, not a result.
 * @layer server/config
 */

import { QueueException } from '../errors/queue-exception'
import { guarded } from './guarded-read'
import { copyFields, defineOwn, descriptorOf } from './read-by-name'
import { applyDefaults } from './resolved-options'
import { snapshotOptions } from './snapshot-options'

const PLANTED_NAMES = ['get', 'set'] as const

/** Run `body` with `key` planted on the root prototype, and take it off again whatever happens. */
function withPlanted<T>(key: string, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    value: () => 'planted',
    configurable: true,
    writable: true,
  })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe.each(PLANTED_NAMES)('with %s planted on the root prototype', (name) => {
  it('descriptorOf hands defineProperty only the fields it was given', () => {
    const target = {}

    withPlanted(name, () => {
      Object.defineProperty(target, 'k', descriptorOf({ value: 1, configurable: true }))
    })

    expect(Object.getOwnPropertyDescriptor(target, 'k')).toEqual({
      value: 1,
      writable: false,
      enumerable: false,
      configurable: true,
    })
  })

  it('defineOwn writes an ordinary data property', () => {
    const target: Record<string, unknown> = {}

    withPlanted(name, () => {
      defineOwn(target, 'k', 1)
    })

    expect(Object.getOwnPropertyDescriptor(target, 'k')).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  })

  it('copyFields copies the fields of a host object', () => {
    const copy = withPlanted(name, () => copyFields({ a: 1, b: 2 }))

    expect({ ...copy }).toEqual({ a: 1, b: 2 })
  })

  it('snapshotOptions snapshots the options of a module', () => {
    const snapshot = withPlanted(name, () =>
      snapshotOptions({ connection: { url: 'redis://localhost:6379' } }),
    )

    expect(snapshot.connection).toEqual({ url: 'redis://localhost:6379' })
  })

  it('applyDefaults withholds the connection and still reads it', () => {
    const resolved = withPlanted(name, () =>
      applyDefaults({ connection: { url: 'redis://localhost:6379' } }),
    )

    expect(resolved.connection).toEqual({ url: 'redis://localhost:6379' })
    expect(Object.keys(resolved)).not.toContain('connection')
  })

  it('guarded refuses with the library refusal and keeps the host error as the cause', () => {
    const hostError = new Error('host')
    const refusal = withPlanted(name, () => {
      try {
        guarded('x', () => {
          throw hostError
        })
      } catch (error) {
        return error
      }
      return undefined
    })

    expect(refusal).toBeInstanceOf(QueueException)
    expect((refusal as QueueException).cause).toBe(hostError)
  })
})
