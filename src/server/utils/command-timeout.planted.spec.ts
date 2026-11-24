/**
 * @fileoverview Unit tests that the command wrapper awaits the call through the intrinsic
 * constructor: a self-erasing `Promise.prototype.constructor` getter planted before the await, with
 * a replaced `then` behind it, must not make the wrapper report a failed call as done. The case runs
 * on callbacks and timers only, because the test runner reads the constructor of the promises it
 * awaits.
 * @layer server/utils
 */

import { NativePromise } from '../connection/prototype-guard'
import { withCommandTimeoutCode } from './command-timeout'

const proto = NativePromise.prototype
const realThen = Object.getOwnPropertyDescriptor(proto, 'then')!
const realConstructor = Object.getOwnPropertyDescriptor(proto, 'constructor')!
const thenOf = realThen.value as (this: unknown, ...args: unknown[]) => unknown

afterEach(() => {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
})

describe('withCommandTimeoutCode with a constructor planted before the await', () => {
  it('reports the failure of the call, not the answer a replaced then forges', (done) => {
    const failure = new Error('refused')
    const work = new NativePromise<number>((_, reject) =>
      setTimeout(() => {
        reject(failure)
      }, 40),
    )
    let armed = false
    void Object.defineProperty(proto, 'then', {
      configurable: true,
      writable: true,
      value: function then(this: unknown, onFulfilled: unknown, onRejected: unknown) {
        const target = armed ? NativePromise.resolve(1) : this
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

    const result = withCommandTimeoutCode('add', () => 1, work)
    Reflect.apply(thenOf, result, [
      (value: unknown) => {
        finish(done, () => {
          expect(value).toBe('rejected')
        })
      },
      (error: unknown) => {
        finish(done, () => {
          expect(error).toBe(failure)
        })
      },
    ])
  })
})

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
