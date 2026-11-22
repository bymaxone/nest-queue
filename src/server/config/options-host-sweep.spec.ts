/**
 * @fileoverview The Nth-operation sweep of the module options. Every object the host hands over is a
 * Proxy of one family whose Nth trap, counted across all of them, throws the host's own error, and
 * N runs over every operation that reading, validating and resolving the options performs. Each N
 * must end in the library's own refusal with the host's error as its cause, never the raw throw, and
 * once the options are read nothing may touch the host's objects again. The loop ends at the first N
 * that no trap reaches, so no read depends on a hand-written list of the places a host can throw.
 * @layer server/config
 */

import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { applyDefaults } from './resolved-options'
import { snapshotOptions } from './snapshot-options'
import { validateOptions } from './validate-options'

/** The traps a host object can run when the library reads it. */
const TRAPS = ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'] as const

/** One family of Proxies: the trap that is the `failAt`th overall throws `boom`. */
class TrapFamily {
  hits = 0
  constructor(
    private readonly failAt: number,
    readonly boom: Error,
  ) {}

  /** Wrap `target` so each of its traps counts, and the chosen one throws. */
  wrap<T extends object>(target: T): T {
    const handler: Record<string, (...args: unknown[]) => unknown> = {}
    for (const trap of TRAPS) {
      handler[trap] = (...args: unknown[]): unknown => {
        this.hits += 1
        if (this.hits === this.failAt) throw this.boom
        return (Reflect[trap] as (...a: unknown[]) => unknown)(...args)
      }
    }
    return new Proxy(target, handler)
  }
}

/** Options with every group a host object of the family, as a host's own module would hand them. */
function hostOptions(family: TrapFamily): BymaxQueueModuleOptions {
  return family.wrap({
    connection: family.wrap({ url: 'redis://localhost:6379' }),
    defaultJobOptions: family.wrap({
      attempts: 3,
      backoff: family.wrap({ type: 'fixed' as const, delay: 100 }),
    }),
    flows: family.wrap({ enabled: true }),
    metrics: family.wrap({ enabled: false, cacheTtlMs: 1000 }),
    shutdown: family.wrap({ drainTimeoutMs: 5000, drainOnShutdown: false }),
  })
}

/** What `forRoot` does with the options the host gave. */
function resolve(options: BymaxQueueModuleOptions): unknown {
  const snapshot = snapshotOptions(options)
  validateOptions(snapshot)
  return applyDefaults(snapshot)
}

/** The library's refusal and its cause, or `undefined` for a call that threw nothing. */
function refusalOf(run: () => unknown): { exception: QueueException; cause: unknown } | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    if (!(error instanceof QueueException)) throw error
    return { exception: error, cause: error.cause }
  }
}

describe('the options of a host whose Nth operation throws', () => {
  it('ends in the library refusal with the host error as the cause, for every N', () => {
    let operations = 0
    for (let failAt = 1; failAt < 500; failAt += 1) {
      const family = new TrapFamily(failAt, new Error(`host error at ${String(failAt)}`))
      const refusal = refusalOf(() => resolve(hostOptions(family)))
      if (refusal === undefined) {
        operations = family.hits
        break
      }
      const body = refusal.exception.getResponse() as { error: { code: string } }
      expect(body.error.code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
      expect(refusal.exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
      expect(refusal.cause).toBe(family.boom)
    }
    // An empty or tiny sweep would pass vacuously.
    expect(operations).toBeGreaterThan(15)
  })

  it('never reaches a host object again once the options are read', () => {
    const family = new TrapFamily(Number.MAX_SAFE_INTEGER, new Error('never'))
    const snapshot = snapshotOptions(hostOptions(family))
    const afterSnapshot = family.hits

    validateOptions(snapshot)
    const resolved = applyDefaults(snapshot) as { connection: { url: string } }
    expect(resolved.connection.url).toBe('redis://localhost:6379')

    expect(family.hits).toBe(afterSnapshot)
  })
})
