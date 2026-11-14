/**
 * @fileoverview Unit tests for `quitWithin`: a quit that is bounded, followed by a disconnect only
 * when it failed or went unanswered, that never rejects and leaves no timer that holds the process.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'
import { quitWithin } from './quit-within'

/** A client stub in `status` whose `quit` is `quit`, and its `disconnect` spy. */
function clientWith(
  quit: () => Promise<unknown>,
  status = 'ready',
): { client: Redis; disconnect: jest.Mock } {
  const disconnect = jest.fn()
  return { client: { status, quit, disconnect } as unknown as Redis, disconnect }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('quitWithin', () => {
  it('leaves an answered quit alone, and holds no timer afterwards', async () => {
    jest.useFakeTimers()
    const { client, disconnect } = clientWith(() => Promise.resolve('OK'))

    await quitWithin(client, 1000)

    expect(disconnect).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('disconnects after a quit that failed, without rejecting', async () => {
    const { client, disconnect } = clientWith(() =>
      Promise.reject(new Error('Connection is closed.')),
    )

    await expect(quitWithin(client, 1000)).resolves.toBeUndefined()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  // A frozen Redis answers nothing: the bound ends the wait, not the client's own command deadline.
  it('disconnects a quit still unanswered at the bound, and absorbs its late failure', async () => {
    jest.useFakeTimers()
    let fail: (err: Error) => void = () => undefined
    const { client, disconnect } = clientWith(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )

    const done = quitWithin(client, 1000)
    await jest.advanceTimersByTimeAsync(999)
    expect(disconnect).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBeUndefined()

    expect(disconnect).toHaveBeenCalledTimes(1)
    // The quit that was given up on rejects later: nothing may surface from it.
    fail(new Error('Command timed out'))
    await jest.advanceTimersByTimeAsync(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([
    ['failed', () => Promise.reject(new Error('Connection is closed.'))],
    ['unanswered', () => new Promise<never>(() => undefined)],
  ])('never disconnects a client that has already ended, whose quit %s', async (_label, quit) => {
    jest.useFakeTimers()
    const { client, disconnect } = clientWith(quit, 'end')

    const done = quitWithin(client, 500)
    await jest.advanceTimersByTimeAsync(500)
    await done

    expect(disconnect).not.toHaveBeenCalled()
  })

  // The timer exists only to bound the wait: it must not keep the process alive on its own.
  it('arms an unref-ed timer', async () => {
    jest.useFakeTimers()
    const armed = jest.spyOn(globalThis, 'setTimeout')
    const { client } = clientWith(() => Promise.resolve('OK'))

    await quitWithin(client, 1000)

    const timer = armed.mock.results[0]?.value as { hasRef(): boolean }
    expect(timer.hasRef()).toBe(false)
  })
})
