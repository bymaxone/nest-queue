/**
 * @fileoverview Unit tests that `outcomeOf` refuses a promise it cannot give the intrinsic
 * constructor to: a frozen one is awaited through `Promise.prototype.constructor`, so a constructor
 * planted there, with a replaced `then` behind it, must not turn a failed call into a done one. The
 * case runs on callbacks and timers only, because the test runner reads the constructor of the
 * promises it awaits.
 * @layer server/utils
 */

import { NativePromise } from '../connection/prototype-guard'
import { outcomeOf } from './bounded-wait'

const proto = NativePromise.prototype
const realThen = Object.getOwnPropertyDescriptor(proto, 'then')!
const realConstructor = Object.getOwnPropertyDescriptor(proto, 'constructor')!
const thenOf = realThen.value as (this: unknown, ...args: unknown[]) => unknown

afterEach(() => {
  void Object.defineProperty(proto, 'then', realThen)
  void Object.defineProperty(proto, 'constructor', realConstructor)
})

describe('outcomeOf with a frozen promise and a constructor planted before the await', () => {
  it('does not report done when a replaced then forges the answer', (done) => {
    const failure = new Error('refused')
    let armed = false
    const call = (): Promise<number> => {
      const work = new NativePromise<number>((_, reject) =>
        setTimeout(() => {
          reject(failure)
        }, 40),
      )
      // The guard refuses before the await, so nothing else listens to this rejection; the captured
      // `then` is used because the one on the prototype is about to be replaced.
      void Reflect.apply(thenOf, work, [undefined, () => undefined])
      void Object.freeze(work)
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
      return work
    }

    Reflect.apply(thenOf, outcomeOf(call), [
      (outcome: { state: string }) => {
        void Object.defineProperty(proto, 'then', realThen)
        void Object.defineProperty(proto, 'constructor', realConstructor)
        try {
          expect(outcome.state).toBe('failed')
          done()
        } catch (error) {
          done(error)
        }
      },
    ])
  })
})
