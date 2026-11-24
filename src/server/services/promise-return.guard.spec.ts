/**
 * @fileoverview Unit tests that the value a decision returns is handed back only after the guard has
 * run once the host's code was last called: a replaced `EventTarget.prototype.removeEventListener`
 * after a job's deadline, a host logger that warns about a failing observer, a `then` replaced while
 * Redis answers a read, and a move to the delayed set that Redis refuses while the prototype is
 * polluted. In every case a `then` planted on `Object.prototype` or `Promise.prototype` must not
 * decide what the caller receives. Results are read through the captured `then` and callbacks,
 * because the test runner reads the constructor of the promises it awaits.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { EventEmitter } from 'node:events'
import { ConsoleLogger, Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { NativePromise } from '../connection/prototype-guard'
import { QueueObserverRegistry } from '../observability/queue-observer'
import { observeAttempt } from '../observability/observe-attempt'
import { WorkerRegistry } from './worker-registry.service'
import { QueueService } from './queue.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

type Processor = (job: Job, token?: string, signal?: AbortSignal) => Promise<unknown>
const processors: Processor[] = []
const queues: Record<string, jest.Mock>[] = []

jest.mock('bullmq', () => ({
  DelayedError: jest.requireActual<{ DelayedError: unknown }>('bullmq').DelayedError,
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  defaultRepeatStrategy: jest.requireActual<{ defaultRepeatStrategy: unknown }>('bullmq')
    .defaultRepeatStrategy,
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    processors.push(processor)
    return Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    })
  }),
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      close: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn(),
    }) as unknown as Record<string, jest.Mock>
    queues.push(instance)
    return instance
  }),
}))

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
} as unknown as ResolvedQueueOptions

const proto = NativePromise.prototype
const realThen = Object.getOwnPropertyDescriptor(proto, 'then')!
const realConstructor = Object.getOwnPropertyDescriptor(proto, 'constructor')!
const thenOf = realThen.value as (this: unknown, ...args: unknown[]) => unknown
const realRemove = EventTarget.prototype.removeEventListener

/** Put every host-owned thing a row replaces back. */
function restore(): void {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
  void Reflect.deleteProperty(Object.prototype, 'then')
  void Reflect.deleteProperty(Object.prototype, 'polluted')
  EventTarget.prototype.removeEventListener = realRemove
  Logger.overrideLogger(new ConsoleLogger())
}

afterEach(restore)

/** Plant a `then` on `Object.prototype` that forges an answer and erases itself on its first read. */
function plantObjectThen(): void {
  void Object.defineProperty(Object.prototype, 'then', {
    configurable: true,
    get() {
      void Reflect.deleteProperty(Object.prototype, 'then')
      return (resolve: (v: unknown) => void) => {
        resolve({ forged: true })
      }
    },
  })
}

/** Read `promise` through the captured `then`, put the host back and hand the outcome to `check`. */
function read(promise: unknown, done: jest.DoneCallback, check: (r: unknown) => void): void {
  const finish = (outcome: unknown): void => {
    restore()
    try {
      check(outcome)
      done()
    } catch (error) {
      done(error)
    }
  }
  Reflect.apply(thenOf, promise, [
    (value: unknown) => {
      finish({ value })
    },
    (error: unknown) => {
      finish({ error })
    },
  ])
}

/** A registry whose resolver hands out a duplicable stub client. */
function workerRegistry(): WorkerRegistry {
  const redis = {
    duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
  } as unknown as Redis
  const resolver = { getClient: jest.fn().mockReturnValue(redis) } as unknown as ConnectionResolver
  return new WorkerRegistry(resolver, options)
}

const job = (extra: object = {}): Job =>
  ({ id: '1', name: 'send', data: {}, opts: {}, attemptsMade: 0, ...extra }) as unknown as Job

describe('what a decision returns is not decided by a host call made just before the return', () => {
  it('does not complete a timed job with a then planted by removeEventListener', (done) => {
    workerRegistry().register({
      queueName: 'q',
      options: { jobTimeoutMs: 1000 },
      handler: () =>
        new NativePromise<unknown>((resolve) =>
          setTimeout(() => {
            resolve({ real: true })
          }, 20),
        ),
    })
    EventTarget.prototype.removeEventListener = function patched(
      this: EventTarget,
      ...args: Parameters<EventTarget['removeEventListener']>
    ): void {
      plantObjectThen()
      realRemove.apply(this, args)
    }

    read(processors.at(-1)!(job(), 't', new AbortController().signal), done, (r) => {
      expect(r).not.toEqual({ value: { forged: true } })
      expect(r).not.toHaveProperty('value.forged')
    })
  })

  it('does not forge the enqueue of an observer that threw when the host logger plants a then', (done) => {
    Logger.overrideLogger({
      log: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
      fatal: () => undefined,
      warn: plantObjectThen,
    })
    const registry = new QueueObserverRegistry()
    registry.register({
      traceEnqueue: () => {
        throw new Error('observer bug')
      },
    })

    read(
      registry.traceEnqueue(
        { queue: 'q' },
        () =>
          new NativePromise<unknown>((resolve) =>
            setTimeout(() => {
              resolve({ real: true })
            }, 20),
          ),
      ),
      done,
      (r) => {
        expect(r).not.toHaveProperty('value.forged')
      },
    )
  })

  it('does not return a job Redis did not find as one a then replaced during the read', (done) => {
    queues.length = 0
    const connection = {
      getClient: jest.fn().mockReturnValue({ options: {} }),
      awaitReady: jest.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionResolver
    const service = new QueueService(connection, options)
    service.getOrCreateQueue('email')
    queues.at(-1)!.getJob!.mockImplementation(() => {
      const found = new NativePromise<null>((resolve) =>
        setTimeout(() => {
          resolve(null)
        }, 20),
      )
      void Object.defineProperty(proto, 'then', {
        configurable: true,
        writable: true,
        value: function then(this: unknown, onFulfilled: unknown, onRejected: unknown) {
          void Object.defineProperty(proto, 'then', realThen)
          return Reflect.apply(thenOf, NativePromise.resolve({ id: 'forged-job' }), [
            onFulfilled,
            onRejected,
          ])
        },
      })
      return found
    })

    read(service.getJob('email', '1'), done, (r) => {
      expect(r).not.toHaveProperty('value.id')
    })
  })

  it('reports the refusal of a move to the delayed set, and leaves nothing unheard', (done) => {
    const unhandled: unknown[] = []
    const listen = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listen)
    workerRegistry().register({ queueName: 'q', handler: () => Promise.resolve('ran') })
    const backend = {
      moveToDelayed: () => {
        const refused = new NativePromise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('move refused by redis'))
          }, 20),
        )
        void Object.defineProperty(proto, 'then', {
          configurable: true,
          writable: true,
          value: function then(this: unknown, onFulfilled: unknown, onRejected: unknown) {
            void Object.defineProperty(proto, 'then', realThen)
            return Reflect.apply(thenOf, NativePromise.resolve('moved'), [onFulfilled, onRejected])
          },
        })
        void Object.defineProperty(proto, 'constructor', {
          configurable: true,
          get() {
            void Object.defineProperty(proto, 'constructor', realConstructor)
            return Object
          },
        })
        return refused
      },
    }
    ;(Object.prototype as Record<string, unknown>).polluted = 1

    const told = processors.at(-1)!(job({ backend }), 't')
    read(told, done, (r) => {
      process.off('unhandledRejection', listen)
      expect((r as { error?: Error }).error?.message).toBe('move refused by redis')
      expect(unhandled).toHaveLength(0)
    })
  })

  it('does not tell an observer an attempt completed when a hook left the prototype polluted', (done) => {
    const finished: string[] = []
    const registry = new QueueObserverRegistry()
    registry.register({
      traceProcess: (_i: unknown, _c: unknown, run: () => Promise<unknown>) => {
        const started = run()
        ;(Object.prototype as Record<string, unknown>).polluted = 1
        return started
      },
      jobFinished: (event: { outcome: string }) => {
        finished.push(event.outcome)
      },
    } as never)

    read(
      observeAttempt(
        registry,
        'q',
        job(),
        () =>
          new NativePromise<unknown>((resolve) =>
            setTimeout(() => {
              resolve('done')
            }, 20),
          ),
      ),
      done,
      (r) => {
        expect(r).toHaveProperty('error')
        expect(finished).toEqual([])
      },
    )
  })
})
