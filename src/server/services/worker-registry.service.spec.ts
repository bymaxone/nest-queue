/**
 * @fileoverview Unit tests for WorkerRegistry. BullMQ `Worker` is mocked so
 * no real Redis connection is needed.
 * @layer server/services
 */

import type { Job, WorkerOptions as BullWorkerOptions } from 'bullmq'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { Redis } from 'ioredis'

/** Minimal mock of the BullMQ Worker instance returned by the mocked constructor. */
interface MockWorkerInstance {
  close: jest.MockedFunction<() => Promise<void>>
  on: jest.MockedFunction<(event: string, listener: (...args: unknown[]) => unknown) => unknown>
}

/** Track instances created by the mocked constructor so tests can inspect them. */
const createdWorkers: MockWorkerInstance[] = []

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(
    (_name: string, _processor: unknown, _opts: BullWorkerOptions) => {
      const instance: MockWorkerInstance = {
        close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
        on: jest.fn(),
      }
      createdWorkers.push(instance)
      return instance
    },
  ),
}))

/** A minimal fake Redis that satisfies `ConnectionResolver.getClient()`. */
function fakeRedis(): Redis {
  return {
    duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
  } as unknown as Redis
}

/** Build a `ConnectionResolver` stub with a controllable `getClient`. */
function fakeConnection(redis?: Redis): ConnectionResolver {
  return {
    getClient: jest.fn<Redis, []>().mockReturnValue(redis ?? fakeRedis()),
  } as unknown as ConnectionResolver
}

/** A minimal job handler used as the process function. */
function noopHandler(_job: Job): Promise<unknown> {
  return Promise.resolve(undefined)
}

beforeEach(() => {
  createdWorkers.length = 0
})

describe('WorkerRegistry.register', () => {
  it('creates a Worker and stores it in the internal map', () => {
    // A successful registration must create exactly one Worker and track it.
    const registry = new WorkerRegistry(fakeConnection())
    const worker = registry.register({ queueName: 'email', handler: noopHandler })
    expect(worker).toBeDefined()
    expect(registry.list()).toContain('email')
  })

  it('throws DUPLICATE_PROCESSOR when the same queue is registered twice', () => {
    // Two processors targeting the same queue is an application-level error.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'email', handler: noopHandler })
    expect(() => registry.register({ queueName: 'email', handler: noopHandler })).toThrow(
      QueueException,
    )
    try {
      registry.register({ queueName: 'email', handler: noopHandler })
    } catch (err) {
      const qe = err as QueueException
      expect((qe.getResponse() as { error: { code: string } }).error.code).toBe(
        QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR,
      )
    }
  })

  it('throws WORKER_REGISTRATION_FAILED when concurrency is 0', () => {
    // concurrency < 1 is always invalid — BullMQ would process nothing.
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.register({ queueName: 'email', handler: noopHandler, options: { concurrency: 0 } }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when concurrency is negative', () => {
    // Negative concurrency is semantically identical to 0 (invalid).
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.register({
        queueName: 'email',
        handler: noopHandler,
        options: { concurrency: -1 },
      }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when concurrency exceeds MAX_WORKER_CONCURRENCY', () => {
    // A ceiling of 1_000 prevents event-loop exhaustion from absurdly high values.
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.register({
        queueName: 'email',
        handler: noopHandler,
        options: { concurrency: 1_001 },
      }),
    ).toThrow(QueueException)
  })

  it('registers successfully when an explicit concurrency within the valid range is provided', () => {
    // An in-range concurrency value must pass both the lower and upper bound checks.
    const registry = new WorkerRegistry(fakeConnection())
    const worker = registry.register({
      queueName: 'email',
      handler: noopHandler,
      options: { concurrency: 10 },
    })
    expect(worker).toBeDefined()
  })

  it('throws WORKER_REGISTRATION_FAILED when limiter.max is 0', () => {
    // A rate limiter with max=0 would block all jobs forever.
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.register({
        queueName: 'email',
        handler: noopHandler,
        options: { limiter: { max: 0, duration: 1000 } },
      }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when limiter.duration is 0', () => {
    // A rate limiter with duration=0 is invalid (division by zero semantics).
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.register({
        queueName: 'email',
        handler: noopHandler,
        options: { limiter: { max: 5, duration: 0 } },
      }),
    ).toThrow(QueueException)
  })

  it('wraps BullMQ Worker constructor errors in WORKER_REGISTRATION_FAILED', () => {
    // If BullMQ's Worker constructor throws an Error, it is wrapped in a QueueException.
    const { Worker: MockWorker } = jest.requireMock<{
      Worker: jest.Mock
    }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      throw new Error('Redis auth failed')
    })
    const registry = new WorkerRegistry(fakeConnection())
    expect(() => registry.register({ queueName: 'email', handler: noopHandler })).toThrow(
      QueueException,
    )
  })

  it('disconnects the duplicated connection when the Worker constructor fails (no leak)', () => {
    // A failed Worker construction must not leave a dangling Redis connection open.
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      throw new Error('connection refused')
    })
    const redis = fakeRedis()
    const registry = new WorkerRegistry(fakeConnection(redis))
    expect(() => registry.register({ queueName: 'email', handler: noopHandler })).toThrow()
    const dupResult = (redis.duplicate as jest.Mock).mock.results[0]!.value as {
      disconnect: jest.Mock
    }
    expect(dupResult.disconnect).toHaveBeenCalledTimes(1)
  })

  it('wraps a non-Error constructor throw using String() fallback', () => {
    // When BullMQ throws a non-Error (string, number), cause is stringified safely.
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      const cause: unknown = 'auth_failed' // non-Error primitive
      throw cause
    })
    const registry = new WorkerRegistry(fakeConnection())
    expect(() => registry.register({ queueName: 'email', handler: noopHandler })).toThrow(
      QueueException,
    )
  })

  it('forwards lockDuration and stalledInterval when provided', () => {
    // Optional BullMQ options must be forwarded only when explicitly set.
    const registry = new WorkerRegistry(fakeConnection())
    const worker = registry.register({
      queueName: 'email',
      handler: noopHandler,
      options: { lockDuration: 60_000, stalledInterval: 15_000 },
    })
    expect(worker).toBeDefined()
  })

  it('forwards a valid limiter through buildBullOptions', () => {
    // A valid limiter (max >=1, duration >=1) must be forwarded without throwing.
    const registry = new WorkerRegistry(fakeConnection())
    const worker = registry.register({
      queueName: 'email',
      handler: noopHandler,
      options: { limiter: { max: 10, duration: 1000 } },
    })
    expect(worker).toBeDefined()
  })
})

describe('WorkerRegistry.registerSandboxed', () => {
  it('creates a file-based worker with the provided processorFile', () => {
    // Sandboxed workers pass the file path as the processor argument to BullMQ.
    const registry = new WorkerRegistry(fakeConnection())
    const worker = registry.registerSandboxed({
      queueName: 'sandboxed',
      processorFile: '/tmp/processor.js',
    })
    expect(worker).toBeDefined()
    expect(registry.list()).toContain('sandboxed')
  })

  it('throws DUPLICATE_PROCESSOR for duplicate sandboxed registrations', () => {
    // Duplicate guard applies to sandboxed registrations too.
    const registry = new WorkerRegistry(fakeConnection())
    registry.registerSandboxed({ queueName: 'sandboxed', processorFile: '/tmp/p.js' })
    expect(() =>
      registry.registerSandboxed({ queueName: 'sandboxed', processorFile: '/tmp/p.js' }),
    ).toThrow(QueueException)
  })

  it('forwards useWorkerThreads when provided', () => {
    // useWorkerThreads is optional and must only be included when explicitly set.
    const registry = new WorkerRegistry(fakeConnection())
    registry.registerSandboxed({
      queueName: 'threaded',
      processorFile: '/tmp/p.js',
      options: { useWorkerThreads: true },
    })
    expect(createdWorkers).toHaveLength(1)
  })

  it('wraps constructor errors in WORKER_REGISTRATION_FAILED for sandboxed path', () => {
    // Sandboxed registration errors are also wrapped for consistency.
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      throw new Error('file not found')
    })
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.registerSandboxed({ queueName: 'sb', processorFile: '/bad/path.js' }),
    ).toThrow(QueueException)
  })

  it('wraps a non-Error sandboxed constructor throw using String() fallback', () => {
    // When the sandboxed constructor throws a non-Error, the cause is stringified.
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      const cause: unknown = 42 // non-Error primitive
      throw cause
    })
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.registerSandboxed({ queueName: 'sb', processorFile: '/bad/path.js' }),
    ).toThrow(QueueException)
  })

  it('disconnects the duplicated connection when the sandboxed Worker constructor fails', () => {
    // A failed sandboxed construction must not leave a dangling Redis connection.
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      throw new Error('sandbox spawn failed')
    })
    const redis = fakeRedis()
    const registry = new WorkerRegistry(fakeConnection(redis))
    expect(() =>
      registry.registerSandboxed({ queueName: 'sb', processorFile: '/tmp/p.js' }),
    ).toThrow()
    const dupResult = (redis.duplicate as jest.Mock).mock.results[0]!.value as {
      disconnect: jest.Mock
    }
    expect(dupResult.disconnect).toHaveBeenCalledTimes(1)
  })

  it('throws WORKER_REGISTRATION_FAILED when processorFile is a relative path', () => {
    // Relative paths may traverse outside the project root — always reject them.
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.registerSandboxed({ queueName: 'rel', processorFile: './processor.js' }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when processorFile has a disallowed extension', () => {
    // Only .js, .cjs, and .mjs are accepted — prevent arbitrary file execution.
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.registerSandboxed({ queueName: 'ext', processorFile: '/tmp/processor.ts' }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when processorFile URL uses a non-file: protocol', () => {
    // Non-file: URLs (http:, data:) could load remote code — always reject them.
    const registry = new WorkerRegistry(fakeConnection())
    expect(() =>
      registry.registerSandboxed({
        queueName: 'url',
        processorFile: new URL('https://example.com/processor.js'),
      }),
    ).toThrow(QueueException)
  })

  it('accepts a file: URL as processorFile', () => {
    // file: URLs are the safe, explicit form for absolute file references.
    const registry = new WorkerRegistry(fakeConnection())
    const worker = registry.registerSandboxed({
      queueName: 'fileurl',
      processorFile: new URL('file:///tmp/processor.js'),
    })
    expect(worker).toBeDefined()
  })
})

describe('WorkerRegistry.unregister', () => {
  it('closes the worker and removes it from the map', async () => {
    // unregister must call close() and remove the queue name from the registry.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'email', handler: noopHandler })
    const [worker] = createdWorkers
    await registry.unregister('email')
    expect(worker?.close).toHaveBeenCalledTimes(1)
    expect(registry.list()).not.toContain('email')
  })

  it('is a no-op for an unknown queue name', async () => {
    // Unregistering a non-existent queue must not throw.
    const registry = new WorkerRegistry(fakeConnection())
    await expect(registry.unregister('nonexistent')).resolves.toBeUndefined()
  })
})

describe('WorkerRegistry.list / getAll', () => {
  it('list returns all registered queue names', () => {
    // list() is the primary way consumers discover what queues are registered.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'a', handler: noopHandler })
    registry.register({ queueName: 'b', handler: noopHandler })
    expect(registry.list()).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('getAll returns a ReadonlyMap of all workers', () => {
    // getAll() is the shutdown orchestrator's entry point.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'x', handler: noopHandler })
    const map = registry.getAll()
    expect(map.size).toBe(1)
    expect(map.has('x')).toBe(true)
  })
})

describe('WorkerRegistry.onModuleDestroy', () => {
  it('closes all workers without throwing even when close() rejects with an Error', async () => {
    // Shutdown must be best-effort — a failing close must not prevent others from closing.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'a', handler: noopHandler })
    registry.register({ queueName: 'b', handler: noopHandler })

    const [workerA, workerB] = createdWorkers
    workerA?.close.mockRejectedValueOnce(new Error('close failed'))

    await expect(registry.onModuleDestroy()).resolves.toBeUndefined()
    expect(workerA?.close).toHaveBeenCalledTimes(1)
    expect(workerB?.close).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(0)
  })

  it('handles a non-Error rejection from close() during onModuleDestroy', async () => {
    // A close() that rejects with a non-Error (string, number) must be swallowed gracefully.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'x', handler: noopHandler })
    const [workerX] = createdWorkers
    workerX?.close.mockRejectedValueOnce('abrupt_close')

    await expect(registry.onModuleDestroy()).resolves.toBeUndefined()
    expect(workerX?.close).toHaveBeenCalledTimes(1)
  })

  it('clears the internal map after destroy', async () => {
    // After shutdown, the registry should be empty.
    const registry = new WorkerRegistry(fakeConnection())
    registry.register({ queueName: 'email', handler: noopHandler })
    await registry.onModuleDestroy()
    expect(registry.list()).toHaveLength(0)
  })
})
