/**
 * @fileoverview Unit tests that the awaits which decide a result take the intrinsic constructor
 * first: a host that plants a self-erasing `Promise.prototype.constructor` getter while the library
 * is between a promise's creation and its await, on top of a replaced `then`, must not make the await
 * call that `then`. Each case runs on callbacks and timers only, because the test runner reads the
 * constructor of the promises it awaits, and the planted getter would answer it instead.
 * @layer server/utils
 */

import { EventEmitter } from 'node:events'
import type { FlowJob, JobNode } from 'bullmq'
import { NativePromise } from '../connection/prototype-guard'
import { ConnectionResolver } from '../services/connection-resolver.service'
import { QueueObserverRegistry } from '../observability/queue-observer'
import { runFlowBulk } from './add-flow-trees'
import { withCommandTimeoutCode } from './command-timeout'

jest.mock('ioredis', () => ({
  AbstractConnector: jest.requireActual<{ AbstractConnector: unknown }>('ioredis')
    .AbstractConnector,
  Redis: jest.fn(),
}))

/** A host with a replaced `then` and a `constructor` getter it can plant and that erases itself. */
function hostileHost(): { plant: () => void; restore: () => void } {
  const proto = NativePromise.prototype
  const original = Object.getOwnPropertyDescriptor(proto, 'constructor')
  const realThen = Object.getOwnPropertyDescriptor(proto, 'then')
  if (original === undefined || realThen === undefined) throw new Error('no promise prototype')
  let armed = false
  void Object.defineProperty(proto, 'then', {
    configurable: true,
    writable: true,
    value: function then(this: Promise<unknown>, onFulfilled: unknown, onRejected: unknown) {
      const target = armed ? NativePromise.resolve() : this
      armed = false
      return Reflect.apply(realThen.value as () => unknown, target, [
        onFulfilled,
        onRejected,
      ]) as unknown
    },
  })
  return {
    plant: () => {
      void Object.defineProperty(proto, 'constructor', {
        configurable: true,
        get() {
          void Object.defineProperty(proto, 'constructor', original)
          armed = true
          return Object
        },
      })
    },
    restore: () => {
      void Object.defineProperty(proto, 'constructor', original)
      void Object.defineProperty(proto, 'then', realThen)
    },
  }
}

/** A value whose second `then` read plants the host's getter, as an observer's result could. */
function plantingValue(host: { plant: () => void }, onRead = 2): { job: { id: string } } {
  let reads = 0
  const value = { job: { id: 'tree-0' } }
  Object.defineProperty(value, 'then', {
    get() {
      reads += 1
      if (reads === onRead) host.plant()
      return undefined
    },
  })
  return value
}

/** Run `check` after `ms`, with the host put back first, and report it to `done`. */
function finishAfter(
  ms: number,
  host: { restore: () => void },
  check: () => void,
  done: jest.DoneCallback,
): void {
  setTimeout(() => {
    host.restore()
    try {
      check()
      done()
    } catch (error) {
      done(error)
    }
  }, ms)
}

describe('awaits that decide a result do not read a constructor planted meanwhile', () => {
  it('keeps the join of a bulk add waiting for a tree that fails after the planting', (done) => {
    const host = hostileHost()
    const traced = plantingValue(host)
    const trees = [
      () =>
        new NativePromise((resolve) =>
          setTimeout(() => {
            resolve(traced)
          }, 20),
        ),
      () =>
        new NativePromise((_, reject) =>
          setTimeout(() => {
            reject(new Error('refused'))
          }, 80),
        ),
    ]
    let next = 0
    const flows: FlowJob[] = [
      { name: 'a', queueName: 'q' },
      { name: 'b', queueName: 'q' },
    ]
    const run = runFlowBulk(
      flows,
      () => withCommandTimeoutCode('add', () => 1, trees[next++]?.() as Promise<JobNode>),
      'addFlowBulk',
      10,
    )
    let seen = 'pending'
    void run.done.then(
      () => (seen = 'resolved'),
      () => (seen = 'rejected'),
    )

    finishAfter(
      250,
      host,
      () => {
        expect(seen).toBe('rejected')
      },
      done,
    )
  })

  /** An observer that starts the operation and answers with `traced` once `answer` says so. */
  function observerAnswering(
    traced: unknown,
    answer: (resolve: () => void) => void,
  ): QueueObserverRegistry {
    const registry = new QueueObserverRegistry()
    registry.register({
      traceProcess: (_info: unknown, _carrier: unknown, run: () => Promise<unknown>) => {
        void run()
        return new NativePromise((resolve) => {
          answer(() => {
            resolve(traced)
          })
        })
      },
    } as never)
    return registry
  }

  /** Trace a process whose operation rejects with `failure` after 40 ms, recording the outcome. */
  function traceFailing(registry: QueueObserverRegistry, failure: Error): () => unknown {
    let seen: unknown = 'pending'
    void registry
      .traceProcess(
        { queue: 'q' },
        {},
        () =>
          new NativePromise((_, reject) =>
            setTimeout(() => {
              reject(failure)
            }, 40),
          ),
      )
      .then(
        () => (seen = 'resolved'),
        (error: unknown) => (seen = error),
      )
    return () => seen
  }

  it('keeps the observer waiting for an operation that fails after a late planting', (done) => {
    const host = hostileHost()
    const failure = new Error('processor failed')
    const registry = observerAnswering(plantingValue(host, 1), (answer) => {
      setTimeout(answer, 10)
    })
    const seen = traceFailing(registry, failure)

    finishAfter(
      250,
      host,
      () => {
        expect(seen()).toBe(failure)
      },
      done,
    )
  })

  describe('the ready wait of an owned client', () => {
    class Scripted extends EventEmitter {
      status = 'connecting'
      readonly options = { maxRetriesPerRequest: null }
      readonly duplicate = jest.fn()
      readonly disconnect = jest.fn()
      onEnd: () => void = () => undefined
      override once(event: string | symbol, listener: (...args: never[]) => void): this {
        if (event === 'end') this.onEnd()
        return super.once(event, listener as (...args: unknown[]) => void)
      }
    }

    it('stays pending until the client is ready', (done) => {
      const host = hostileHost()
      const client = new Scripted()
      client.onEnd = host.plant
      client.duplicate.mockReturnValue(client)
      const redis = jest.requireMock<{ Redis: jest.Mock }>('ioredis').Redis
      redis.mockReturnValue(client)
      const resolver = new ConnectionResolver({ connection: { url: 'redis://localhost:6379' } })
      let seen = 'pending'
      void resolver.init().then(
        () => (seen = 'resolved'),
        () => (seen = 'rejected'),
      )

      finishAfter(
        60,
        host,
        () => {
          try {
            expect(seen).toBe('pending')
          } finally {
            // Readiness ends the wait, and the wait clears its own timer.
            client.emit('ready')
          }
        },
        done,
      )
    })
  })
})
