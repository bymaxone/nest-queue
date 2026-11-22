/**
 * @fileoverview Unit tests for the copy of a host object whose fields go on to a driver: every own
 * field and every field of an ancestor below the realm's root, read once, as an enumerable data
 * property of a copy with no prototype.
 * @layer server/config
 */

import { copyFields } from './read-by-name'

describe('copyFields', () => {
  it.each([
    ['a string', 'x'],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2]],
  ])('returns %s as it is, for validation to judge', (_label, value) => {
    expect(copyFields(value)).toBe(value)
  })

  it('copies the own fields, symbols included, as enumerable data properties of a copy with no prototype', () => {
    const symbol = Symbol('tls')
    const copy = copyFields({ host: 'redis', [symbol]: 1 })

    expect(Object.getPrototypeOf(copy)).toBeNull()
    expect({ ...copy }).toEqual({ host: 'redis', [symbol]: 1 })
  })

  it('reads a getter a class defines, and the own field wins over the one the class defines', () => {
    class Base {
      private readonly text = 'from the class'
      get password(): string {
        return this.text
      }
      get host(): string {
        return this.text
      }
    }
    const instance = Object.defineProperty(new Base(), 'host', { value: 'own', enumerable: true })

    const copy = copyFields<object>(instance) as Record<string, unknown>

    expect({ ...copy }).toEqual({ host: 'own', password: 'from the class', text: 'from the class' })
  })

  it('leaves the constructor and a key planted on the root prototype out', () => {
    Object.defineProperty(Object.prototype, 'planted', { value: 1, configurable: true })
    try {
      const copy = copyFields({ host: 'redis' })

      expect(Object.keys(copy as object)).toEqual(['host'])
      expect('constructor' in (copy as object)).toBe(false)
      expect((copy as Record<string, unknown>).planted).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'planted')
    }
  })

  it('reads each field once', () => {
    let reads = 0
    const source = {
      get host(): string {
        reads += 1
        return 'redis'
      },
    }

    copyFields(source)

    expect(reads).toBe(1)
  })
})

describe('copyFields — the shape of the copy', () => {
  it('copies an object that has no prototype, and ends at the end of its chain', () => {
    const source = Object.assign(Object.create(null) as object, { host: 'redis' })

    expect({ ...(copyFields(source) as object) }).toEqual({ host: 'redis' })
  })

  it('defines each field writable, configurable and enumerable', () => {
    const copy = copyFields({ host: 'redis' })

    expect(Object.getOwnPropertyDescriptor(copy, 'host')).toMatchObject({
      writable: true,
      configurable: true,
      enumerable: true,
    })
  })
})
