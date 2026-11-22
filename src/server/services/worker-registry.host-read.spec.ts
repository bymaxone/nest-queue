/**
 * @fileoverview Unit tests for the worker options a host hands to `register`. They are the host's:
 * a getter can answer differently the second time, a limiter can be an object that changes, and any
 * read can throw. Each option is read once, before a connection is opened, and the BullMQ `Worker`
 * is built from the copy that was checked; a switch that is not a boolean is refused by name.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { WorkerOptions } from '../interfaces/worker-options.interface'

const built: unknown[][] = []

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    built.push(args)
    return Object.assign(new EventEmitter(), { close: jest.fn().mockResolvedValue(undefined) })
  }),
}))

const duplicate = jest.fn()

/** A registry over a stub connection whose `duplicate` is counted. */
function makeRegistry(): WorkerRegistry {
  duplicate.mockImplementation(() => ({
    status: 'ready',
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  }))
  const connection = {
    getClient: jest.fn().mockReturnValue({ duplicate }),
  } as unknown as ConnectionResolver
  const options = {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: {},
    prefix: 'bull',
    queueOptions: {},
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
    commandTimeoutMs: 5000,
    enqueueTimeoutMs: 10000,
  } as ResolvedQueueOptions
  return new WorkerRegistry(connection, options)
}

beforeEach(() => {
  built.length = 0
  duplicate.mockReset()
})

/** The `Worker` options the registry built, the third constructor argument. */
function builtOptions(): Record<string, unknown> {
  return built[0]?.[2] as Record<string, unknown>
}

/** The refusal a call ended in: its code, its reason and its cause. */
function refusalOf(run: () => unknown): {
  code: string
  reason: string | undefined
  cause: unknown
} {
  try {
    run()
  } catch (error) {
    if (!(error instanceof QueueException)) throw error
    const body = error.getResponse() as { error: { code: string; details?: { reason?: string } } }
    return { code: body.error.code, reason: body.error.details?.reason, cause: error.cause }
  }
  throw new Error('expected a refusal')
}

describe('WorkerRegistry.register — the options are the host’s', () => {
  it('reads each option once and builds the worker from what was checked', () => {
    const reads: Record<string, number> = {}
    const counted = (name: string, first: unknown, later: unknown): PropertyDescriptor => ({
      enumerable: true,
      get: () => {
        reads[name] = (reads[name] ?? 0) + 1
        return reads[name] === 1 ? first : later
      },
    })
    const options = Object.defineProperties(
      {},
      {
        concurrency: counted('concurrency', 3, 9999),
        lockDuration: counted('lockDuration', 5000, 1),
        stalledInterval: counted('stalledInterval', 6000, 1),
        autorun: counted('autorun', false, true),
        jobTimeoutMs: counted('jobTimeoutMs', 4000, 1),
      },
    ) as WorkerOptions

    makeRegistry().register({ queueName: 'q', handler: () => Promise.resolve(), options })

    expect(reads).toEqual({
      concurrency: 1,
      lockDuration: 1,
      stalledInterval: 1,
      autorun: 1,
      jobTimeoutMs: 1,
    })
    expect(builtOptions()).toMatchObject({
      concurrency: 3,
      lockDuration: 5000,
      stalledInterval: 6000,
      autorun: false,
    })
  })

  it('sends a copy of the limiter, read once', () => {
    let reads = 0
    const limiter = {
      get max(): number {
        reads += 1
        return reads === 1 ? 5 : 500
      },
      duration: 1000,
    }

    makeRegistry().register({
      queueName: 'q',
      handler: () => Promise.resolve(),
      options: { limiter },
    })

    expect(reads).toBe(1)
    expect(builtOptions().limiter).toEqual({ max: 5, duration: 1000 })
    expect(builtOptions().limiter).not.toBe(limiter)
  })

  it('refuses an option whose getter throws, with the host error as cause, before a connection is opened', () => {
    const boom = new Error('host getter')
    const options = Object.defineProperty({}, 'concurrency', {
      enumerable: true,
      get: () => {
        throw boom
      },
    })

    const refusal = refusalOf(() =>
      makeRegistry().register({ queueName: 'q', handler: () => Promise.resolve(), options }),
    )

    expect(refusal.code).toBe(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED)
    expect(refusal.cause).toBe(boom)
    expect(duplicate).not.toHaveBeenCalled()
  })

  it.each([
    ['the string "false"', 'false', 'a string'],
    ['the number 0', 0, 'a number'],
    ['null', null, 'null'],
    ['an object', {}, 'an object'],
  ])('refuses an autorun that is %s, naming the option and the type', (_label, value, type) => {
    const refusal = refusalOf(() =>
      makeRegistry().register({
        queueName: 'q',
        handler: () => Promise.resolve(),
        options: { autorun: value } as never,
      }),
    )

    expect(refusal.code).toBe(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED)
    expect(refusal.reason).toBe(`autorun must be a boolean, received ${type}`)
    expect(built).toHaveLength(0)
  })
})
