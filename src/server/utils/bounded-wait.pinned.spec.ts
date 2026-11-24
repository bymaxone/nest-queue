/**
 * @fileoverview Unit tests that a native promise a host built with a `constructor` of its own that
 * cannot be replaced is refused before any await reads it, and never answers in the work's place;
 * and that a promise whose own `constructor` can be replaced, or that is frozen, is awaited without
 * its own `then` being called. Each case reads results through the captured `then` and callbacks,
 * because the test runner reads the constructor of the promises it awaits.
 * @layer server/utils
 */

import { NativePromise } from '../connection/prototype-guard'
import { joinAll, outcomeOf, own, startWait } from './bounded-wait'

const thenOf = Object.getOwnPropertyDescriptor(NativePromise.prototype, 'then')!.value as (
  this: unknown,
  ...args: unknown[]
) => unknown

/** The error the work fails with after 20 ms. */
const failure = new Error('work failed')

/** A promise that rejects with `failure` after 20 ms. */
const failing = (): Promise<never> =>
  new NativePromise<never>((_, reject) =>
    setTimeout(() => {
      reject(failure)
    }, 20),
  )

/** Give `promise` a `then` that answers `forged`, and a `constructor` of `kind`. */
function forge(promise: Promise<unknown>, kind: 'locked' | 'open' | 'frozen'): Promise<unknown> {
  void Object.defineProperty(promise, 'then', {
    value: (resolve: (v: unknown) => void) => {
      resolve('forged')
    },
    configurable: true,
  })
  if (kind !== 'frozen') {
    void Object.defineProperty(promise, 'constructor', {
      value: Object,
      configurable: kind === 'open',
    })
  }
  if (kind === 'frozen') void Object.freeze(promise)
  return promise
}

/** Read `promise` through the captured `then`. */
function read(promise: unknown, done: jest.DoneCallback, check: (r: unknown) => void): void {
  Reflect.apply(thenOf, promise, [
    (value: unknown) => {
      try {
        check({ value })
        done()
      } catch (error) {
        done(error)
      }
    },
    (error: unknown) => {
      try {
        check({ error })
        done()
      } catch (failed) {
        done(failed)
      }
    },
  ])
}

describe('a promise whose own constructor cannot be replaced is refused before it is awaited', () => {
  it('startWait ends as failed, not as the forged answer', (done) => {
    const wait = startWait(forge(failing(), 'locked'), 1000)

    read(wait.result, done, (r) => {
      wait.release()
      const { value } = r as { value: { state: string; v: unknown } }
      expect(value.state).toBe('failed')
      expect(value.v).not.toBe('forged')
    })
  })

  it('outcomeOf ends as failed, not as the forged answer', (done) => {
    read(
      outcomeOf(() => forge(failing(), 'locked')),
      done,
      (r) => {
        const { value } = r as { value: { state: string; v: unknown } }
        expect(value.state).toBe('failed')
        expect(value.v).not.toBe('forged')
      },
    )
  })

  it('own refuses it, and listens for its rejection so none is left unheard', (done) => {
    const unhandled: unknown[] = []
    const listen = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listen)
    const locked = forge(failing(), 'locked')

    expect(() => own(locked)).toThrow()
    setTimeout(() => {
      process.off('unhandledRejection', listen)
      try {
        expect(unhandled).toHaveLength(0)
        done()
      } catch (error) {
        done(error)
      }
    }, 60)
  })

  it('joinAll rejects with the refusal, not with the forged answer', (done) => {
    read(joinAll([forge(failing(), 'locked')]), done, (r) => {
      expect(r).toHaveProperty('error')
      expect((r as { error: unknown }).error).not.toBe('forged')
    })
  })
})

describe('a promise that can take the intrinsic constructor ignores its own then', () => {
  it.each(['open', 'frozen'] as const)(
    'outcomeOf reports the real failure of a %s promise',
    (kind, done) => {
      read(
        outcomeOf(() => forge(failing(), kind)),
        done,
        (r) => {
          const { value } = r as { value: { state: string; v: unknown } }
          expect(value.state).toBe('failed')
          expect(value.v).toBe(failure)
        },
      )
    },
  )
})

describe('a result that is not a native promise', () => {
  it('outcomeOf reports a foreign thenable by what it answers', (done) => {
    read(
      outcomeOf(
        () =>
          ({
            then: (resolve: (v: unknown) => void) => {
              resolve('answer')
            },
          }) as unknown as Promise<unknown>,
      ),
      done,
      (r) => {
        expect((r as { value: { state: string; v: unknown } }).value).toMatchObject({
          state: 'done',
          v: 'answer',
        })
      },
    )
  })
})
