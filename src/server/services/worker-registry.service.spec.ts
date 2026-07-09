/**
 * @fileoverview Unit tests for WorkerRegistry. BullMQ `Worker` is mocked so
 * no real Redis connection is needed.
 * @layer server/services
 */

import type { Job, WorkerOptions as BullWorkerOptions } from 'bullmq'
import { WorkerRegistry } from './worker-registry.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { DEFAULT_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY } from '../constants/default-options'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { Redis } from 'ioredis'

/** Minimal mock of the BullMQ Worker instance returned by the mocked constructor. */
interface MockWorkerInstance {
  close: jest.MockedFunction<() => Promise<void>>
  on: jest.MockedFunction<(event: string, listener: (...args: unknown[]) => unknown) => unknown>
}

/** Track instances created by the mocked constructor so tests can inspect them. */
const createdWorkers: MockWorkerInstance[] = []
/** Track the constructor arguments so tests can assert the built worker options. */
const workerConstructorArgs: unknown[][] = []

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    workerConstructorArgs.push(args)
    const instance: MockWorkerInstance = {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      on: jest.fn(),
    }
    createdWorkers.push(instance)
    return instance
  }),
}))

/** A minimal fake Redis that satisfies `ConnectionResolver.getClient()`. Each
 * `duplicate()` returns a fresh stub with `quit`/`disconnect` so the registry's
 * connection cleanup can be asserted. */
function fakeRedis(): Redis {
  return {
    duplicate: jest.fn().mockImplementation(() => ({
      status: 'ready',
      disconnect: jest.fn(),
      quit: jest.fn<Promise<string>, []>().mockResolvedValue('OK'),
    })),
  } as unknown as Redis
}

/** Build a `ConnectionResolver` stub with a controllable `getClient`. */
function fakeConnection(redis?: Redis): ConnectionResolver {
  return {
    getClient: jest.fn<Redis, []>().mockReturnValue(redis ?? fakeRedis()),
  } as unknown as ConnectionResolver
}

/** Build resolved options for the registry under test, optionally with telemetry. */
function makeOptions(telemetry?: ResolvedQueueOptions['telemetry']): ResolvedQueueOptions {
  const base: ResolvedQueueOptions = {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: { attempts: 3 },
    prefix: 'bull',
    queueOptions: {},
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
  }
  if (telemetry !== undefined) base.telemetry = telemetry
  return base
}

/** A minimal job handler used as the process function. */
function noopHandler(_job: Job): Promise<unknown> {
  return Promise.resolve(undefined)
}

beforeEach(() => {
  createdWorkers.length = 0
  workerConstructorArgs.length = 0
})

describe('WorkerRegistry.register', () => {
  it('creates a Worker and stores it in the internal map', () => {
    // A successful registration must create exactly one Worker and track it.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const worker = registry.register({ queueName: 'email', handler: noopHandler })
    expect(worker).toBeDefined()
    expect(registry.list()).toContain('email')
  })

  it('constructs the Worker with the configured key prefix', () => {
    // The worker must poll the same prefixed keyspace the producer Queue writes
    // to; a non-default prefix would otherwise leave every job unconsumed.
    const registry = new WorkerRegistry(fakeConnection(), { ...makeOptions(), prefix: 'tenant:wk' })
    registry.register({ queueName: 'email', handler: noopHandler })
    const [, , workerOpts] = workerConstructorArgs[0] as [unknown, unknown, { prefix?: unknown }]
    expect(workerOpts.prefix).toBe('tenant:wk')
  })

  it('throws DUPLICATE_PROCESSOR when the same queue is registered twice', () => {
    // Two processors targeting the same queue is an application-level error.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() =>
      registry.register({ queueName: 'email', handler: noopHandler, options: { concurrency: 0 } }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when concurrency is negative', () => {
    // Negative concurrency is semantically identical to 0 (invalid).
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const worker = registry.register({
      queueName: 'email',
      handler: noopHandler,
      options: { concurrency: 10 },
    })
    expect(worker).toBeDefined()
  })

  it('throws WORKER_REGISTRATION_FAILED when limiter.max is 0', () => {
    // A rate limiter with max=0 would block all jobs forever.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(redis), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() => registry.register({ queueName: 'email', handler: noopHandler })).toThrow(
      QueueException,
    )
  })

  it('forwards lockDuration and stalledInterval when provided', () => {
    // Optional BullMQ options must be forwarded only when explicitly set.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const worker = registry.register({
      queueName: 'email',
      handler: noopHandler,
      options: { lockDuration: 60_000, stalledInterval: 15_000 },
    })
    expect(worker).toBeDefined()
  })

  it('forwards a valid limiter through buildBullOptions', () => {
    // A valid limiter (max >=1, duration >=1) must be forwarded without throwing.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const worker = registry.registerSandboxed({
      queueName: 'sandboxed',
      processorFile: '/tmp/processor.js',
    })
    expect(worker).toBeDefined()
    expect(registry.list()).toContain('sandboxed')
  })

  it('stores the worker and its duplicated connection in the registry entry', () => {
    // A successful sandboxed registration must track BOTH the worker and the
    // connection it opened, so the shutdown orchestrator can close each of them.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const worker = registry.registerSandboxed({ queueName: 'sandboxed', processorFile: '/tmp/p.js' })
    expect(registry.getAll().get('sandboxed')).toBe(worker)
    expect(registry.getConnections().get('sandboxed')).toBeDefined()
  })

  it('throws DUPLICATE_PROCESSOR for duplicate sandboxed registrations', () => {
    // Duplicate guard applies to sandboxed registrations too.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.registerSandboxed({ queueName: 'sandboxed', processorFile: '/tmp/p.js' })
    expect(() =>
      registry.registerSandboxed({ queueName: 'sandboxed', processorFile: '/tmp/p.js' }),
    ).toThrow(QueueException)
  })

  it('forwards useWorkerThreads when provided', () => {
    // useWorkerThreads is optional and must only be included when explicitly set.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(redis), makeOptions())
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
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() =>
      registry.registerSandboxed({ queueName: 'rel', processorFile: './processor.js' }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when processorFile has a disallowed extension', () => {
    // Only .js, .cjs, and .mjs are accepted — prevent arbitrary file execution.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() =>
      registry.registerSandboxed({ queueName: 'ext', processorFile: '/tmp/processor.ts' }),
    ).toThrow(QueueException)
  })

  it('throws WORKER_REGISTRATION_FAILED when processorFile URL uses a non-file: protocol', () => {
    // Non-file: URLs (http:, data:) could load remote code — always reject them.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() =>
      registry.registerSandboxed({
        queueName: 'url',
        processorFile: new URL('https://example.com/processor.js'),
      }),
    ).toThrow(QueueException)
  })

  it('accepts a file: URL as processorFile', () => {
    // file: URLs are the safe, explicit form for absolute file references.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const worker = registry.registerSandboxed({
      queueName: 'fileurl',
      processorFile: new URL('file:///tmp/processor.js'),
    })
    expect(worker).toBeDefined()
  })

  it('throws WORKER_REGISTRATION_FAILED when a file: URL has a disallowed extension', () => {
    // A file: URL must not bypass the extension allowlist that string paths get.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() =>
      registry.registerSandboxed({
        queueName: 'fileurl-ext',
        processorFile: new URL('file:///tmp/processor.sh'),
      }),
    ).toThrow(QueueException)
  })
})

describe('WorkerRegistry.unregister', () => {
  it('closes the worker, releases its connection, and removes it from the map', async () => {
    // unregister must close(), quit the duplicated connection, and drop the entry.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    const [worker] = createdWorkers
    const conn = registry.getConnections().get('email') as unknown as { quit: jest.Mock }
    await registry.unregister('email')
    expect(worker?.close).toHaveBeenCalledTimes(1)
    expect(conn.quit).toHaveBeenCalledTimes(1)
    expect(registry.list()).not.toContain('email')
    expect(registry.getConnections().has('email')).toBe(false)
  })

  it('hard-disconnects the connection when its quit handshake fails', async () => {
    // A failed graceful quit must fall back to disconnect so a socket never leaks.
    const failingConn = {
      status: 'ready',
      quit: jest.fn<Promise<string>, []>().mockRejectedValue(new Error('quit failed')),
      disconnect: jest.fn(),
    }
    const redis = { duplicate: jest.fn().mockReturnValue(failingConn) } as unknown as Redis
    const registry = new WorkerRegistry(fakeConnection(redis), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    await registry.unregister('email')
    expect(failingConn.quit).toHaveBeenCalledTimes(1)
    expect(failingConn.disconnect).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an unknown queue name', async () => {
    // Unregistering a non-existent queue must not throw.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    await expect(registry.unregister('nonexistent')).resolves.toBeUndefined()
  })
})

describe('WorkerRegistry.list / getAll', () => {
  it('list returns all registered queue names', () => {
    // list() is the primary way consumers discover what queues are registered.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'a', handler: noopHandler })
    registry.register({ queueName: 'b', handler: noopHandler })
    expect(registry.list()).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('getAll returns a ReadonlyMap of all workers', () => {
    // getAll() is the shutdown orchestrator's entry point.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'x', handler: noopHandler })
    const map = registry.getAll()
    expect(map.size).toBe(1)
    expect(map.has('x')).toBe(true)
  })
})

describe('WorkerRegistry.getConnections', () => {
  it('exposes the duplicated connection the library opened per worker', () => {
    // The shutdown orchestrator closes exactly these library-created connections.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'a', handler: noopHandler })
    registry.register({ queueName: 'b', handler: noopHandler })
    const connections = registry.getConnections()
    expect(connections.size).toBe(2)
    expect(connections.has('a')).toBe(true)
    expect(connections.has('b')).toBe(true)
  })

  it('returns an empty map when no workers are registered', () => {
    // With nothing registered there are no library-created connections to close.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(registry.getConnections().size).toBe(0)
  })
})

describe('WorkerRegistry — telemetry passthrough', () => {
  it('forwards the configured telemetry instance to the Worker constructor', () => {
    // The telemetry instance reaches every Worker so spans cross enqueue → handler.
    const telemetry = { name: 'sentinel-telemetry' } as unknown as ResolvedQueueOptions['telemetry']
    const registry = new WorkerRegistry(fakeConnection(), makeOptions(telemetry))
    registry.register({ queueName: 'email', handler: noopHandler })

    const [, , opts] = workerConstructorArgs[0] as [string, unknown, BullWorkerOptions]
    expect(opts.telemetry).toBe(telemetry)
  })

  it('omits the telemetry key when telemetry is not configured', () => {
    // Without telemetry, the constructor options never carry the key.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })

    const [, , opts] = workerConstructorArgs[0] as [string, unknown, BullWorkerOptions]
    expect('telemetry' in opts).toBe(false)
  })
})

/** Read the options passed to the most recent Worker construction. */
function lastWorkerOptions(): BullWorkerOptions {
  const args = workerConstructorArgs[workerConstructorArgs.length - 1] as [
    string,
    unknown,
    BullWorkerOptions,
  ]
  return args[2]
}

/** Extract the structured details of a thrown QueueException. */
function detailsOf(run: () => unknown): Record<string, unknown> {
  try {
    run()
  } catch (err) {
    return ((err as QueueException).getResponse() as { error: { details: Record<string, unknown> } })
      .error.details
  }
  throw new Error('expected the operation to throw')
}

describe('WorkerRegistry — constructor option forwarding', () => {
  it('passes the duplicated connection and the explicit concurrency to BullMQ', () => {
    // The built options must carry the connection and the caller's concurrency verbatim.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler, options: { concurrency: 7 } })
    const opts = lastWorkerOptions()
    expect(opts.concurrency).toBe(7)
    expect(opts.connection).toBeDefined()
    expect(opts.autorun).toBe(true)
  })

  it('defaults concurrency to DEFAULT_WORKER_CONCURRENCY when omitted', () => {
    // A missing concurrency resolves to the documented default, not undefined.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    expect(lastWorkerOptions().concurrency).toBe(DEFAULT_WORKER_CONCURRENCY)
  })

  it('forwards limiter, lockDuration, and stalledInterval only when provided', () => {
    // Optional tuning fields reach BullMQ exactly as supplied.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({
      queueName: 'email',
      handler: noopHandler,
      options: { limiter: { max: 10, duration: 1000 }, lockDuration: 60_000, stalledInterval: 15_000 },
    })
    const opts = lastWorkerOptions()
    expect(opts.limiter).toEqual({ max: 10, duration: 1000 })
    expect(opts.lockDuration).toBe(60_000)
    expect(opts.stalledInterval).toBe(15_000)
  })

  it('omits limiter, lockDuration, and stalledInterval when not provided', () => {
    // Absent optional fields must never appear on the constructed options.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    const opts = lastWorkerOptions()
    expect('limiter' in opts).toBe(false)
    expect('lockDuration' in opts).toBe(false)
    expect('stalledInterval' in opts).toBe(false)
  })

  it('forwards the configured telemetry instance to the built options', () => {
    // Telemetry from resolved options is attached to the worker options.
    const telemetry = { id: 'otel' } as unknown as ResolvedQueueOptions['telemetry']
    const registry = new WorkerRegistry(fakeConnection(), makeOptions(telemetry))
    registry.register({ queueName: 'email', handler: noopHandler })
    expect(lastWorkerOptions().telemetry).toBe(telemetry)
  })

  it('forwards useWorkerThreads to the sandboxed worker options only when set', () => {
    // The sandboxed-only flag is forwarded when provided and absent otherwise.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.registerSandboxed({
      queueName: 'threaded',
      processorFile: '/tmp/p.js',
      options: { useWorkerThreads: true },
    })
    expect((lastWorkerOptions() as { useWorkerThreads?: boolean }).useWorkerThreads).toBe(true)

    registry.registerSandboxed({ queueName: 'plain', processorFile: '/tmp/p.js' })
    expect('useWorkerThreads' in lastWorkerOptions()).toBe(false)
  })
})

describe('WorkerRegistry — validation boundaries and error details', () => {
  it('accepts concurrency at the lower and upper bounds', () => {
    // Exactly 1 and exactly MAX_WORKER_CONCURRENCY are valid (boundary inclusive).
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() => registry.register({ queueName: 'a', handler: noopHandler, options: { concurrency: 1 } })).not.toThrow()
    expect(() =>
      registry.register({
        queueName: 'b',
        handler: noopHandler,
        options: { concurrency: MAX_WORKER_CONCURRENCY },
      }),
    ).not.toThrow()
  })

  it('accepts limiter max and duration at their lower bound of 1', () => {
    // max=1 and duration=1 are the smallest valid limiter values.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(() =>
      registry.register({
        queueName: 'a',
        handler: noopHandler,
        options: { limiter: { max: 1, duration: 1 } },
      }),
    ).not.toThrow()
  })

  it('reports the offending concurrency in the error details', () => {
    // The exception carries the actual value and a descriptive reason.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const tooLow = detailsOf(() =>
      registry.register({ queueName: 'a', handler: noopHandler, options: { concurrency: 0 } }),
    )
    expect(tooLow).toEqual({ reason: 'concurrency must be >= 1', actual: 0 })

    const tooHigh = detailsOf(() =>
      registry.register({
        queueName: 'b',
        handler: noopHandler,
        options: { concurrency: MAX_WORKER_CONCURRENCY + 1 },
      }),
    )
    expect(tooHigh.actual).toBe(MAX_WORKER_CONCURRENCY + 1)
    expect(String(tooHigh.reason)).toContain(String(MAX_WORKER_CONCURRENCY))
  })

  it('reports the offending limiter values in the error details', () => {
    // Both limiter bounds surface a precise reason and actual value.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(
      detailsOf(() =>
        registry.register({
          queueName: 'a',
          handler: noopHandler,
          options: { limiter: { max: 0, duration: 1000 } },
        }),
      ),
    ).toEqual({ reason: 'limiter.max must be >= 1', actual: 0 })
    expect(
      detailsOf(() =>
        registry.register({
          queueName: 'b',
          handler: noopHandler,
          options: { limiter: { max: 5, duration: 0 } },
        }),
      ),
    ).toEqual({ reason: 'limiter.duration must be >= 1', actual: 0 })
  })

  it('reports the queue name when a duplicate is registered', () => {
    // The duplicate-processor error names the conflicting queue.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    registry.register({ queueName: 'email', handler: noopHandler })
    expect(detailsOf(() => registry.register({ queueName: 'email', handler: noopHandler }))).toEqual({
      queueName: 'email',
    })
  })

  it('reports the queue name and cause when the Worker constructor fails', () => {
    // A construction failure surfaces the queue name and a stringified cause.
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const details = detailsOf(() => registry.register({ queueName: 'email', handler: noopHandler }))
    expect(details.queueName).toBe('email')
    expect(details.cause).toBe('boom')
  })

  it('reports the queue name and cause when the sandboxed Worker constructor fails', () => {
    // The sandboxed path must surface the same structured diagnostics as register().
    const { Worker: MockWorker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq')
    MockWorker.mockImplementationOnce(() => {
      throw new Error('spawn boom')
    })
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    const details = detailsOf(() =>
      registry.registerSandboxed({ queueName: 'sb', processorFile: '/tmp/p.js' }),
    )
    expect(details.queueName).toBe('sb')
    expect(details.cause).toBe('spawn boom')
  })

  it('accepts every allowed sandboxed extension and rejects others with a reason', () => {
    // .js, .cjs, and .mjs are accepted; anything else carries an explicit reason.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    for (const file of ['/tmp/p.js', '/tmp/p.cjs', '/tmp/p.mjs']) {
      expect(() =>
        registry.registerSandboxed({ queueName: file, processorFile: file }),
      ).not.toThrow()
    }
    expect(detailsOf(() => registry.registerSandboxed({ queueName: 'x', processorFile: '/tmp/p.ts' }))).toEqual({
      reason: 'processorFile must have a .js, .cjs, or .mjs extension',
    })
  })

  it('reports a precise reason for relative paths and non-file URLs', () => {
    // Both rejected forms surface their own descriptive reason.
    const registry = new WorkerRegistry(fakeConnection(), makeOptions())
    expect(detailsOf(() => registry.registerSandboxed({ queueName: 'a', processorFile: './p.js' }))).toEqual({
      reason: 'processorFile must be an absolute path',
    })
    expect(
      detailsOf(() =>
        registry.registerSandboxed({
          queueName: 'b',
          processorFile: new URL('https://example.com/p.js'),
        }),
      ),
    ).toEqual({ reason: 'processorFile URL must use the file: protocol' })
  })
})
