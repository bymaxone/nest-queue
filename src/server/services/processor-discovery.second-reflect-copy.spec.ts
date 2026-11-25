/**
 * @fileoverview Unit test that discovery still finds a processor decorated before a second
 * `reflect-metadata` copy redefined the metadata functions on `Reflect`.
 * @layer server/services
 */

import 'reflect-metadata'
import type { DiscoveryService } from '@nestjs/core'
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper'
import type { Job, Worker } from 'bullmq'
import { Process } from '../decorators/process.decorator'
import { Processor } from '../decorators/processor.decorator'
import { ProcessorDiscoveryService } from './processor-discovery.service'
import type { QueueEventsRegistry } from './queue-events-registry.service'
import type { WorkerRegistry } from './worker-registry.service'

/** Captured before the second copy replaces anything on `Reflect`. */
const define = Object.defineProperty
const keysOf = Reflect.ownKeys
const remove = Reflect.deleteProperty
const describe_ = Object.getOwnPropertyDescriptor

/** Every own descriptor `Reflect` had before the case ran. */
const original = new Map<PropertyKey, PropertyDescriptor>()

beforeEach(() => {
  original.clear()
  for (const key of keysOf(Reflect)) original.set(key, describe_(Reflect, key)!)
})

afterEach(() => {
  for (const key of keysOf(Reflect)) {
    if (!original.has(key)) void remove(Reflect, key)
  }
  for (const [key, descriptor] of original) void define(Reflect, key, descriptor)
})

describe('discovery after a second reflect-metadata copy loaded', () => {
  it('finds a processor decorated by the first copy', () => {
    // The decorator ran with copy A; copy B then redefines getOwnMetadata and its siblings.
    @Processor('email', { concurrency: 1 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }
    const before = Reflect.getOwnMetadata
    jest.isolateModules(() => {
      jest.requireActual('reflect-metadata')
    })
    expect(Reflect.getOwnMetadata).not.toBe(before)

    const register = jest.fn<Worker, [unknown]>().mockReturnValue({ on: jest.fn() } as unknown as Worker)
    const discovery = {
      getProviders: () => [{ instance: new EmailProcessor() } as unknown as InstanceWrapper],
    } as unknown as DiscoveryService
    const events = {
      getOrCreate: jest.fn().mockReturnValue({ on: jest.fn() }),
    } as unknown as QueueEventsRegistry
    new ProcessorDiscoveryService(discovery, { register } as unknown as WorkerRegistry, events).onModuleInit()

    expect(register).toHaveBeenCalledTimes(1)
  })
})
