/**
 * @fileoverview Unit tests for the dynamic module registration.
 * @layer server/module
 */

import { Injectable, Module } from '@nestjs/common'
import type { FactoryProvider, Provider, ValueProvider } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DiscoveryModule } from '@nestjs/core'
import type { Redis } from 'ioredis'
import { BymaxQueueModule, MODULE_OPTIONS_TOKEN } from './bymax-queue.module'
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
import { QueueException } from './errors/queue-exception'
import type {
  BymaxQueueModuleOptions,
  BymaxQueueOptionsFactory,
} from './interfaces/queue-module-options.interface'

/** Test whether a provider targets the given injection token or class. */
function provides(provider: Provider, token: unknown): boolean {
  return typeof provider === 'function' ? provider === token : provider.provide === token
}

/** Find a provider by its token within a provider list. */
function findProvider(providers: Provider[], token: unknown): Provider | undefined {
  return providers.find((provider) => provides(provider, token))
}

const baseOptions: BymaxQueueModuleOptions = { connection: { url: 'redis://localhost:6379' } }

describe('BymaxQueueModule.forRoot', () => {
  it('registers the queue service, resolver, and option tokens', () => {
    // The module wires both services and both option tokens.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const providers = dynamic.providers ?? []

    expect(findProvider(providers, QueueService)).toBeDefined()
    expect(findProvider(providers, ConnectionResolver)).toBeDefined()
    expect(findProvider(providers, BYMAX_QUEUE_OPTIONS)).toBeDefined()
    expect(findProvider(providers, BYMAX_QUEUE_RESOLVED_OPTIONS)).toBeDefined()
  })

  it('exports the public services and tokens', () => {
    // Consumers can inject the services and option tokens.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)

    expect(dynamic.exports).toEqual([
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
    ])
  })

  it('registers the flow service via a resolver-bound factory', () => {
    // FlowService is always registered (guarded); the factory injects the resolver.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const provider = findProvider(dynamic.providers ?? [], FlowService) as FactoryProvider
    const resolver = { getClient: jest.fn() } as unknown as ConnectionResolver

    expect(provider.inject).toEqual([ConnectionResolver])
    expect(provider.useFactory(resolver)).toBeInstanceOf(FlowService)
  })

  it('registers the metrics service via a queue-service-bound factory', () => {
    // MetricsService is always registered (guarded); the factory injects QueueService.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const provider = findProvider(dynamic.providers ?? [], MetricsService) as FactoryProvider
    const queueService = {} as unknown as QueueService

    expect(provider.inject).toEqual([QueueService])
    expect(provider.useFactory(queueService)).toBeInstanceOf(MetricsService)
  })

  it('aliases the options token to the configurable module token', () => {
    // BYMAX_QUEUE_OPTIONS is a useExisting alias of the generated token.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const provider = findProvider(dynamic.providers ?? [], BYMAX_QUEUE_OPTIONS) as {
      useExisting: unknown
    }

    expect(provider.useExisting).toBe(MODULE_OPTIONS_TOKEN)
  })

  it('provides the frozen resolved options as a value', () => {
    // The resolved-options token carries a frozen defaults-applied object.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const provider = findProvider(dynamic.providers ?? [], BYMAX_QUEUE_RESOLVED_OPTIONS) as ValueProvider

    expect(Object.isFrozen(provider.useValue)).toBe(true)
    expect((provider.useValue as { prefix: string }).prefix).toBe('bull')
  })

  it('initializes the connection resolver through an async factory', async () => {
    // The resolver factory constructs and initializes a resolver from the options.
    const dynamic = BymaxQueueModule.forRoot({ connection: { client: makeReadyClient() } })
    const provider = findProvider(dynamic.providers ?? [], ConnectionResolver) as FactoryProvider

    const resolver = (await provider.useFactory(baseOptionsClientMode())) as ConnectionResolver
    expect(resolver).toBeInstanceOf(ConnectionResolver)
    expect(provider.inject).toEqual([BYMAX_QUEUE_OPTIONS])
  })

  it('exposes the resolved Redis client through a resolver-bound factory', () => {
    // The client token resolves to the resolver's Queue-role client so consumers can inject it.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const provider = findProvider(dynamic.providers ?? [], BYMAX_QUEUE_REDIS_CLIENT) as FactoryProvider
    const fakeClient = {} as Redis
    const resolver = { getClient: jest.fn().mockReturnValue(fakeClient) } as unknown as ConnectionResolver

    expect(provider.inject).toEqual([ConnectionResolver])
    expect(provider.useFactory(resolver)).toBe(fakeClient)
  })

  it('exposes the connection mode through a resolver-bound factory', () => {
    // The mode token resolves to the resolver's detected mode.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    const provider = findProvider(dynamic.providers ?? [], BYMAX_QUEUE_CONNECTION_MODE) as FactoryProvider
    const resolver = { getMode: jest.fn().mockReturnValue('mode-b-owned') } as unknown as ConnectionResolver

    expect(provider.inject).toEqual([ConnectionResolver])
    expect(provider.useFactory(resolver)).toBe('mode-b-owned')
  })

  it('marks the module global by default', () => {
    // isGlobal defaults to true, mapping to DynamicModule.global.
    const dynamic = BymaxQueueModule.forRoot(baseOptions)
    expect(dynamic.global).toBe(true)
  })

  it('respects isGlobal: false', () => {
    // An explicit false opts the module out of global registration.
    const dynamic = BymaxQueueModule.forRoot({ ...baseOptions, isGlobal: false })
    expect(dynamic.global).toBe(false)
  })

  it('throws via validateOptions for an invalid connection', () => {
    // Bootstrap validation fails fast on a malformed connection.
    expect(() => BymaxQueueModule.forRoot({ connection: {} as never })).toThrow(QueueException)
  })

  it('tolerates a base definition without providers', () => {
    // Defensive fallback when the configurable base omits the providers array.
    const parent = Object.getPrototypeOf(BymaxQueueModule) as { forRoot: (o: unknown) => unknown }
    const spy = jest.spyOn(parent, 'forRoot').mockReturnValue({ module: BymaxQueueModule })

    const dynamic = BymaxQueueModule.forRoot(baseOptions)

    expect(findProvider(dynamic.providers ?? [], QueueService)).toBeDefined()
    spy.mockRestore()
  })
})

/** A factory class for the `useClass`/`useExisting` async-registration paths. */
@Injectable()
class TestOptionsFactory implements BymaxQueueOptionsFactory {
  createQueueOptions(): BymaxQueueModuleOptions {
    return { connection: { client: makeReadyClient() } }
  }
}

/** A module that exports the factory so `useExisting` can resolve it. */
@Module({ providers: [TestOptionsFactory], exports: [TestOptionsFactory] })
class OptionsFactoryModule {}

/** Token for an externally-provided Mode-A client, used by the inject test. */
const INJECTED_CLIENT = Symbol('INJECTED_CLIENT')

/** A module that supplies a pre-built Mode-A client for the inject test. */
@Module({
  providers: [{ provide: INJECTED_CLIENT, useFactory: (): Redis => makeReadyClient() }],
  exports: [INJECTED_CLIENT],
})
class InjectedClientModule {}

describe('BymaxQueueModule.forRootAsync', () => {
  it('marks the module global by default', () => {
    // isGlobal defaults to true on the async path too.
    const dynamic = BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })
    expect(dynamic.global).toBe(true)
  })

  it('respects isGlobal: false', () => {
    // The async path honors an explicit opt-out from global registration.
    const dynamic = BymaxQueueModule.forRootAsync({
      isGlobal: false,
      useFactory: () => baseOptionsClientMode(),
    })
    expect(dynamic.global).toBe(false)
  })

  it('exports the same public services and tokens as forRoot', () => {
    // The observable export surface must match across both registration paths.
    const dynamic = BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })
    expect(dynamic.exports).toEqual(BymaxQueueModule.forRoot(baseOptionsClientMode()).exports)
  })

  it('aliases the options token to the configurable module token', () => {
    // BYMAX_QUEUE_OPTIONS is a useExisting alias of the generated token.
    const dynamic = BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })
    const provider = findProvider(dynamic.providers ?? [], BYMAX_QUEUE_OPTIONS) as {
      useExisting: unknown
    }
    expect(provider.useExisting).toBe(MODULE_OPTIONS_TOKEN)
  })

  it('derives resolved options from a factory injecting the options token', () => {
    // The resolved-options provider validates then applies defaults at runtime.
    const dynamic = BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })
    const provider = findProvider(
      dynamic.providers ?? [],
      BYMAX_QUEUE_RESOLVED_OPTIONS,
    ) as FactoryProvider
    expect(provider.inject).toEqual([MODULE_OPTIONS_TOKEN])
    const resolved = provider.useFactory(baseOptionsClientMode()) as { prefix: string }
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(resolved.prefix).toBe('bull')
  })

  it('registers FlowService and MetricsService as resolved-aware factories', () => {
    // The async path injects the resolved options into the conditional providers.
    const dynamic = BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })
    const flow = findProvider(dynamic.providers ?? [], FlowService) as FactoryProvider
    const metrics = findProvider(dynamic.providers ?? [], MetricsService) as FactoryProvider
    expect(flow.inject).toEqual([ConnectionResolver, BYMAX_QUEUE_RESOLVED_OPTIONS])
    expect(metrics.inject).toEqual([QueueService, BYMAX_QUEUE_RESOLVED_OPTIONS])
  })

  it('instantiates the full provider graph from a useFactory', async () => {
    // useFactory with no inject resolves the module and exposes QueueService.
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })],
    }).compile()
    expect(moduleRef.get(QueueService)).toBeInstanceOf(QueueService)
    await moduleRef.close()
  })

  it('integrates an external module via imports + inject', async () => {
    // The factory receives the injected dependency from an imported module.
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxQueueModule.forRootAsync({
          imports: [InjectedClientModule],
          inject: [INJECTED_CLIENT],
          useFactory: (client: unknown) => ({ connection: { client: client as Redis } }),
        }),
      ],
    }).compile()
    expect(moduleRef.get(ConnectionResolver).getMode()).toBe('mode-a-byo')
    await moduleRef.close()
  })

  it('registers options through a useClass factory', async () => {
    // useClass instantiates the factory and calls its createQueueOptions method.
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxQueueModule.forRootAsync({ useClass: TestOptionsFactory })],
    }).compile()
    expect(moduleRef.get(QueueService)).toBeInstanceOf(QueueService)
    await moduleRef.close()
  })

  it('reuses an existing factory provider via useExisting', async () => {
    // useExisting resolves the factory from an imported module that exports it.
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxQueueModule.forRootAsync({
          imports: [OptionsFactoryModule],
          useExisting: TestOptionsFactory,
        }),
      ],
    }).compile()
    expect(moduleRef.get(QueueService)).toBeInstanceOf(QueueService)
    await moduleRef.close()
  })

  it('rejects async options with no factory, class, or existing provider', async () => {
    // ConfigurableModuleBuilder cannot resolve options without one of the three.
    const build = async (): Promise<unknown> =>
      Test.createTestingModule({ imports: [BymaxQueueModule.forRootAsync({})] }).compile()
    await expect(build()).rejects.toThrow()
  })

  it('tolerates a base definition without providers or imports', () => {
    // Defensive fallback when the configurable base omits the providers/imports arrays.
    const parent = Object.getPrototypeOf(BymaxQueueModule) as {
      forRootAsync: (o: unknown) => unknown
    }
    const spy = jest.spyOn(parent, 'forRootAsync').mockReturnValue({ module: BymaxQueueModule })

    const dynamic = BymaxQueueModule.forRootAsync({ useFactory: () => baseOptionsClientMode() })

    expect(findProvider(dynamic.providers ?? [], QueueService)).toBeDefined()
    expect(dynamic.imports).toEqual([DiscoveryModule])
    spy.mockRestore()
  })
})

/** Build a ready ioredis-like client whose duplicate honors the null override. */
function makeReadyClient(): Redis {
  const probe = { options: { maxRetriesPerRequest: null }, disconnect: jest.fn() }
  const client = {
    status: 'ready',
    options: { maxRetriesPerRequest: null },
    duplicate: jest.fn().mockReturnValue(probe),
  }
  return client as unknown as Redis
}

/** Module options in Mode A for exercising the resolver factory. */
function baseOptionsClientMode(): BymaxQueueModuleOptions {
  return { connection: { client: makeReadyClient() } }
}
