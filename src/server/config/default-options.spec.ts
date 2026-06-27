/**
 * @fileoverview Unit tests for the config-layer default-options alias.
 * @layer server/config
 */

import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
} from './default-options'

describe('config default-options alias', () => {
  it('re-exports every default constant with its expected value', () => {
    // The config layer surfaces the same constants as the constants layer.
    expect(DEFAULT_WORKER_CONCURRENCY).toBe(2)
    expect(DEFAULT_METRICS_CACHE_TTL_MS).toBe(5_000)
    expect(DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(30_000)
    expect(DEFAULT_CONNECTION_READY_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3)
  })
})
