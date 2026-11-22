/**
 * @fileoverview Unit tests for options read by name when a key has been planted on the realm's root
 * prototype: a value nobody gave must not become a value of the options, whatever it is named. A
 * planted `drainOnShutdown` turns the shutdown drain on for every module, and a planted `shutdown`
 * brings a whole group; a getter or a Proxy answer that the host did give must still be read.
 * @layer server/config
 */

import { runInNewContext } from 'node:vm'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { applyDefaults } from './resolved-options'
import { snapshotWorkerOptions } from '../utils/snapshot-worker-options'
import { snapshotJobOptions, snapshotOptions } from './snapshot-options'

const connection = { url: 'redis://localhost:6379' }

/** Run `body` with `key` planted on the root prototype, and take it off again whatever happens. */
function withPlanted<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, enumerable: false })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('a key planted on the root prototype is not a value of the options', () => {
  it.each([
    ['shutdown', 'drainOnShutdown', true],
    ['flows', 'enabled', true],
    ['metrics', 'enabled', true],
  ])('does not read a planted %s.%s', (group, key, planted) => {
    const resolved = withPlanted(key, planted, () => applyDefaults({ connection, [group]: {} }))

    expect((resolved as unknown as Record<string, Record<string, unknown>>)[group]?.[key]).toBe(
      false,
    )
  })

  it('does not bring a planted group', () => {
    const copy = withPlanted('shutdown', { drainOnShutdown: true }, () =>
      snapshotOptions({ connection }),
    )

    expect(Object.keys(copy)).toEqual(['connection'])
    expect(applyDefaults({ connection }).shutdown.drainOnShutdown).toBe(false)
  })

  it('does not read a planted top-level key such as isGlobal or prefix', () => {
    const copy = withPlanted('prefix', 'planted', () =>
      withPlanted('isGlobal', true, () => snapshotOptions({ connection })),
    )

    expect(Object.keys(copy)).toEqual(['connection'])
  })

  it('does not read a planted job option', () => {
    const copy = withPlanted('attempts', 99, () => snapshotJobOptions({ delay: 5 }))

    expect(copy).toEqual({ delay: 5 })
  })

  it('does not read a key planted on the root prototype of another realm', () => {
    const foreign = runInNewContext('({ shutdown: {} })') as BymaxQueueModuleOptions
    const foreignRoot = Object.getPrototypeOf(foreign) as object
    Object.defineProperty(foreignRoot, 'drainOnShutdown', { value: true, configurable: true })
    const shutdown = (foreign as unknown as { shutdown: object }).shutdown

    const copy = snapshotOptions({ connection, shutdown })

    expect(copy.shutdown).toEqual({})
  })
})

describe('a value the host gave is still read', () => {
  it('reads a getter on the prototype of a class the host defined', () => {
    class Shutdown {
      private readonly enabled = true
      get drainOnShutdown(): boolean {
        return this.enabled
      }
    }

    const copy = snapshotOptions({ connection, shutdown: new Shutdown() })

    expect(copy.shutdown?.drainOnShutdown).toBe(true)
  })

  it('reads a field of a Proxy over an empty target that answers by its get trap', () => {
    const shutdown = new Proxy(
      {},
      { get: (_target, key) => (key === 'drainTimeoutMs' ? 5000 : undefined) },
    )

    const copy = snapshotOptions({ connection, shutdown })

    expect(copy.shutdown?.drainTimeoutMs).toBe(5000)
  })

  it('does not read a field from an ancestor the host built with no prototype', () => {
    // Flipped: it cannot be told from a root prototype without reading the root's own properties,
    // and `constructor` is one a polluted root can answer for.
    const ancestor = Object.assign(Object.create(null) as object, { drainTimeoutMs: 7000 })
    const shutdown = Object.create(ancestor) as object

    const copy = snapshotOptions({ connection, shutdown })

    expect(copy.shutdown?.drainTimeoutMs).toBeUndefined()
  })

  it('reads a field of an object from another realm', () => {
    const shutdown = runInNewContext('({ drainTimeoutMs: 6000 })') as object

    const copy = snapshotOptions({ connection, shutdown })

    expect(copy.shutdown?.drainTimeoutMs).toBe(6000)
  })

  it('keeps a value the host planted on its own object as an own property', () => {
    const copy = withPlanted('drainOnShutdown', true, () =>
      snapshotOptions({ connection, shutdown: { drainOnShutdown: false } }),
    )

    expect(copy.shutdown?.drainOnShutdown).toBe(false)
  })
})

describe('what the root-prototype check keeps and drops', () => {
  it('keeps a value the host gave as its own when the root prototype holds the same one', () => {
    const copy = withPlanted('drainOnShutdown', true, () =>
      snapshotOptions({ connection, shutdown: { drainOnShutdown: true } }),
    )

    expect(copy.shutdown?.drainOnShutdown).toBe(true)
  })

  it('does not keep the answer of a Proxy over an empty target when the root holds the key', () => {
    // Flipped: what was planted is decided from the holder alone, never by comparing two reads.
    const shutdown = new Proxy(
      {},
      { get: (_t, key) => (key === 'drainTimeoutMs' ? 5000 : undefined) },
    )

    const copy = withPlanted('drainTimeoutMs', 1, () => snapshotOptions({ connection, shutdown }))

    expect(copy.shutdown?.drainTimeoutMs).toBeUndefined()
  })
})

describe('a root prototype whose constructor was overwritten is still the root', () => {
  /** Run `body` with the `constructor` of `root` replaced, and put it back whatever happens. */
  function withConstructorReplaced<T>(root: object, body: () => T): T {
    const saved = Object.getOwnPropertyDescriptor(root, 'constructor')
    Object.defineProperty(root, 'constructor', {
      value: function Other() {},
      configurable: true,
      writable: true,
    })
    try {
      return body()
    } finally {
      if (saved) Object.defineProperty(root, 'constructor', saved)
    }
  }

  it('does not read a planted key when Object.prototype.constructor was overwritten', () => {
    const resolved = withConstructorReplaced(Object.prototype, () =>
      withPlanted('drainOnShutdown', true, () => applyDefaults({ connection, shutdown: {} })),
    )

    expect(resolved.shutdown.drainOnShutdown).toBe(false)
  })

  it('does not read a planted key when the root of another realm lost its constructor', () => {
    const foreign = runInNewContext('({ shutdown: {} })') as { shutdown: object }
    const foreignRoot = Object.getPrototypeOf(foreign) as object
    Object.defineProperty(foreignRoot, 'drainOnShutdown', { value: true, configurable: true })

    const copy = withConstructorReplaced(foreignRoot, () =>
      snapshotOptions({ connection, shutdown: foreign.shutdown }),
    )

    expect(copy.shutdown).toEqual({})
  })

  it('copies no field of a polluted root whose constructor was overwritten', () => {
    const copy = withConstructorReplaced(Object.prototype, () =>
      withPlanted('prefix', 'planted', () => snapshotOptions({ connection })),
    )

    expect(Object.keys(copy)).toEqual(['connection'])
  })
})

describe('a copy of job or worker options inherits nothing from the root prototype', () => {
  it('has no planted job option on a copy of an empty group', () => {
    const copy = withPlanted('attempts', 9, () => snapshotJobOptions({}))

    expect((copy as Record<string, unknown>).attempts).toBeUndefined()
    expect(Reflect.getPrototypeOf(copy)).toBeNull()
  })

  it('has no planted autorun on a copy of the options of a worker', () => {
    const copy = withPlanted('autorun', false, () => snapshotWorkerOptions({}))

    expect((copy as Record<string, unknown>).autorun).toBeUndefined()
    expect(Reflect.getPrototypeOf(copy)).toBeNull()
  })
})
