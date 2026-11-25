/**
 * @fileoverview Unit tests that each field of an asynchronous registration is read when the host
 * defines it as a getter on a class prototype, as a class instance does. Each name is pinned by a
 * row of its own, so a name dropped from the list the module reads fails exactly one row.
 * @layer server
 */

import { BymaxQueueModule } from './bymax-queue.module'

class Token {}
class OptionsFactory {
  createOptions(): { connection: { url: string } } {
    return { connection: { url: 'redis://localhost:6379' } }
  }
}

/** A host with no own field, whose `name` is a getter on its class prototype. */
function hostWith(name: string, value: unknown, own: object = {}): never {
  class Host {
    constructor() {
      Object.assign(this, own)
    }
  }
  Object.defineProperty(Host.prototype, name, { get: () => value, configurable: true })
  return new Host() as never
}

/** The providers of the registration, by the token they provide. */
function providers(host: never): { provide: unknown; inject?: unknown[]; useClass?: unknown }[] {
  return (BymaxQueueModule.forRootAsync(host).providers ?? []) as never
}

describe('the fields of a registration that are getters on a class prototype', () => {
  it('reads imports', () => {
    expect(BymaxQueueModule.forRootAsync(hostWith('imports', [Token])).imports).toContain(Token)
  })

  it('reads inject', () => {
    const holder = providers(
      hostWith('inject', [Token], {
        useFactory: () => ({ connection: { url: 'redis://localhost:6379' } }),
      }),
    ).find((provider) => provider.inject?.[0] === Token)

    expect(holder).toBeDefined()
  })

  it('reads useClass', () => {
    const provider = providers(hostWith('useClass', OptionsFactory)).find(
      (candidate) => candidate.useClass === OptionsFactory,
    )

    expect(provider).toBeDefined()
  })

  it('reads useExisting', () => {
    const holder = providers(hostWith('useExisting', OptionsFactory)).find(
      (provider) => provider.inject?.[0] === OptionsFactory,
    )

    expect(holder).toBeDefined()
  })

  it('reads provideInjectionTokensFrom', () => {
    const source = { provide: Token, useValue: 1 }
    const host = hostWith('provideInjectionTokensFrom', [source], {
      inject: [Token],
      useFactory: () => ({ connection: { url: 'redis://localhost:6379' } }),
    })

    expect(providers(host)).toContain(source)
  })
})
