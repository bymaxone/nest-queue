/**
 * @fileoverview Unit tests for what the options snapshot names when a read of the host's object
 * throws: the option that could not be read, never a value, and the host's error as the cause.
 * Also that a connection or queue options that were not given stay out of the copy.
 * @layer server/config
 */

import type { JobsOptions } from 'bullmq'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueException } from '../errors/queue-exception'
import { snapshotJobOptions, snapshotOptions } from './snapshot-options'

const connection = { url: 'redis://localhost:6379' }

/** Throw the host's error from a trap or getter, and report the reason of the refusal it ended in. */
function reasonOf(run: () => unknown): { reason: unknown; cause: unknown } {
  try {
    run()
  } catch (error) {
    const body = (error as QueueException).getResponse() as {
      error: { details: { reason: unknown } }
    }
    return { reason: body.error.details.reason, cause: (error as QueueException).cause }
  }
  throw new Error('expected a refusal')
}

/** A host object whose `ownKeys` trap throws. */
function ownKeysThrows(boom: Error): object {
  return new Proxy(
    {},
    {
      ownKeys: () => {
        throw boom
      },
    },
  )
}

describe('what the options snapshot names when a read throws', () => {
  it('names the module options when its keys cannot be listed', () => {
    const boom = new Error('host')

    const refusal = reasonOf(() => snapshotOptions(ownKeysThrows(boom) as BymaxQueueModuleOptions))

    expect(refusal).toEqual({ reason: 'the module options could not be read', cause: boom })
  })

  it('names the top-level option whose getter throws', () => {
    const boom = new Error('host')
    const options = Object.defineProperty({ connection }, 'prefix', {
      enumerable: true,
      get: () => {
        throw boom
      },
    })

    expect(reasonOf(() => snapshotOptions(options))).toEqual({
      reason: 'the module options.prefix could not be read',
      cause: boom,
    })
  })

  it('names the option of a group whose getter throws', () => {
    const boom = new Error('host')
    const shutdown = Object.defineProperty({}, 'drainOnShutdown', {
      enumerable: true,
      get: () => {
        throw boom
      },
    })

    expect(reasonOf(() => snapshotOptions({ connection, shutdown }))).toEqual({
      reason: 'shutdown.drainOnShutdown could not be read',
      cause: boom,
    })
  })

  it('names the connection when its fields cannot be read', () => {
    const boom = new Error('host')
    const host = new Proxy(
      { url: 'redis://x' },
      {
        // The connection is read by descriptor now, so this is the trap that fails the read.
        getOwnPropertyDescriptor: () => {
          throw boom
        },
      },
    )

    expect(reasonOf(() => snapshotOptions({ connection: host }))).toEqual({
      reason: 'connection could not be read',
      cause: boom,
    })
  })

  it('names the queue options when they cannot be read', () => {
    const boom = new Error('host')

    expect(
      reasonOf(() => snapshotOptions({ connection, queueOptions: ownKeysThrows(boom) })),
    ).toEqual({ reason: 'queueOptions could not be read', cause: boom })
  })

  it('names the job options when they cannot be read', () => {
    const boom = new Error('host')

    expect(reasonOf(() => snapshotJobOptions(ownKeysThrows(boom) as JobsOptions))).toEqual({
      reason: 'the job options could not be read',
      cause: boom,
    })
  })
})

describe('what stays out of the copy when it was not given', () => {
  it.each(['connection', 'queueOptions', 'defaultJobOptions'])('holds no %s key', (key) => {
    expect(key in snapshotOptions({} as BymaxQueueModuleOptions)).toBe(false)
  })
})
