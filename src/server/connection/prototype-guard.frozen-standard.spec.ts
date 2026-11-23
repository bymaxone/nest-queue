/**
 * @fileoverview A standard key of `Object.prototype` that is made non-configurable is refused on that
 * alone. The change cannot be undone, so it has a file of its own: the realm of this file keeps it to
 * its end, and the one row below is the only thing that runs after it.
 * @layer server/connection
 */

import { QueueException } from '../errors/queue-exception'
import { assertPrototypeClean } from './prototype-guard'

describe('a standard key of Object.prototype made non-configurable', () => {
  it('is refused, once, though its value is the same', () => {
    let error: unknown
    Object.defineProperty(Object.prototype, 'hasOwnProperty', { configurable: false })
    try {
      assertPrototypeClean()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(QueueException)
    const body = (error as QueueException).getResponse() as {
      error: { code: string; details: { count: number } }
    }
    expect(body.error.code).toBe('queue.invalid_options')
    expect(body.error.details.count).toBe(1)
  })
})
