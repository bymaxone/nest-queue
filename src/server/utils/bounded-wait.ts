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

import { assertPrototypeClean, NativePromise } from '../connection/prototype-guard'

/** The built-ins the wait runs on, taken when this module loaded. */
const create = Object.create
const apply = Reflect.apply
const nativeThen = Object.getOwnPropertyDescriptor(NativePromise.prototype, 'then')?.value as (
  this: Promise<unknown>,
  onFulfilled: () => void,
  onRejected: () => void,
) => unknown

/** The handler that marks a rejection as heard without acting on it. */
function ignore(): void {
  // Nothing: the await that reports the failure is a separate reader of the same promise.
}

/**
 * Hear the rejection of `work` before anything else can fail, so that a wait that is refused before
 * its await never leaves a rejection behind with no listener. A promise that is not native, which
 * the engine's `then` cannot be applied to, is left to the await that follows.
 */
function hearRejection(work: Promise<unknown>): void {
  try {
    void apply(nativeThen, work, [ignore, ignore])
  } catch {
    // Not a native promise: the await that follows is its only reader.
  }
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
