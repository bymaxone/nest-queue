/**
 * @fileoverview Synchronous and asynchronous module configuration contracts.
 * @layer server/interfaces
 */

import type { ModuleMetadata, Type } from '@nestjs/common'
import type { JobsOptions, QueueOptions, Telemetry } from 'bullmq'
import type { QueueConnectionConfig } from './queue-connection.interface'

/**
 * Synchronous configuration for `BymaxQueueModule.forRoot()`.
 *
 * @example
 * BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } })
 */
export interface BymaxQueueModuleOptions {
  /** Redis connection configuration. Required. */
  connection: QueueConnectionConfig
  /** Default options applied to every job enqueued through the service. */
  defaultJobOptions?: JobsOptions
  /** Prefix for all Redis keys (multi-tenant isolation). Default: 'bull'. */
  prefix?: string
  /** Default options applied to every Queue, merged with the job/prefix defaults. */
  queueOptions?: Partial<Omit<QueueOptions, 'connection' | 'defaultJobOptions' | 'prefix'>>
  /** Flow Producer configuration. Opt-in. */
  flows?: { enabled?: boolean }
  /** Metrics collection configuration. Opt-in. */
  metrics?: { enabled?: boolean; cacheTtlMs?: number }
  /**
   * Opt-in OpenTelemetry — a BullMQ `Telemetry` (typically `new BullMQOtel(...)`
   * from the optional peer `bullmq-otel`); attached to every Queue and Worker.
   */
  telemetry?: Telemetry
  /** Behavior on application shutdown. */
  shutdown?: { drainTimeoutMs?: number; drainOnShutdown?: boolean }
  /**
   * Register the module globally. Mapped to `DynamicModule.global` by the
   * configurable module builder's `setExtras` (no hand-written `@Global`).
   * Default: true.
   */
  isGlobal?: boolean
  /** Mode B only: milliseconds to wait for Redis `ready` before throwing. Default: 10_000. */
  connectionReadyTimeoutMs?: number
}

/** A factory that produces module options, for async configuration. */
export interface BymaxQueueOptionsFactory {
  /** Build the module options synchronously or asynchronously. */
  createQueueOptions(): Promise<BymaxQueueModuleOptions> | BymaxQueueModuleOptions
}

/** Asynchronous configuration mirroring the NestJS async dynamic-module pattern. */
export interface BymaxQueueModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Factory returning the module options. */
  useFactory?: (...args: unknown[]) => Promise<BymaxQueueModuleOptions> | BymaxQueueModuleOptions
  /** Class implementing the options factory. */
  useClass?: Type<BymaxQueueOptionsFactory>
  /** Existing provider implementing the options factory. */
  useExisting?: Type<BymaxQueueOptionsFactory>
  /** Providers injected into the factory. */
  inject?: readonly (Type<unknown> | string | symbol)[]
}
