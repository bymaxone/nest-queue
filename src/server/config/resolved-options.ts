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
  const connection = opts.connection

  const base: Omit<ResolvedQueueOptions, 'connection'> &
    Partial<Pick<ResolvedQueueOptions, 'connection'>> = {
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
    connectionReadyTimeoutMs: opts.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
  }
  if (opts.telemetry !== undefined) base.telemetry = opts.telemetry

  // The connection carries the Redis credentials — a `url` holds the password
  // inline, an `options` object holds it as a field, and a bring-your-own
  // `client` holds both on the ioredis instance. This resolved object is
  // injected into QueueService, WorkerRegistry, QueueEventsRegistry and
  // QueueLifecycle, so an enumerable `connection` is emitted by anything that
  // serializes one of them incidentally: a structured logger rendering its
  // arguments, an error reporter capturing the scope of a throw. Attaching it
  // as a non-enumerable accessor withholds it from `JSON.stringify`, object
  // spread and `util.inspect` — including `showHidden`, which still prints a
  // hidden data property. Reads are unchanged.
  Object.defineProperty(base, 'connection', {
    get: (): QueueConnectionConfig => connection,
    enumerable: false,
    // Stryker disable next-line BooleanLiteral: equivalent HERE — this object is `Object.freeze`d on the way out, and freezing makes every property non-configurable regardless. The flag stays because it states the guarantee at the point the accessor is defined, and because the sibling packages that withhold secrets the same way are NOT frozen, where it is load-bearing
    configurable: false,
  })

  return Object.freeze(base) as Readonly<ResolvedQueueOptions>
}
