/**
 * @fileoverview Unit tests for `startWait`: the verdict of a piece of work and a deadline as a
 * prototype-less outcome, the rejection of the work heard before anything else can fail, and the
 * timer and listener released.
 * @layer server/utils
 */

import { getEventListeners } from 'node:events'
import { NativePromise } from '../connection/prototype-guard'
import { own, startWait } from './bounded-wait'

afterEach(() => {
  jest.useRealTimers()
})

describe('startWait', () => {
  it('settles done with the value of the work, as an object with no prototype', async () => {
    const wait = startWait(Promise.resolve({ ok: true }), 1000)

    const outcome = await wait.result
    wait.release()

    expect(outcome).toEqual({ state: 'done', v: { ok: true } })
    expect(Object.getPrototypeOf(outcome)).toBeNull()
  })

  it('settles failed with the error of the work, and never rejects', async () => {
    const failure = new Error('boom')
    const wait = startWait(Promise.reject(failure), 1000)

    const outcome = await wait.result
    wait.release()

    expect(outcome.state).toBe('failed')
    expect(outcome.v).toBe(failure)
  })

  it('settles done with the value a non-native thenable resolves with', async () => {
    const thenable = {
      then: (resolve: (value: string) => void): void => {
        resolve('late')
      },
    }
    const wait = startWait(thenable as unknown as Promise<string>, 1000)

    const outcome = await wait.result
    wait.release()

    expect(outcome).toEqual({ state: 'done', v: 'late' })
  })

  it('settles expired at the bound, and not a millisecond before', async () => {
    jest.useFakeTimers()
    const wait = startWait(new Promise<never>(() => undefined), 500)
    const seen = jest.fn()
    void wait.result.then(seen)

    await jest.advanceTimersByTimeAsync(499)
    expect(seen).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(seen).toHaveBeenCalledWith({ state: 'expired', v: undefined })
    wait.release()
  })

  it('settles expired at once for a signal that is already aborted, and when it aborts later', async () => {
    const stopped = startWait(new Promise<never>(() => undefined), 60_000, {
      signal: AbortSignal.abort(),
    })
    expect((await stopped.result).state).toBe('expired')
    stopped.release()

    const controller = new AbortController()
    const later = startWait(new Promise<never>(() => undefined), 60_000, {
      signal: controller.signal,
    })
    controller.abort()
    expect((await later.result).state).toBe('expired')
    later.release()
  })

  it('keeps the first verdict: a late answer does not change an expiry', async () => {
    jest.useFakeTimers()
    let answer: (value: string) => void = () => undefined
    const wait = startWait(
      new Promise<string>((resolve) => {
        answer = resolve
      }),
      100,
    )
    await jest.advanceTimersByTimeAsync(100)
    answer('late')

    expect((await wait.result).state).toBe('expired')
    wait.release()
  })

  it('hears the rejection of work whose wait is refused before its await, so none is left unhandled', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    Object.defineProperty(Object.prototype, 'then', { configurable: true, value: () => undefined })
    let outcome: { state: string; v: unknown }
    try {
      const wait = startWait(Promise.reject(new Error('late failure')), 1000)
      outcome = await wait.result
      wait.release()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'then')
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)

    expect(outcome.state).toBe('failed')
    expect((outcome.v as Error).message).not.toBe('late failure')
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('hears the rejection of work when Promise.prototype.constructor throws on every read', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const original = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor')
    if (original === undefined) throw new Error('Promise.prototype has no constructor')
    const work = Promise.reject(new Error('lib-own-rejection'))
    // The getter is only in place while `startWait` runs, which is all of it that is synchronous:
    // the test runner reads the constructor of its own promises between awaits.
    void Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      get() {
        throw new Error('hostile read')
      },
    })
    let wait: ReturnType<typeof startWait<never>>
    try {
      wait = startWait(work, 1000)
    } finally {
      void Object.defineProperty(Promise.prototype, 'constructor', original)
    }
    const outcome = await wait.result
    wait.release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)

    expect(outcome.state).toBe('failed')
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('settles with the work of a frozen promise, which cannot take an own constructor', async () => {
    const work = Object.freeze(Promise.resolve('frozen'))
    const wait = startWait(work, 1000)

    const outcome = await wait.result
    wait.release()

    expect(outcome).toEqual({ state: 'done', v: 'frozen' })
  })

  it('release clears the timer and the abort listener, and may be called twice', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const wait = startWait(Promise.resolve(1), 1000, { signal: controller.signal })
    await wait.result

    wait.release()
    wait.release()

    expect(jest.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('does not keep the process alive for an unref-ed deadline', async () => {
    const unref = jest.spyOn(global, 'setTimeout')
    const wait = startWait(Promise.resolve(1), 1000, { unref: true })
    await wait.result
    wait.release()

    const timer = unref.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    unref.mockRestore()
  })

  it('leaves the timer referenced by default', async () => {
    const spy = jest.spyOn(global, 'setTimeout')
    const wait = startWait(Promise.resolve(1), 1000)
    await wait.result
    wait.release()

    expect((spy.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(true)
    spy.mockRestore()
  })
})

describe('own', () => {
  it('gives a native promise the intrinsic constructor and returns the same promise', () => {
    const promise = Promise.resolve(1)

    expect(own(promise)).toBe(promise)
    expect(Object.hasOwn(promise, 'constructor')).toBe(true)
    expect(promise.constructor).toBe(NativePromise)
  })

  it('returns a foreign thenable untouched', () => {
    const thenable = { then: (): void => undefined } as unknown as Promise<number>

    expect(own(thenable)).toBe(thenable)
    expect(Object.hasOwn(thenable, 'constructor')).toBe(false)
  })

  it('returns a frozen promise as it is, which cannot take the property', () => {
    const frozen = Object.freeze(Promise.resolve(1))

    expect(own(frozen)).toBe(frozen)
    expect(Object.hasOwn(frozen, 'constructor')).toBe(false)
  })
})
