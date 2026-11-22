/**
 * @fileoverview Unit tests for the places that read a name of a host object and must not take a key
 * planted on the root prototype for the host's: the entries of a bulk list, the parts of a connection,
 * and a getter that answers differently each time it is read.
 * @layer server/config
 */

import { readBulkJobs } from '../utils/read-bulk-jobs'
import { readByName, splitField } from './read-by-name'
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

describe('splitField takes one field out and copies the rest, each read once', () => {
  /** An object whose fields are counting getters, each answering differently after its first read. */
  function counting(names: string[]): { host: object; reads: Record<string, number> } {
    const reads: Record<string, number> = {}
    const host = {}
    for (const name of names) {
      Object.defineProperty(host, name, {
        enumerable: true,
        get: () => {
          reads[name] = (reads[name] ?? 0) + 1
          return reads[name] === 1
        },
      })
    }
    return { host, reads }
  }

  it('reads the named field once and every other field once', () => {
    const { host, reads } = counting(['isGlobal', 'other'])

    const { value, rest } = splitField(host, 'isGlobal')

    expect(reads).toEqual({ isGlobal: 1, other: 1 })
    expect(value).toBe(true)
    expect(rest).toEqual({ other: true })
  })

  it('does not take a planted value for the named field and never runs a planted getter', () => {
    let runs = 0
    Object.defineProperty(Object.prototype, 'zzNamed', {
      get: () => (runs += 1),
      configurable: true,
    })
    try {
      expect(splitField({ a: 1 }, 'zzNamed')).toEqual({ value: undefined, rest: { a: 1 } })
      expect(runs).toBe(0)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzNamed')
    }
  })

  it('reads the named field from a class getter of the host', () => {
    class Host {
      get named(): string {
        return `from ${this.constructor.name}`
      }
    }

    expect(splitField(new Host(), 'named').value).toBe('from Host')
  })

  it('keeps symbols and a __proto__ key as keys of a copy with no prototype, and skips what is not enumerable', () => {
    const symbol = Symbol('s')
    const host = Object.defineProperty(
      JSON.parse('{"__proto__": 1, "kept": 2}') as Record<PropertyKey, unknown>,
      'hidden',
      { value: 3, enumerable: false },
    )
    host[symbol] = 4

    const { rest } = splitField(host, 'named')

    expect(Reflect.getPrototypeOf(rest)).toBeNull()
    expect(Reflect.ownKeys(rest).map(String).sort()).toEqual(['Symbol(s)', '__proto__', 'kept'])
  })

  it('lets a throwing getter of the host escape for the caller’s guard to refuse', () => {
    const boom = new Error('host')
    const host = Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => {
        throw boom
      },
    })

    expect(() => splitField(host, 'named')).toThrow(boom)
  })

  it('reads a known name by name, once, when the host holds it as a class method', () => {
    class Host {
      method(): string {
        return 'method'
      }
    }

    const { rest } = splitField(new Host(), 'named', ['method', 'absent'])

    expect(Object.keys(rest)).toEqual(['method'])
  })

  it('does not read a known name again when it is an own field, or when it is the named one', () => {
    const { host, reads } = counting(['own', 'named'])

    const { rest } = splitField(host, 'named', ['own', 'named'])

    expect(reads).toEqual({ own: 1, named: 1 })
    expect(Object.keys(rest)).toEqual(['own'])
  })

  it('does not take a planted known name for the host’s', () => {
    Object.defineProperty(Object.prototype, 'zzKnown', { value: 1, configurable: true })
    try {
      expect(Object.keys(splitField({}, 'named', ['zzKnown']).rest)).toEqual([])
    } finally {
      Reflect.deleteProperty(Object.prototype, 'zzKnown')
    }
  })
})
