/**
 * @fileoverview Unit tests for the options object a host passes to `forRootAsync`. It is the host's:
 * reading its keys can run a Proxy trap or a getter, and that must end in the library's refusal with
 * the host's error as the cause, never as the host's own error from code the library did not write.
 * @layer server
 */

import { BymaxQueueModule } from './bymax-queue.module'
import { QueueException } from './errors/queue-exception'
import { QUEUE_ERROR_CODES } from './constants/error-codes'

const baseOptions = { connection: { url: 'redis://localhost:6379' } }

/** The reason of the refusal a call ended in. */
function reasonOf(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return ((error as QueueException).getResponse() as { error: { details: { reason: unknown } } })
      .error.details.reason
  }
  throw new Error('expected a refusal')
}

describe('BymaxQueueModule.forRootAsync — the registration options are the host’s', () => {
  it.each(['ownKeys', 'getOwnPropertyDescriptor', 'get'] as const)(
    'refuses a %s trap that throws, with the host error as the cause',
    (trap) => {
      const boom = new Error(`host ${trap}`)
      const options = new Proxy(
        { useFactory: () => baseOptions },
        {
          [trap]: () => {
            throw boom
          },
        },
      )

      let thrown: unknown
      try {
        BymaxQueueModule.forRootAsync(options)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(QueueException)
      const body = (thrown as QueueException).getResponse() as { error: { code: string } }
      expect(body.error.code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
      expect((thrown as QueueException).cause).toBe(boom)
    },
  )

  it('names the registration options in the refusal', () => {
    const options = new Proxy(
      { useFactory: () => baseOptions },
      {
        ownKeys: () => {
          throw new Error('host')
        },
      },
    )

    expect(reasonOf(() => BymaxQueueModule.forRootAsync(options as never))).toBe(
      'the registration options could not be read',
    )
  })

  it('names isGlobal and the type when it is not a boolean', () => {
    const options = { useFactory: () => baseOptions, isGlobal: 'false' }

    expect(reasonOf(() => BymaxQueueModule.forRootAsync(options as never))).toBe(
      'isGlobal must be a boolean, received a string',
    )
  })
})
