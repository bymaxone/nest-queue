/**
 * @fileoverview Unit tests that a host cannot decide what the registry reports by touching a promise
 * it can reach, on the attempt path and on the enqueue path: a constructor planted while the hook
 * runs, a replaced `Promise.prototype.then`, a promise of the operation that the host gives a
 * constructor and a `then` of its own, a `then` planted on `Object.prototype` that erases itself, and
 * a `Promise[Symbol.species]` that throws. The operation rejects in every case, and the caller must
 * be told it failed; the host still receives that rejection through the promise it was handed. Each
 * case reports through a `done` callback and a timer, because the test runner reads the constructor
 * of the promises a test returns. The few cases that await inside a test say why beside the await.
 * @layer server/observability
 */

import type { Job } from 'bullmq'
import { NativePromise } from '../connection/prototype-guard'
import { own } from '../utils/bounded-wait'
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

const realSpecies = Object.getOwnPropertyDescriptor(NativePromise, Symbol.species)!

afterEach(() => {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
  void Object.defineProperty(NativePromise, Symbol.species, realSpecies)
  void Reflect.deleteProperty(Object.prototype, 'then')
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
  void Reflect.deleteProperty(Object.prototype, 'then')
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

/** Give `handed` a `then` of its own that answers `forged`, and report that it was installed. */
function giveForgingThen(handed: Promise<unknown>): boolean {
  void Object.defineProperty(handed, 'then', {
    value: (resolve: (v: unknown) => void) => {
      resolve('forged')
    },
    configurable: true,
  })
  return Object.getOwnPropertyDescriptor(handed, 'then') !== undefined
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

  it('reports the failure when the host gives the promise it was handed a then of its own', (done) => {
    let installed = false
    const registry = withProcessHook((run) => {
      installed = giveForgingThen(run())
      return Promise.resolve(undefined)
    })

    observe(observeAttempt(registry, 'q', job, failing(failure)), done, (r) => {
      expect(installed).toBe(true)
      expect(r).toEqual({ error: failure })
    })
  })

  it('does not let the host redefine the constructor of the promise it was handed', (done) => {
    let refusal: unknown
    const registry = withProcessHook((run) => {
      const handed = run()
      try {
        void Object.defineProperty(handed, 'constructor', { value: Object, configurable: true })
      } catch (error) {
        refusal = error
      }
      return handed
    })

    observe(observeAttempt(registry, 'q', job, failing(failure)), done, () => {
      expect(refusal).toBeInstanceOf(TypeError)
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
    let installed = false
    const registry = new QueueObserverRegistry()
    registry.register({
      traceEnqueue: (_i: unknown, _c: unknown, run: () => Promise<unknown>) => {
        installed = giveForgingThen(run())
        return Promise.resolve(undefined)
      },
    } as never)

    observe(registry.traceEnqueue({ queue: 'q' }, failing(failure)), done, (r) => {
      expect(installed).toBe(true)
      expect(r).toEqual({ error: failure })
    })
  })

  it('reports a failed attempt when a jobFinished hook plants a then on Object.prototype that erases itself', (done) => {
    const registry = new QueueObserverRegistry()
    registry.register({
      jobFinished: () => {
        void Object.defineProperty(Object.prototype, 'then', {
          configurable: true,
          get() {
            void Reflect.deleteProperty(Object.prototype, 'then')
            return (resolve: (v: unknown) => void) => {
              resolve({ forged: true })
            }
          },
        })
      },
    })
    const succeeding = (): Promise<unknown> =>
      new NativePromise<unknown>((resolve) =>
        setTimeout(() => {
          resolve({ real: true })
        }, 40),
      )

    observe(observeAttempt(registry, 'q', job, succeeding), done, (r) => {
      expect(r).not.toHaveProperty('value')
      expect(r).toHaveProperty('error')
    })
  })

  it('reports the failure and leaves no unhandled rejection when Promise[Symbol.species] throws', (done) => {
    const unhandled: unknown[] = []
    const listen = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listen)
    void Object.defineProperty(NativePromise, Symbol.species, {
      configurable: true,
      get() {
        throw new Error('species read')
      },
    })
    const registry = withProcessHook((run) => run())

    // The test reads the attempt with a native `await` of an owned promise: `then` would read the
    // species this case makes throw, which is the very read being ruled out.
    const read = async (): Promise<void> => {
      let outcome: { value?: unknown; error?: unknown }
      try {
        outcome = { value: await own(observeAttempt(registry, 'q', job, failing(failure))) }
      } catch (error) {
        outcome = { error }
      }
      void Object.defineProperty(NativePromise, Symbol.species, realSpecies)
      setTimeout(() => {
        process.off('unhandledRejection', listen)
        try {
          expect(outcome).toEqual({ error: failure })
          expect(unhandled).toHaveLength(0)
          done()
        } catch (failed) {
          done(failed)
        }
      }, 30)
    }
    void read()
  })

  it('still hands the host the rejection of the operation through the promise it was given', (done) => {
    let handed: Promise<unknown> | undefined
    const registry = withProcessHook((run) => {
      handed = run()
      return handed
    })
    const result = observeAttempt(registry, 'q', job, failing(failure))

    // The test ends only once the promise the host was given has settled: a fulfilment fails it, and
    // so does a rejection that is not the operation's own.
    const readHanded = (): void => {
      if (handed === undefined) {
        done(new Error('the host was never handed a promise'))
        return
      }
      Reflect.apply(thenOf, handed, [
        (value: unknown) => {
          done(new Error(`the host's promise fulfilled with ${String(value)}`))
        },
        (error: unknown) => {
          try {
            expect(error).toBe(failure)
            done()
          } catch (failed) {
            done(failed)
          }
        },
      ])
    }
    Reflect.apply(thenOf, result, [readHanded, readHanded])
  })
})
