/**
 * @fileoverview Unit tests for the dynamic module registration.
 * @layer server/module
 */

import type { FactoryProvider, Provider, ValueProvider } from '@nestjs/common'
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
import { WorkerRegistry } from './services/worker-registry.service'
import { QueueEventsRegistry } from './services/queue-events-registry.service'
import { QueueException } from './errors/queue-exception'
import type { BymaxQueueModuleOptions } from './interfaces/queue-module-options.interface'

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
