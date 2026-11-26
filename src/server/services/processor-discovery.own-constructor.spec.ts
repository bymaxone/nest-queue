/**
 * @fileoverview Discovery registers a `@Processor` only for a value with the class's prototype in
 * its chain, whatever the value says its `constructor` is.
 * @layer server/services
 */

import 'reflect-metadata'
import { DiscoveryModule, type DiscoveryService } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { Job } from 'bullmq'
import { ProcessorDiscoveryService } from './processor-discovery.service'
import { WorkerRegistry } from './worker-registry.service'
import { QueueEventsRegistry } from './queue-events-registry.service'
import { Processor } from '../decorators/processor.decorator'
import { Process } from '../decorators/process.decorator'

@Processor('named', { concurrency: 1 })
class NamedProcessor {
  @Process()
  handle(_job: Job): Promise<void> {
    return Promise.resolve()
  }
}

/** Run discovery over the given provider values and return the `register` mock. */
function discover(...instances: object[]): jest.Mock {
  const register = jest.fn().mockReturnValue({ on: jest.fn() })
  const discovery = { getProviders: () => instances.map((instance) => ({ instance })) }
  new ProcessorDiscoveryService(
    discovery as unknown as DiscoveryService,
    { register } as unknown as WorkerRegistry,
    {} as QueueEventsRegistry,
  ).onModuleInit()
  return register
}

describe('ProcessorDiscoveryService — a value naming a @Processor class as its constructor', () => {
  const impostor = { constructor: NamedProcessor, handle: jest.fn() }

  it('is not registered as that processor', () => {
    expect(discover(impostor)).not.toHaveBeenCalled()
  })

  it('does not count as a second processor beside a real instance', () => {
    expect(discover(impostor, new NamedProcessor())).toHaveBeenCalledTimes(1)
  })

  it('leaves an object built on the class prototype registered, as an instance is', () => {
    const built = Object.create(NamedProcessor.prototype) as object
    expect(discover(built)).toHaveBeenCalledTimes(1)
  })

  it('is not claimed by a class whose Symbol.hasInstance answers true', () => {
    @Processor('claims', { concurrency: 1 })
    class Claims {
      static [Symbol.hasInstance](): boolean {
        return true
      }
    }
    expect(discover({ constructor: Claims })).not.toHaveBeenCalled()
  })

  it('keeps a real instance of a class whose Symbol.hasInstance answers false', () => {
    @Processor('denies', { concurrency: 1 })
    class Denies {
      static [Symbol.hasInstance](): boolean {
        return false
      }
    }
    expect(discover(new Denies())).toHaveBeenCalledTimes(1)
  })

  it('registers what a useFactory builds on the class prototype', async () => {
    const register = jest.fn().mockReturnValue({ on: jest.fn() })
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        ProcessorDiscoveryService,
        { provide: WorkerRegistry, useValue: { register } },
        { provide: QueueEventsRegistry, useValue: {} },
        { provide: 'BUILT', useFactory: () => Object.create(NamedProcessor.prototype) as object },
      ],
    }).compile()
    await moduleRef.init()
    expect(register).toHaveBeenCalledTimes(1)
    await moduleRef.close()
  })

  it('ignores a constructor property that is a function with no prototype', () => {
    // Such a function has no prototype to ask, so only a class carrying @Processor may be tested.
    expect(discover({ constructor: (): void => undefined })).not.toHaveBeenCalled()
  })
})
