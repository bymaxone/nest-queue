/**
 * @fileoverview The bounded wait the library's decisions are built on: how a piece of work and a
 * deadline settle into one verdict without a `Promise` static on the path. `Promise.race` reads
 * `Promise.resolve` and the `then` of each element when it runs, so a host that replaced either one
 * decides the verdict. This builds the verdict as one native promise made from the intrinsic
 * constructor, settled by an async function that awaits the work, through an object with no
 * prototype: resolving a promise with an ordinary object reads its `then` off `Object.prototype`,
 * where a planted one would answer in the work's place. The guard runs synchronously before every
 * await, so a host cannot change what the await reads between the check and the read.
 * @layer server/utils
 */

import { types } from 'node:util'

import { assertPrototypeClean, NativePromise } from '../connection/prototype-guard'

/** The built-ins the wait runs on, taken when this module loaded. */
const create = Object.create
const define = Object.defineProperty
const isNativePromise = types.isPromise

/**
 * Give a native promise an own `constructor` that is the intrinsic one, so that an `await` of it
 * takes the path for a promise of its own kind and reads neither `Promise.prototype.constructor`
 * nor a species from anywhere a host could have replaced. Left as it is when the promise cannot
 * take the property (a frozen one): the await then reads the prototype, which the guard checks.
 */
function ownConstructor(promise: Promise<unknown>): void {
  try {
    void define(promise, 'constructor', {
      value: NativePromise,
      configurable: true,
      writable: true,
    })
  } catch {
    // A promise that cannot take the property keeps reading the one on its prototype.
  }
}

/** Awaits `work` and says nothing: its only purpose is to be a listener for the rejection. */
async function hearRejectionOf(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    // Heard, and nothing to do: `run` is the separate reader that reports it.
  }
}

/**
 * Hear the rejection of `work` before anything else can fail, so that a wait that is refused before
 * its await never leaves a rejection behind with no listener. It reads nothing a host can replace:
 * the brand check is the engine's, and the await of a promise with an own intrinsic `constructor`
 * attaches its listener directly, where `then` would read the constructor and its species. A value
 * that is not a native promise is left to the await that follows, so a foreign thenable is not
 * subscribed twice.
 */
function hearRejection(work: Promise<unknown>): void {
  if (!isNativePromise(work)) return
  ownConstructor(work)
  void hearRejectionOf(work)
}

/** How a wait ended: the work answered, the work failed, or the bound or the signal ended it first. */
export type WaitOutcome<T> =
  | { readonly state: 'done'; readonly v: T }
  | { readonly state: 'failed'; readonly v: unknown }
  | { readonly state: 'expired'; readonly v: undefined }

/** A running wait: the verdict, and what to call once it has been read. */
export interface BoundedWait<T> {
  /** Settles once, with a verdict that has no prototype, and never rejects. */
  readonly result: Promise<WaitOutcome<T>>
  /** Clears the timer and the abort listener. Safe to call more than once. */
  release(): void
}

/** What a wait may be given besides the work and the bound. */
export interface BoundedWaitOptions {
  /** Ends the wait as `expired` when aborted, or at once when already aborted. */
  readonly signal?: AbortSignal
  /** Do not let the deadline's timer keep the process alive. */
  readonly unref?: boolean
}

/** A verdict with no prototype, so that resolving a promise with it reads no `then` from anywhere. */
function verdict<T>(state: 'done' | 'failed' | 'expired', v: unknown): WaitOutcome<T> {
  const box = create(null) as { state: string; v: unknown }
  box.state = state
  box.v = v
  return box as WaitOutcome<T>
}

/**
 * Start waiting for `work`, bounded by `timeoutMs` and by an optional signal. The wait on the work
 * starts before the timer is armed. The caller runs `assertPrototypeClean()` and awaits `result` in
 * the same synchronous step, and calls `release()` afterwards.
 *
 * Nothing started here can reject: the async function that awaits the work catches whatever the work
 * or the guard throws and reports it as `failed`, and the deadline only ever resolves.
 *
 * @param work - What is waited for.
 * @param timeoutMs - The bound, in milliseconds.
 * @param options - The signal that also ends the wait, and whether the timer is unref-ed.
 * @example
 * const wait = startWait(client.ping(), 2000)
 * try {
 *   assertPrototypeClean()
 *   const outcome = await wait.result
 * } finally {
 *   wait.release()
 * }
 */
export function startWait<T>(
  work: Promise<T>,
  timeoutMs: number,
  options: BoundedWaitOptions = {},
): BoundedWait<T> {
  hearRejection(work)
  let settle: (outcome: WaitOutcome<T>) => void
  const result = new NativePromise<WaitOutcome<T>>((resolve) => {
    settle = resolve
  })
  ownConstructor(result)
  const run = async (): Promise<void> => {
    let outcome: WaitOutcome<T>
    try {
      assertPrototypeClean()
      outcome = verdict<T>('done', await work)
    } catch (error) {
      outcome = verdict<T>('failed', error)
    }
    settle(outcome)
  }
  void run()
  const expire = (): void => {
    settle(verdict<T>('expired', undefined))
  }
  const timer = setTimeout(expire, timeoutMs)
  if (options.unref === true) timer.unref()
  const { signal } = options
  if (signal?.aborted === true) expire()
  else signal?.addEventListener('abort', expire)
  return {
    result,
    release: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', expire)
    },
  }
}
