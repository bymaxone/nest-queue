/**
 * @fileoverview Unit tests for the read of the configuration object a host hands to `register` and
 * `registerSandboxed`: it is the host's, so a trap or a getter that throws ends in the library's own
 * refusal with the host's error as the cause, before a connection is opened.
 * @layer server/services
 */

import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

const getClient = jest.fn()

/** A registry whose connection must never be asked for a client by a refused registration. */
function makeRegistry(): WorkerRegistry {
  return new WorkerRegistry(
    { getClient } as unknown as ConnectionResolver,
    {} as unknown as ResolvedQueueOptions,
  )
}

/** A configuration whose descriptor lookup throws `boom`, as a Proxy trap of the host's may. */
function throwing(boom: Error): never {
  return new Proxy(
    { queueName: 'q', handler: () => Promise.resolve(), processorFile: '/p.js' },
    {
      getOwnPropertyDescriptor: () => {
        throw boom
      },
    },
  ) as never
}

/** The refusal a call ended in: its code and its cause. */
function refusalOf(run: () => unknown): { code: string; cause: unknown } {
  try {
    run()
  } catch (error) {
    if (!(error instanceof QueueException)) throw error
    const body = error.getResponse() as { error: { code: string } }
    return { code: body.error.code, cause: error.cause }
  }
  throw new Error('expected a refusal')
}

describe('a worker configuration that cannot be read is refused', () => {
  beforeEach(() => getClient.mockReset())

  it.each([
    ['register', (config: never) => makeRegistry().register(config)],
    ['registerSandboxed', (config: never) => makeRegistry().registerSandboxed(config)],
  ])('%s ends in WORKER_REGISTRATION_FAILED with the host error as the cause', (_name, call) => {
    const boom = new Error('host')

    expect(refusalOf(() => call(throwing(boom)))).toEqual({
      code: 'queue.worker_registration_failed',
      cause: boom,
    })
    expect(getClient).not.toHaveBeenCalled()
  })
})
