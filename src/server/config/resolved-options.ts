/**
 * @fileoverview Fully-resolved module options with defaults applied.
 * @layer server/config
 */

import type { JobsOptions, QueueOptions, Telemetry } from 'bullmq'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueConnectionConfig } from '../interfaces/queue-connection.interface'
import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
} from '../constants/default-options'

/** Fully-resolved options — every optional field of the input is filled. */
export interface ResolvedQueueOptions {
  /** Connection configuration, passed through untouched. */
  connection: QueueConnectionConfig
  /** Default job options, merged over the library defaults. */
  defaultJobOptions: JobsOptions
  /** Redis key prefix. */
  prefix: string
  /** Extra Queue options applied to every queue. */
  queueOptions: Partial<Omit<QueueOptions, 'connection' | 'defaultJobOptions' | 'prefix'>>
  /** Flow support configuration. */
  flows: { enabled: boolean }
  /** Metrics support configuration. */
  metrics: { enabled: boolean; cacheTtlMs: number }
  /** Shutdown behavior configuration. */
  shutdown: { drainTimeoutMs: number; drainOnShutdown: boolean }
  /** Optional OpenTelemetry instance, attached to every Queue/Worker when present. */
  telemetry?: Telemetry
  /** Mode B ready timeout in milliseconds. */
  connectionReadyTimeoutMs: number
}

/**
 * Merge consumer options with the library defaults and freeze the result.
 * `defaultJobOptions` is merged (not replaced); `telemetry` is only present when
 * the consumer supplied it.
 *
 * @param opts - The validated module options.
 * @returns A frozen, fully-resolved options object.
 */
export function applyDefaults(opts: BymaxQueueModuleOptions): Readonly<ResolvedQueueOptions> {
  const base: ResolvedQueueOptions = {
    connection: opts.connection,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...(opts.defaultJobOptions ?? {}) },
    prefix: opts.prefix ?? 'bull',
    queueOptions: opts.queueOptions ?? {},
    flows: { enabled: opts.flows?.enabled ?? false },
    metrics: {
      enabled: opts.metrics?.enabled ?? false,
      cacheTtlMs: opts.metrics?.cacheTtlMs ?? DEFAULT_METRICS_CACHE_TTL_MS,
    },
    shutdown: {
      drainTimeoutMs: opts.shutdown?.drainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
      drainOnShutdown: opts.shutdown?.drainOnShutdown ?? false,
    },
    connectionReadyTimeoutMs:
      opts.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
  }
  if (opts.telemetry !== undefined) base.telemetry = opts.telemetry
  return Object.freeze(base)
}
