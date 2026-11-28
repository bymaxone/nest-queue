/**
 * @fileoverview Unit tests for the options a host hands to `registerSandboxed`. `useWorkerThreads`
 * belongs to the sandboxed worker alone, so the snapshot of its options reads it by name: a class
 * getter or a field that is not enumerable still reaches the BullMQ `Worker`, as a plain field does.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { WorkerRegistry } from './worker-registry.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

const built: unknown[][] = []

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    built.push(args)
    return Object.assign(new EventEmitter(), { close: jest.fn().mockResolvedValue(undefined) })
  }),
}))

/** A registry over a stub connection. */
function makeRegistry(): WorkerRegistry {
  const connection = {
    getClient: jest.fn().mockReturnValue({
      options: {},
      duplicate: jest
        .fn()
        .mockReturnValue({ status: 'ready', on: jest.fn(), disconnect: jest.fn() }),
    }),
  } as unknown as ConnectionResolver
  return new WorkerRegistry(connection, {} as unknown as ResolvedQueueOptions)
}

/** The options of the BullMQ `Worker` the registry built. */
function workerOptions(): Record<string, unknown> {
  return built[0]?.[2] as Record<string, unknown>
}

beforeEach(() => {
  built.length = 0
})

describe('WorkerRegistry.registerSandboxed reads useWorkerThreads by name', () => {
  it('forwards a useWorkerThreads that a class gives by a getter', () => {
    class Options {
      get useWorkerThreads(): boolean {
        return !this.constructor.name.length
      }
    }

    makeRegistry().registerSandboxed({
      queueName: 'q',
      processorFile: '/tmp/p.js',
      options: new Options(),
    })

    expect(workerOptions().useWorkerThreads).toBe(false)
  })

  it('forwards a useWorkerThreads that is not enumerable', () => {
    const options = Object.defineProperty({}, 'useWorkerThreads', {
      value: true,
      enumerable: false,
    })

    makeRegistry().registerSandboxed({ queueName: 'q', processorFile: '/tmp/p.js', options })

    expect(workerOptions().useWorkerThreads).toBe(true)
  })

  it('forwards a plain useWorkerThreads and leaves it out when the host gave none', () => {
    makeRegistry().registerSandboxed({
      queueName: 'with',
      processorFile: '/tmp/p.js',
      options: { useWorkerThreads: true },
    })
    makeRegistry().registerSandboxed({ queueName: 'without', processorFile: '/tmp/p.js' })

    expect(built[0]?.[2]).toMatchObject({ useWorkerThreads: true })
    expect(Object.hasOwn(built[1]?.[2] as object, 'useWorkerThreads')).toBe(false)
  })
})
