/**
 * @fileoverview Unit tests for the guard around a read of the host's objects: the refusal it builds
 * for each part of the library, the reason it names, and the cause it keeps as a field a caller can
 * still read, change and redefine like the cause of any error.
 * @layer server/config
 */

import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { QueueException } from '../errors/queue-exception'
import { bulkUnreadable, guarded, invalidOptions, invalidRepeat } from './guarded-read'

/** The code, the status and the reason of a refusal. */
function describeRefusal(error: QueueException): { code: string; status: number; reason: unknown } {
  const body = error.getResponse() as { error: { code: string; details: { reason: unknown } } }
  return { code: body.error.code, status: error.getStatus(), reason: body.error.details.reason }
}

describe('the refusals a guarded read can end in', () => {
  it.each([
    [
      'invalidOptions',
      invalidOptions,
      QUEUE_ERROR_CODES.INVALID_OPTIONS,
      HttpStatus.INTERNAL_SERVER_ERROR,
    ],
    [
      'invalidRepeat',
      invalidRepeat,
      QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS,
      HttpStatus.BAD_REQUEST,
    ],
    [
      'bulkUnreadable',
      bulkUnreadable,
      QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED,
      HttpStatus.BAD_REQUEST,
    ],
  ])(
    '%s carries its code, its status and a reason that names what could not be read',
    (_name, build, code, status) => {
      expect(describeRefusal(build('the thing'))).toEqual({
        code,
        status,
        reason: 'the thing could not be read',
      })
    },
  )
})

describe('guarded', () => {
  it('returns what the read returns', () => {
    expect(guarded('x', () => 5)).toBe(5)
  })

  it('refuses a read that throws with the module-option refusal by default, and keeps the host error as the cause', () => {
    const boom = new Error('host')
    let thrown: QueueException | undefined
    try {
      guarded('the thing', () => {
        throw boom
      })
    } catch (error) {
      thrown = error as QueueException
    }

    expect(describeRefusal(thrown!)).toEqual({
      code: QUEUE_ERROR_CODES.INVALID_OPTIONS,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      reason: 'the thing could not be read',
    })
    expect(thrown!.cause).toBe(boom)
  })

  it('keeps the cause as an ordinary field: writable and configurable, and not shown by enumeration', () => {
    let thrown: QueueException | undefined
    try {
      guarded('x', () => {
        throw new Error('host')
      })
    } catch (error) {
      thrown = error as QueueException
    }

    const descriptor = Object.getOwnPropertyDescriptor(thrown, 'cause')

    expect(descriptor).toMatchObject({ writable: true, configurable: true, enumerable: false })
  })

  it('builds the refusal the caller names', () => {
    let thrown: QueueException | undefined
    try {
      guarded(
        'y',
        () => {
          throw new Error('host')
        },
        bulkUnreadable,
      )
    } catch (error) {
      thrown = error as QueueException
    }

    expect(describeRefusal(thrown!).code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
  })
})
