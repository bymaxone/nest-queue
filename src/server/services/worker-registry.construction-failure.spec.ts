/**
 * @fileoverview A BullMQ `Worker` constructor can fail after it has built its blocking connection;
 * the registry then ends that connection along with its own. `Worker` is mocked to fail there.
 * @layer server/services
 */

import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    ;(args[2] as { connection: Redis }).connection.duplicate()
    throw new Error('constructor failed')
  }),
}))

describe('WorkerRegistry — a constructor that fails after duplicating its connection', () => {
  it.each([
    [
      'register',
      (r: WorkerRegistry) => r.register({ queueName: 'q', handler: () => Promise.resolve(1) }),
    ],
    [
      'registerSandboxed',
      (r: WorkerRegistry) => r.registerSandboxed({ queueName: 'q', processorFile: '/p.js' }),
    ],
  ])('%s ends that connection as well', (_name, start) => {
    const blocking = { status: 'connecting', on: jest.fn(), disconnect: jest.fn() }
    const own = { status: 'ready', on: jest.fn(), disconnect: jest.fn(), duplicate: () => blocking }
    const redis = { duplicate: () => own } as unknown as Redis
    const connection = { getClient: () => redis } as unknown as ConnectionResolver
    const options = { prefix: 'bull' } as unknown as ResolvedQueueOptions

    expect(() => start(new WorkerRegistry(connection, options))).toThrow(QueueException)

    expect(blocking.disconnect).toHaveBeenCalledTimes(1)
    expect(own.disconnect).toHaveBeenCalledTimes(1)
  })
})
