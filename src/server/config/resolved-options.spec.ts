/**
 * @fileoverview Unit tests for default-merging into resolved options.
 * @layer server/config
 */

import type { Telemetry } from 'bullmq'
import { applyDefaults } from './resolved-options'
import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
} from '../constants/default-options'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'

const baseConnection: BymaxQueueModuleOptions['connection'] = { url: 'redis://localhost:6379' }

describe('applyDefaults', () => {
  it('fills every optional field with its default', () => {
    // A minimal config resolves to a fully-populated options object.
    const resolved = applyDefaults({ connection: baseConnection })

    expect(resolved.prefix).toBe('bull')
    expect(resolved.queueOptions).toEqual({})
    expect(resolved.flows).toEqual({ enabled: false })
    expect(resolved.metrics).toEqual({ enabled: false, cacheTtlMs: DEFAULT_METRICS_CACHE_TTL_MS })
    expect(resolved.shutdown).toEqual({
      drainTimeoutMs: DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
      drainOnShutdown: false,
    })
    expect(resolved.connectionReadyTimeoutMs).toBe(DEFAULT_CONNECTION_READY_TIMEOUT_MS)
    expect(resolved.defaultJobOptions).toEqual(DEFAULT_JOB_OPTIONS)
  })

  it('merges defaultJobOptions instead of replacing them', () => {
    // A consumer override keeps the unspecified defaults intact.
    const resolved = applyDefaults({
      connection: baseConnection,
      defaultJobOptions: { attempts: 7 },
    })

    expect(resolved.defaultJobOptions.attempts).toBe(7)
    expect(resolved.defaultJobOptions.backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff)
  })

  it('honors explicit overrides for every field', () => {
    // Explicit values win over defaults across the board.
    const resolved = applyDefaults({
      connection: baseConnection,
      prefix: 'tenant:foo',
      queueOptions: { streams: { events: { maxLen: 10 } } },
      flows: { enabled: true },
      metrics: { enabled: true, cacheTtlMs: 1234 },
      shutdown: { drainTimeoutMs: 5000, drainOnShutdown: true },
      connectionReadyTimeoutMs: 2500,
    })

    expect(resolved.prefix).toBe('tenant:foo')
    expect(resolved.flows.enabled).toBe(true)
    expect(resolved.metrics).toEqual({ enabled: true, cacheTtlMs: 1234 })
    expect(resolved.shutdown).toEqual({ drainTimeoutMs: 5000, drainOnShutdown: true })
    expect(resolved.connectionReadyTimeoutMs).toBe(2500)
  })

  it('omits telemetry when not provided', () => {
    // The telemetry key is absent unless the consumer opts in.
    const resolved = applyDefaults({ connection: baseConnection })
    expect('telemetry' in resolved).toBe(false)
  })

  it('passes telemetry through when provided', () => {
    // A supplied telemetry instance is carried into the resolved options.
    const telemetry = {} as Telemetry
    const resolved = applyDefaults({ connection: baseConnection, telemetry })
    expect(resolved.telemetry).toBe(telemetry)
  })

  it('returns a frozen object that rejects mutation', () => {
    // Freezing guards the resolved options against accidental mutation.
    const resolved = applyDefaults({ connection: baseConnection })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(() => {
      ;(resolved as { prefix: string }).prefix = 'mutated'
    }).toThrow(TypeError)
  })
})
