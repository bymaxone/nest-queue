/**
 * @fileoverview The root dynamic module, built on ConfigurableModuleBuilder.
 * Registers the connection resolver, queue service, worker registry, queue-events
 * registry, processor discovery, and the graceful-shutdown lifecycle. Maps
 * `isGlobal` to `DynamicModule.global` via `setExtras` (no hand-written
 * `@Global`). Exposes `forRoot` (synchronous) and `forRootAsync`
 * (factory/class/existing) registration with an identical provider graph.
 * @layer server/module
 */

import {
  ConfigurableModuleBuilder,
  type DynamicModule,
  Module,
  type Provider,
} from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import type { Redis } from 'ioredis'
import type { BymaxQueueModuleOptions } from './interfaces/queue-module-options.interface'
import type { QueueConnectionMode } from './interfaces/queue-connection.interface'
import { validateOptions } from './config/validate-options'
import { applyDefaults, type ResolvedQueueOptions } from './config/resolved-options'
import {
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_RESOLVED_OPTIONS,
  BYMAX_QUEUE_REDIS_CLIENT,
  BYMAX_QUEUE_CONNECTION_MODE,
} from './bymax-queue.constants'
import { ConnectionResolver } from './services/connection-resolver.service'
import { QueueService } from './services/queue.service'
import { FlowService } from './services/flow.service'
import { MetricsService } from './services/metrics.service'
import { WorkerRegistry } from './services/worker-registry.service'
import { QueueEventsRegistry } from './services/queue-events-registry.service'
import { ProcessorDiscoveryService } from './services/processor-discovery.service'
import { QueueLifecycle } from './lifecycle/queue-lifecycle.service'

/** Generated configurable-module artifacts; `forRoot`/`forRootAsync` register the module. */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<BymaxQueueModuleOptions>({ moduleName: 'BymaxQueue' })
    .setClassMethodName('forRoot')
    .setFactoryMethodName('createQueueOptions')
    .setExtras({ isGlobal: true }, (definition, extras) => ({
      ...definition,
      global: extras.isGlobal,
    }))
    .build()

/**
 * Root module for the queue library. Use `forRoot` for synchronous registration
 * or `forRootAsync` when the options depend on other modules.
 *
 * @example Synchronous
 * BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } })
 * @example Asynchronous (Mode A — bring your own client)
 * BymaxQueueModule.forRootAsync({
 *   inject: [REDIS_CLIENT],
 *   useFactory: (client: Redis) => ({ connection: { client } }),
 * })
 */
@Module({})
export class BymaxQueueModule extends ConfigurableModuleClass {
  /**
   * Synchronous registration. Validates options, resolves defaults, and wires the
   * connection resolver (initialized via async factory), the queue service, the
   * worker registry, the queue-events registry, processor discovery, and the
   * graceful-shutdown lifecycle.
   *
   * @param options - Static module options.
   * @returns The configured dynamic module.
   */
  static override forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    validateOptions(options)
    const resolved = applyDefaults(options)
    const base = super.forRoot(options)

    return {
      ...base,
      imports: [DiscoveryModule],
      providers: [
        ...(base.providers ?? []),
        { provide: BYMAX_QUEUE_RESOLVED_OPTIONS, useValue: resolved },
        {
          provide: FlowService,
          useFactory: (conn: ConnectionResolver): FlowService =>
            new FlowService(conn, resolved.flows.enabled, resolved.prefix, resolved.telemetry),
          inject: [ConnectionResolver],
        },
        {
          provide: MetricsService,
          useFactory: (qs: QueueService): MetricsService =>
            new MetricsService(qs, resolved.metrics.enabled, resolved.metrics.cacheTtlMs),
          inject: [QueueService],
        },
        ...BymaxQueueModule.buildCoreProviders(),
      ],
      exports: BymaxQueueModule.buildExports(),
    }
  }

  /**
   * Asynchronous registration. Use when options depend on other modules
   * (ConfigService, BymaxCacheModule, etc.). Mirrors the NestJS standard async
   * dynamic-module pattern (`useFactory` | `useClass` | `useExisting` + `inject`)
   * and registers the same provider graph and exports as {@link forRoot}, with
   * `global` applied from the `isGlobal` extra. The resolved options and the
   * initialized connection are derived from the async-resolved options at runtime.
   *
   * @param options - Asynchronous module options.
   * @returns The configured dynamic module.
   */
  static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
    const base = super.forRootAsync(options)

    return {
      ...base,
      imports: [DiscoveryModule, ...(base.imports ?? [])],
      providers: [
        ...(base.providers ?? []),
        {
          provide: BYMAX_QUEUE_RESOLVED_OPTIONS,
          useFactory: (opts: BymaxQueueModuleOptions): Readonly<ResolvedQueueOptions> => {
            validateOptions(opts)
            return applyDefaults(opts)
          },
          inject: [MODULE_OPTIONS_TOKEN],
        },
        {
          provide: FlowService,
          useFactory: (conn: ConnectionResolver, resolved: ResolvedQueueOptions): FlowService =>
            new FlowService(conn, resolved.flows.enabled, resolved.prefix, resolved.telemetry),
          inject: [ConnectionResolver, BYMAX_QUEUE_RESOLVED_OPTIONS],
        },
        {
          provide: MetricsService,
          useFactory: (qs: QueueService, resolved: ResolvedQueueOptions): MetricsService =>
            new MetricsService(qs, resolved.metrics.enabled, resolved.metrics.cacheTtlMs),
          inject: [QueueService, BYMAX_QUEUE_RESOLVED_OPTIONS],
        },
        ...BymaxQueueModule.buildCoreProviders(),
      ],
      exports: BymaxQueueModule.buildExports(),
    }
  }

  /**
   * Providers shared verbatim by both registration paths: the options alias, the
   * initialized connection resolver, the resolved client/mode tokens, and the
   * singleton services. `BYMAX_QUEUE_RESOLVED_OPTIONS`, `FlowService`, and
   * `MetricsService` are intentionally omitted — they differ per path.
   *
   * @returns The shared provider list.
   */
  private static buildCoreProviders(): Provider[] {
    return [
      { provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN },
      {
        provide: ConnectionResolver,
        useFactory: async (opts: BymaxQueueModuleOptions): Promise<ConnectionResolver> => {
          const resolver = new ConnectionResolver(opts)
          await resolver.init()
          return resolver
        },
        inject: [BYMAX_QUEUE_OPTIONS],
      },
      {
        provide: BYMAX_QUEUE_REDIS_CLIENT,
        useFactory: (resolver: ConnectionResolver): Redis => resolver.getClient(),
        inject: [ConnectionResolver],
      },
      {
        provide: BYMAX_QUEUE_CONNECTION_MODE,
        useFactory: (resolver: ConnectionResolver): QueueConnectionMode => resolver.getMode(),
        inject: [ConnectionResolver],
      },
      QueueService,
      WorkerRegistry,
      QueueEventsRegistry,
      ProcessorDiscoveryService,
      QueueLifecycle,
    ]
  }

  /**
   * The public exports shared by both registration paths.
   *
   * @returns A fresh exports list (services and injection tokens).
   */
  private static buildExports(): NonNullable<DynamicModule['exports']> {
    return [
      QueueService,
      FlowService,
      MetricsService,
      ConnectionResolver,
      WorkerRegistry,
      QueueEventsRegistry,
      BYMAX_QUEUE_OPTIONS,
      BYMAX_QUEUE_RESOLVED_OPTIONS,
      BYMAX_QUEUE_REDIS_CLIENT,
      BYMAX_QUEUE_CONNECTION_MODE,
    ]
  }
}
