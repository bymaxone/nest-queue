/**
 * @fileoverview Unit tests for the timer-valued module options: the shutdown drain budget and the
 * startup ready wait must be delays Node honours, or the timer that enforces them fires at once.
 * @layer server/config
 */

import { validateOptions } from './validate-options'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueException } from '../errors/queue-exception'

/** The reason carried by the INVALID_OPTIONS exception `validate` throws, or undefined. */
function reasonOf(opts: BymaxQueueModuleOptions): string | undefined {
  try {
    validateOptions(opts)
  } catch (err) {
    const { error } = (err as QueueException).getResponse() as {
      error: { details: { reason: string } }
    }
    return error.details.reason
  }
  return undefined
}

const base = { connection: { url: 'redis://x' } } as const

describe('validateOptions — timer-valued options', () => {
  it.each([0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses shutdown.drainTimeoutMs %s',
    (bad) => {
      // Node reads a delay above 2^31 - 1 as 1 ms, and NaN as 1 ms: the drain would end at once.
      expect(reasonOf({ ...base, shutdown: { drainTimeoutMs: bad } })).toMatch(
        /^shutdown\.drainTimeoutMs must be (> 0|a whole number from 1 to 2147483647)$/,
      )
    },
  )

  it.each([0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, 0, -1])(
    'refuses connectionReadyTimeoutMs %s, and says the range',
    (bad) => {
      expect(reasonOf({ ...base, connectionReadyTimeoutMs: bad })).toBe(
        'connectionReadyTimeoutMs must be a whole number from 1 to 2147483647',
      )
    },
  )

  it.each([1, 2_147_483_647])('accepts %s for both, the ends of the supported range', (ok) => {
    expect(
      reasonOf({ ...base, shutdown: { drainTimeoutMs: ok }, connectionReadyTimeoutMs: ok }),
    ).toBeUndefined()
  })

  it('names the non-whole drain value, not only "> 0"', () => {
    expect(reasonOf({ ...base, shutdown: { drainTimeoutMs: 0.5 } })).toBe(
      'shutdown.drainTimeoutMs must be a whole number from 1 to 2147483647',
    )
  })
})
