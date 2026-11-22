/**
 * @fileoverview Unit tests for the places that read a name of a host object and must not take a key
 * planted on the root prototype for the host's: the entries of a bulk list, the parts of a connection,
 * and a getter that answers differently each time it is read.
 * @layer server/config
 */

import { readBulkJobs } from '../utils/read-bulk-jobs'
import { readByName } from './read-by-name'
import { snapshotOptions } from './snapshot-options'
import { validateOptions } from './validate-options'

/** Run `body` with `key` planted on the root prototype, and take it off again whatever happens. */
function withPlanted<T>(key: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('readByName decides what was planted from the holder alone', () => {
  it('does not read, or run, a getter planted on the root prototype', () => {
    let runs = 0
    Object.defineProperty(Object.prototype, 'zzPlanted', {
      get: () => (runs += 1),
      configurable: true,
    })
    try {
      expect(readByName({}, 'zzPlanted')).toBeUndefined()
      expect(runs).toBe(0)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzPlanted')
    }
  })

  it('reads a getter of a class of the host once, and keeps its answer', () => {
    let runs = 0
    class Group {
      get size(): number {
        runs += 1
        return runs === 1 ? 7 : 9999
      }
    }

    expect(readByName(new Group(), 'size')).toBe(7)
    expect(runs).toBe(1)
  })

  it('reads an own getter once', () => {
    let runs = 0
    const group = Object.defineProperty({}, 'size', {
      get: () => (runs += 1),
      enumerable: true,
    })

    expect(readByName(group, 'size')).toBe(1)
    expect(runs).toBe(1)
  })
})

describe('a bulk entry reads name, data and options by name', () => {
  it.each(['name', 'data', 'options'])('does not take a planted %s for the entry’s own', (key) => {
    const entry = { name: 'job', data: { a: 1 } } as Record<string, unknown>
    Reflect.deleteProperty(entry, key)

    const [copy] = withPlanted(key, { planted: true }, () => readBulkJobs([entry as never], 10))

    expect((copy as unknown as Record<string, unknown>)[key]).toBeUndefined()
  })

  it('keeps the entry’s own options', () => {
    const [copy] = withPlanted('options', { attempts: 99 }, () =>
      readBulkJobs([{ name: 'job', data: {}, options: { delay: 5 } }], 10),
    )

    expect(copy?.options).toEqual({ delay: 5 })
  })
})

describe('a connection reads client, url and options by name', () => {
  it.each(['client', 'options'])('does not see a planted %s next to a url', (key) => {
    const copy = withPlanted(key, { planted: true }, () =>
      snapshotOptions({ connection: { url: 'redis://localhost:6379' } }),
    )

    expect(Object.keys(copy.connection as object)).toEqual(['url'])
    expect(() => {
      withPlanted(key, { planted: true }, () => {
        validateOptions(copy)
      })
    }).not.toThrow()
  })

  it('does not see a planted url next to client options', () => {
    const copy = withPlanted('url', 'redis://planted', () =>
      snapshotOptions({ connection: { options: { host: 'localhost' } } }),
    )

    expect(Object.keys(copy.connection as object)).toEqual(['options'])
  })
})
