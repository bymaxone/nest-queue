/**
 * @fileoverview Unit tests for default-merging into resolved options.
 * @layer server/config
 */

import { inspect } from 'node:util'

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

  it('keeps the connection out of every incidental serialization path', () => {
    // The resolved options are injected into QueueService, WorkerRegistry,
    // QueueEventsRegistry and QueueLifecycle, so whatever serializes one of
    // them incidentally reaches this object: a structured logger rendering its
    // arguments, an error reporter capturing the scope of a throw, an object
    // spread. A `url` carries the Redis password inline, which is why the
    // connection is the field that has to be withheld.
    const secret = 'r3d1sPassw0rd-canary'
    const resolved = applyDefaults({
      connection: { url: `redis://default:${secret}@127.0.0.1:6379` },
    })

    expect(JSON.stringify(resolved)).not.toContain(secret)
    expect(JSON.stringify({ ...resolved })).not.toContain(secret)
    expect(inspect(resolved, { depth: null })).not.toContain(secret)
    // `showHidden` is why the property is an accessor rather than merely a
    // non-enumerable value: a hidden data property is still printed here.
    expect(inspect(resolved, { depth: null, showHidden: true })).not.toContain(secret)
    expect(Object.keys(resolved)).not.toContain('connection')
  })

  it('still exposes the connection to the resolver that has to dial Redis', () => {
    // Containment must cost nothing at the supported surface: ConnectionResolver
    // reads this to build the client, so withholding it from serialization must
    // not withhold it from property access.
    const connection: BymaxQueueModuleOptions['connection'] = { url: 'redis://localhost:6379' }
    const resolved = applyDefaults({ connection })

    expect(resolved.connection).toBe(connection)
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
