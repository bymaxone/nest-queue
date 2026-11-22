/**
 * @fileoverview Unit tests for the registration options of `forRootAsync`: `isGlobal` is read by name,
 * so a key planted on the root prototype does not decide whether the module is global.
 * @layer server
 */

import { BymaxQueueModule } from './bymax-queue.module'

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
})
