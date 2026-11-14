/**
 * @fileoverview Unit tests for the library's default job options.
 * @layer server/constants
 */

import { Backoffs } from 'bullmq'
import { DEFAULT_JOB_OPTIONS } from './default-options'

describe('DEFAULT_JOB_OPTIONS backoff', () => {
  // Retries that all share one delay arrive in lock-step waves after an outage; the default
  // strategy must spread them.
  it('spreads the delay of a retry across half of the computed value', async () => {
    const { delay, jitter } = DEFAULT_JOB_OPTIONS.backoff
    const strategy = Backoffs.builtinStrategies.exponential?.(delay, jitter)
    if (strategy === undefined) throw new Error('no exponential strategy')

    const samples = await Promise.all(Array.from({ length: 400 }, async () => strategy(1)))

    expect(Math.min(...samples)).toBeGreaterThanOrEqual(delay / 2)
    expect(Math.max(...samples)).toBeLessThanOrEqual(delay)
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(delay / 4)
  })

  it('still grows exponentially with the attempt number', async () => {
    const { delay, jitter } = DEFAULT_JOB_OPTIONS.backoff
    const strategy = Backoffs.builtinStrategies.exponential?.(delay, jitter)
    if (strategy === undefined) throw new Error('no exponential strategy')

    const third = await strategy(3)
    expect(third).toBeGreaterThanOrEqual((delay * 4) / 2)
    expect(third).toBeLessThanOrEqual(delay * 4)
  })
})
