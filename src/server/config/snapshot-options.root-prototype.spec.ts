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

  it('reads a field from an ancestor the host built with no prototype', () => {
    const ancestor = Object.assign(Object.create(null) as object, { drainTimeoutMs: 7000 })
    const shutdown = Object.create(ancestor) as object

    const copy = snapshotOptions({ connection, shutdown })

    expect(copy.shutdown?.drainTimeoutMs).toBe(7000)
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
