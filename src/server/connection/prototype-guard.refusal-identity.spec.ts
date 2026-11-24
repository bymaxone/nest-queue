/**
 * @fileoverview Unit tests that `isGuardRefusal` recognises the refusals the guard throws, whichever
 * count they carry, by identity, and nothing else: an ordinary error, a missing value, and a lookalike
 * exception with the same code and details are not taken for one.
 * @layer server/connection
 */

import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import { assertPrototypeClean, isGuardRefusal } from './prototype-guard'

const planted: string[] = []

afterEach(() => {
  for (const key of planted) void Reflect.deleteProperty(Object.prototype, key)
  planted.length = 0
})

/** Plant `count` unknown keys on `Object.prototype` and return what the guard throws. */
function refusalWith(count: number): unknown {
  for (let n = 0; n < count; n += 1) {
    const key = `planted${String(n)}`
    planted.push(key)
    Reflect.set(Object.prototype, key, 1)
  }
  try {
    assertPrototypeClean()
  } catch (error) {
    return error
  }
  throw new Error('the guard did not refuse')
}

describe('isGuardRefusal', () => {
  it.each([1, 2, 5])('recognises the refusal that reports %i defects', (count) => {
    expect(isGuardRefusal(refusalWith(count))).toBe(true)
  })

  it('does not take an ordinary error, a missing value or a primitive for a refusal', () => {
    expect(isGuardRefusal(new Error('failed'))).toBe(false)
    expect(isGuardRefusal(undefined)).toBe(false)
    expect(isGuardRefusal('queue.invalid_options')).toBe(false)
  })

  it('does not take a lookalike with the same code and status for a refusal', () => {
    const lookalike = new QueueException(
      QUEUE_ERROR_CODES.INVALID_OPTIONS,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { count: 1 },
    )

    expect(isGuardRefusal(lookalike)).toBe(false)
  })
})
