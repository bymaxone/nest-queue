/**
 * @fileoverview Discovery registers a `@Processor` only for an instance of the class, whatever a
 * provider value says its `constructor` is.
 * @layer server/services
 */

import 'reflect-metadata'
import type { DiscoveryService } from '@nestjs/core'
import type { Job } from 'bullmq'
import { ProcessorDiscoveryService } from './processor-discovery.service'
import type { WorkerRegistry } from './worker-registry.service'
import type { QueueEventsRegistry } from './queue-events-registry.service'
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

  it('ignores a constructor property that is a function with no prototype', () => {
    // `instanceof` throws on such a function, so only a class carrying @Processor may be tested.
    expect(discover({ constructor: (): void => undefined })).not.toHaveBeenCalled()
  })
})
