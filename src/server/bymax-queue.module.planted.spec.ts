/**
 * @fileoverview Unit tests for the registration options of `forRootAsync`: `isGlobal` is read by name,
 * so a key planted on the root prototype does not decide whether the module is global.
 * @layer server
 */

import { BymaxQueueModule, MODULE_OPTIONS_TOKEN } from './bymax-queue.module'

describe('forRootAsync does not take a planted isGlobal for the host’s', () => {
  it('registers the module as global when isGlobal is planted false and the host gave none', () => {
    Object.defineProperty(Object.prototype, 'isGlobal', {
      value: false,
      configurable: true,
      writable: true,
    })
    try {
      const sync = BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } })
      const asynchronous = BymaxQueueModule.forRootAsync({
        useFactory: () => ({ connection: { url: 'redis://localhost:6379' } }),
      })

      expect(asynchronous.global).toBe(sync.global)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'isGlobal')
    }
  })

  it('reads an isGlobal getter of the host once', () => {
    let reads = 0
    const options = { useFactory: () => ({ connection: { url: 'redis://localhost:6379' } }) }
    Object.defineProperty(options, 'isGlobal', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1
      },
    })

    const registered = BymaxQueueModule.forRootAsync(options)

    expect(reads).toBe(1)
    expect(registered.global).toBe(true)
  })
})

describe('forRootAsync keeps the registration fields of a class instance', () => {
  it('hands Nest the factory a class defines as a method, with isGlobal given', async () => {
    class Registration {
      readonly isGlobal = true
      useFactory(): { connection: { url: string } } {
        return { connection: { url: 'redis://localhost:6379' } }
      }
    }

    const registered = BymaxQueueModule.forRootAsync(new Registration())
    const provider = registered.providers?.find(
      (candidate) => (candidate as { provide?: unknown }).provide === MODULE_OPTIONS_TOKEN,
    ) as { useFactory: () => unknown }

    expect(await provider.useFactory()).toMatchObject({
      connection: { url: 'redis://localhost:6379' },
    })
    expect(registered.global).toBe(true)
  })
})
