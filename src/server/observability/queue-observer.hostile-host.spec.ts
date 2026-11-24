/**
 * @fileoverview Unit tests that a host cannot decide what the registry reports by touching a promise
 * it can reach: a constructor planted while the hook runs, a replaced `Promise.prototype.then`, and a
 * promise of the operation that the host gives a constructor and a `then` of its own. The operation
 * rejects in every case, and the caller must be told it failed. Each case runs on callbacks and
 * timers only, because the test runner reads the constructor of the promises it awaits.
 * @layer server/observability
 */

import type { Job } from 'bullmq'
import { NativePromise } from '../connection/prototype-guard'
import { observeAttempt } from './observe-attempt'
import { QueueObserverRegistry } from './queue-observer'

const proto = NativePromise.prototype
/** The descriptor `name` has on the intrinsic promise prototype. */
function descriptorOf(name: string): PropertyDescriptor {
  const found = Object.getOwnPropertyDescriptor(proto, name)
  if (found === undefined) throw new Error('no promise prototype')
  return found
}
const realThen = descriptorOf('then')
const realConstructor = descriptorOf('constructor')
const thenOf = realThen.value as (this: unknown, ...args: unknown[]) => unknown

afterEach(() => {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
})

/** Read a promise through the real `then`, so the test's own reading is never the replaced one. */
function observe(
  promise: Promise<unknown>,
  done: jest.DoneCallback,
  check: (r: unknown) => void,
): void {
  Reflect.apply(thenOf, promise, [
    (value: unknown) => {
      finish(done, check, { value })
    },
    (error: unknown) => {
      finish(done, check, { error })
    },
  ])
}

/** Hand `outcome` to `check` after the host is put back, and report to `done`. */
function finish(done: jest.DoneCallback, check: (r: unknown) => void, outcome: unknown): void {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
  try {
    check(outcome)
    done()
  } catch (error) {
    done(error)
  }
}

/** A processor that rejects with `failure` after 40 ms. */
const failing = (failure: Error) => () =>
  new NativePromise<never>((_, reject) =>
    setTimeout(() => {
      reject(failure)
    }, 40),
  )

/** A `then` that answers `forged` in the place of the nth call counted from `start()`. */
function forgeNthThen(nth: number): { start: () => void } {
  let calls = -1
  void Object.defineProperty(proto, 'then', {
    configurable: true,
    writable: true,
    value: function then(this: unknown, onFulfilled: unknown, onRejected: unknown) {
      calls = calls >= 0 ? calls + 1 : calls
      const target = calls === nth ? NativePromise.resolve('forged') : this
      return Reflect.apply(thenOf, target, [onFulfilled, onRejected])
    },
  })
  return {
    start: () => {
      calls = 0
    },
  }
}

/** A `constructor` getter that erases itself on its first read and arms a `then` that forges. */
function plantConstructor(): void {
  let armed = false
  void Object.defineProperty(proto, 'then', {
    configurable: true,
    writable: true,
    value: function then(this: unknown, onFulfilled: unknown, onRejected: unknown) {
      const target = armed ? NativePromise.resolve('forged') : this
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

const job = { name: 'send', attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job

/** A registry with one observer whose `traceProcess` is `hook`. */
function withProcessHook(hook: (run: () => Promise<unknown>) => unknown): QueueObserverRegistry {
  const registry = new QueueObserverRegistry()
  registry.register({
    traceProcess: (_i: unknown, _c: unknown, run: () => Promise<unknown>) => hook(run),
  } as never)
  return registry
}

describe('a host that touches the promises it can reach does not decide the result', () => {
  const failure = new Error('processor failed')

  it('reports the failure when the hook plants a constructor after starting the operation, through observeAttempt', (done) => {
    const registry = withProcessHook((run) => {
      const started = run()
      plantConstructor()
      return started
    })

    observe(observeAttempt(registry, 'q', job, failing(failure)), done, (r) => {
      expect(r).toEqual({ error: failure })
    })
  })

  it('reports the failure when only Promise.prototype.then is replaced after the operation starts', (done) => {
    const forge = forgeNthThen(2)
    const registry = withProcessHook((run) => {
      forge.start()
      return run()
    })

    observe(observeAttempt(registry, 'q', job, failing(failure)), done, (r) => {
      expect(r).toEqual({ error: failure })
    })
  })

  it('reports the failure when the host gives the promise it was handed a constructor and a then of its own', (done) => {
    const registry = withProcessHook((run) => {
      const handed = run()
      void Object.defineProperty(handed, 'constructor', { value: Object, configurable: true })
      void Object.defineProperty(handed, 'then', {
        value: (resolve: (v: unknown) => void) => {
          resolve('forged')
        },
        configurable: true,
      })
      return Promise.resolve(undefined)
    })

    observe(observeAttempt(registry, 'q', job, failing(failure)), done, (r) => {
      expect(r).toEqual({ error: failure })
    })
  })

  it('reports a failed add when the hook of traceEnqueue plants a constructor after starting it', (done) => {
    const registry = new QueueObserverRegistry()
    registry.register({
      traceEnqueue: (_i: unknown, _c: unknown, run: () => Promise<unknown>) => {
        const started = run()
        plantConstructor()
        return started
      },
    } as never)

    // The caller awaits the promise, as the queue service does.
    const add = async (): Promise<unknown> =>
      await registry.traceEnqueue({ queue: 'q' }, failing(failure))
    observe(add(), done, (r) => {
      expect(r).toEqual({ error: failure })
    })
  })

  it('reports a failed add when the host gives the promise of traceEnqueue a then of its own', (done) => {
    const registry = new QueueObserverRegistry()
    registry.register({
      traceEnqueue: (_i: unknown, _c: unknown, run: () => Promise<unknown>) => {
        const handed = run()
        void Object.defineProperty(handed, 'constructor', { value: Object, configurable: true })
        void Object.defineProperty(handed, 'then', {
          value: (resolve: (v: unknown) => void) => {
            resolve('forged')
          },
          configurable: true,
        })
        return Promise.resolve(undefined)
      },
    } as never)

    observe(registry.traceEnqueue({ queue: 'q' }, failing(failure)), done, (r) => {
      expect(r).toEqual({ error: failure })
    })
  })

  it('still hands the host the rejection of the operation through the promise it was given', (done) => {
    let handed: Promise<unknown> | undefined
    const registry = withProcessHook((run) => {
      handed = run()
      return handed
    })
    const result = observeAttempt(registry, 'q', job, failing(failure))

    observe(result, done, () => {
      expect(handed).toBeDefined()
    })
    setTimeout(() => {
      Reflect.apply(thenOf, handed, [
        () => undefined,
        (error: unknown) => {
          expect(error).toBe(failure)
        },
      ])
    }, 60)
  })
})
