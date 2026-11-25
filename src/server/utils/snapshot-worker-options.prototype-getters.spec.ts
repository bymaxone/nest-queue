/**
 * @fileoverview Unit tests that each option of a worker the library copies by name is read when the
 * host defines it as a getter on a class prototype, as a class instance does. Each name has a row of
 * its own, so a name dropped from the list the copy reads fails exactly one row.
 * @layer server/utils
 */

import { snapshotWorkerOptions } from './snapshot-worker-options'

/** A host with no own field, whose `name` is a getter on its class prototype. */
function hostWith(name: string, value: unknown): never {
  class Host {}
  Object.defineProperty(Host.prototype, name, { get: () => value, configurable: true })
  return new Host() as never
}

describe('the options of a worker that are getters on a class prototype', () => {
  it.each([
    ['concurrency', 4],
    ['limiter', { max: 5, duration: 1000 }],
    ['autorun', false],
    ['lockDuration', 45_000],
    ['stalledInterval', 20_000],
    ['jobTimeoutMs', 9000],
  ])('reads %s', (name, value) => {
    const copy: Record<string, unknown> = snapshotWorkerOptions(hostWith(name, value))

    expect(copy[name]).toEqual(value)
  })

  it('reads a name given beyond the base options', () => {
    const copy: Record<string, unknown> = snapshotWorkerOptions(
      hostWith('useWorkerThreads', true),
      ['useWorkerThreads'],
    )

    expect(copy.useWorkerThreads).toBe(true)
  })
})
