/**
 * @fileoverview Unit tests that the outcome of a job reaches BullMQ through awaits that read
 * nothing a host can replace: a handler that plants a self-erasing `Promise.prototype.constructor`
 * getter and a replaced `then` while it runs must not turn its own failure into a completed job.
 * The case runs on callbacks and timers only, because the test runner reads the constructor of the
 * promises it awaits. BullMQ's `Worker` is mocked, so the processor is called directly.
 * @layer server/services
 */

import type { Job } from 'bullmq'
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { NativePromise } from '../connection/prototype-guard'
import { QueueException } from '../errors/queue-exception'
import { WorkerRegistry } from './worker-registry.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

type Processor = (job: Job, token?: string, signal?: AbortSignal) => Promise<unknown>

const processors: Processor[] = []

jest.mock('bullmq', () => ({
  DelayedError: jest.requireActual<{ DelayedError: unknown }>('bullmq').DelayedError,
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    processors.push(processor)
    return Object.assign(new EventEmitter(), {
      close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    })
  }),
}))

const options = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: false },
  metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
  shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
} as unknown as ResolvedQueueOptions

const proto = NativePromise.prototype
const realThen = Object.getOwnPropertyDescriptor(proto, 'then')!
const realConstructor = Object.getOwnPropertyDescriptor(proto, 'constructor')!
const thenOf = realThen.value as (this: unknown, ...args: unknown[]) => unknown

afterEach(() => {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
})

/** The code of a `QueueException`, or undefined for any other error. */
function codeOf(error: unknown): string | undefined {
  if (!(error instanceof QueueException)) return undefined
  return (error.getResponse() as { error: { code: string } }).error.code
}

/** Put the host back, run `check`, and report it to `done`. */
function finish(done: jest.DoneCallback, check: () => void): void {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
  try {
    check()
    done()
  } catch (error) {
    done(error)
  }
}

/** Plant a getter that erases itself on its first read and arms a `then` that forges `completed`. */
function plant(): void {
  let armed = false
  void Object.defineProperty(proto, 'then', {
    configurable: true,
    writable: true,
    value: function then(this: unknown, onFulfilled: unknown, onRejected: unknown) {
      const target = armed ? NativePromise.resolve('completed') : this
      armed = false
      return Reflect.apply(thenOf, target, [onFulfilled, onRejected])
    },
  })
  void Object.defineProperty(proto, 'constructor', {
    configurable: true,
    get() {
      void Object.defineProperty(proto, 'constructor', realConstructor)
      armed = true
      return Object
    },
  })
}

describe('the outcome of a job is relayed through owned awaits', () => {
  it('tells BullMQ the job failed when its handler planted a constructor and then failed', (done) => {
    const redis = {
      duplicate: jest.fn().mockReturnValue({ status: 'ready', disconnect: jest.fn() }),
    } as unknown as Redis
    const resolver = {
      getClient: jest.fn().mockReturnValue(redis),
    } as unknown as ConnectionResolver
    const failure = new Error('handler failed')
    new WorkerRegistry(resolver, options).register({
      queueName: 'q',
      handler: () => {
        plant()
        return new NativePromise<never>((_, reject) =>
          setTimeout(() => {
            reject(failure)
          }, 40),
        )
      },
    })
    const processor = processors.at(-1)!
    const job = { id: '1', name: 'send', data: {}, opts: {} } as unknown as Job

    // BullMQ awaits what the processor returns with a native `await`, so this does the same.
    const told = processor(job)
    const bullmq = async (): Promise<{ value?: unknown; error?: unknown }> => {
      try {
        return { value: await told }
      } catch (error) {
        return { error }
      }
    }
    Reflect.apply(thenOf, bullmq(), [
      (result: { value?: unknown; error?: unknown }) => {
        finish(done, () => {
          // The guard refuses before the await that reads the planted constructor, so the job fails with
          // the typed refusal; what must never happen is that BullMQ is told it completed.
          expect('value' in result).toBe(false)
          expect(result.error === failure || codeOf(result.error) === 'queue.invalid_options').toBe(
            true,
          )
        })
      },
    ])
  })
})
