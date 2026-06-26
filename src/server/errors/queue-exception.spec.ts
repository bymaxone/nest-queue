/**
 * @fileoverview Unit tests for the QueueException response shape.
 * @layer server/errors
 */

import { HttpStatus } from '@nestjs/common'
import { QueueException } from './queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/** Narrow the exception body to the documented response shape. */
function bodyOf(exception: QueueException): {
  error: { code: string; message: string; details: unknown }
} {
  return exception.getResponse() as { error: { code: string; message: string; details: unknown } }
}

describe('QueueException', () => {
  it('resolves a known code to its catalog message and keeps details', () => {
    // A catalog code surfaces its human-readable message and scalar details.
    const exception = new QueueException(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, HttpStatus.INTERNAL_SERVER_ERROR, {
      timeoutMs: 10_000,
    })
    const body = bodyOf(exception)

    expect(body.error.code).toBe('queue.connection_timeout')
    expect(body.error.message).toBe('Redis connection timeout')
    expect(body.error.details).toEqual({ timeoutMs: 10_000 })
    expect(exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
  })

  it('falls back to a generic message for an unknown code', () => {
    // Defensive default keeps the response well-formed for unmapped codes.
    const exception = new QueueException('queue.not_in_catalog')
    expect(bodyOf(exception).error.message).toBe('Queue error')
  })

  it('uses a null details payload when none is provided', () => {
    // Absent details serialize to null rather than undefined.
    const exception = new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS)
    expect(bodyOf(exception).error.details).toBeNull()
  })

  it('defaults the HTTP status to 500 when omitted', () => {
    // The default status is internal-server-error.
    const exception = new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS)
    expect(exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
  })
})
