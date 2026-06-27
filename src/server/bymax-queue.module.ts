/**
 * @fileoverview The root dynamic module, built on ConfigurableModuleBuilder.
 * Registers the connection resolver, queue service, and option tokens, mapping
 * `isGlobal` to `DynamicModule.global` via `setExtras` (no `@Global`).
 * @layer server/module
 */

import {
  ConfigurableModuleBuilder,
  type DynamicModule,
  Module,
  type Provider,
} from '@nestjs/common'
import type { Redis } from 'ioredis'
import type { BymaxQueueModuleOptions } from './interfaces/queue-module-options.interface'
import type { QueueConnectionMode } from './interfaces/queue-connection.interface'
import { validateOptions } from './config/validate-options'
import { applyDefaults } from './config/resolved-options'
import {
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_RESOLVED_OPTIONS,
  BYMAX_QUEUE_REDIS_CLIENT,
  BYMAX_QUEUE_CONNECTION_MODE,
} from './bymax-queue.constants'
import { ConnectionResolver } from './services/connection-resolver.service'
import { QueueService } from './services/queue.service'

/** Generated configurable-module artifacts; `forRoot` is the registration method. */
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<BymaxQueueModuleOptions>({ moduleName: 'BymaxQueue' })
    .setClassMethodName('forRoot')
    .setExtras({ isGlobal: true }, (definition, extras) => ({
      ...definition,
      global: extras.isGlobal,
    }))
    .build()

/**
 * Root module for the queue library. Use `forRoot` for synchronous registration.
 *
 * @example
 * BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } })
 */
@Module({})
export class BymaxQueueModule extends ConfigurableModuleClass {
  /**
   * Synchronous registration. Validates options, resolves defaults, and wires the
   * connection resolver (initialized via async factory), the queue service, and
   * the option tokens.
   *
   * @param options - Static module options.
   * @returns The configured dynamic module.
   */
  static override forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    validateOptions(options)
    const resolved = applyDefaults(options)
    const base = super.forRoot(options)

    const providers: Provider[] = [
      ...(base.providers ?? []),
      { provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN },
      { provide: BYMAX_QUEUE_RESOLVED_OPTIONS, useValue: resolved },
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
    ]

    return {
      ...base,
      providers,
      exports: [
        QueueService,
        ConnectionResolver,
        BYMAX_QUEUE_OPTIONS,
        BYMAX_QUEUE_RESOLVED_OPTIONS,
        BYMAX_QUEUE_REDIS_CLIENT,
        BYMAX_QUEUE_CONNECTION_MODE,
      ],
    }
  }
}
