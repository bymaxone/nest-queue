/**
 * @fileoverview Unit tests for the connection validation utilities.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'
import { assertBlockingConnection, isClientUsable } from './validate-connection'
import { duplicateConnection } from './duplicate-connection'
import { QueueException } from '../errors/queue-exception'

/** Build a minimal Redis-like stub exposing only the fields under test. */
function makeClient(partial: Partial<Redis>): Redis {
  return partial as Redis
}

describe('assertBlockingConnection', () => {
  it('passes when maxRetriesPerRequest is exactly null', () => {
    // A duplicated probe with the override applied must not throw.
    const client = makeClient({ options: { maxRetriesPerRequest: null } })
    expect(() => {
      assertBlockingConnection(client)
    }).not.toThrow()
  })

  it('throws CONNECTION_REQUIRES_NULL_RETRIES when the value is a number', () => {
    // A non-null value means the duplicate() override was ignored — fail fast.
    const client = makeClient({ options: { maxRetriesPerRequest: 20 } })
    expect(() => {
      assertBlockingConnection(client)
    }).toThrow(QueueException)
  })

  it('reports the actual value and the expected null in details', () => {
    // The exception carries scalar config values for debugging, never secrets.
    const client = makeClient({ options: { maxRetriesPerRequest: 20 } })
    try {
      assertBlockingConnection(client)
      fail('expected throw')
    } catch (err) {
      const response = (err as QueueException).getResponse() as {
        error: { code: string; details: { actualValue: unknown; expectedValue: unknown } }
      }
      expect(response.error.code).toBe('queue.connection_requires_null_retries')
      expect(response.error.details.actualValue).toBe(20)
      expect(response.error.details.expectedValue).toBeNull()
    }
  })

  it('throws and reports null actualValue when options is undefined', () => {
    // A client without options is treated as ignoring the override.
    const client = makeClient({})
    try {
      assertBlockingConnection(client)
      fail('expected throw')
    } catch (err) {
      const response = (err as QueueException).getResponse() as {
        error: { details: { actualValue: unknown } }
      }
      expect(response.error.details.actualValue).toBeNull()
    }
  })
})

describe('isClientUsable', () => {
  it('returns true for a ready client', () => {
    // Ready is the normal accepted state for a BYO client.
    expect(isClientUsable(makeClient({ status: 'ready' }))).toBe(true)
  })

  it('returns true for a connecting client', () => {
    // BullMQ tolerates connecting clients handed to it.
    expect(isClientUsable(makeClient({ status: 'connecting' }))).toBe(true)
  })

  it('returns false for an ended client', () => {
    // An end/close status is unusable and must be rejected upstream.
    expect(isClientUsable(makeClient({ status: 'end' }))).toBe(false)
  })
})

describe('duplicateConnection', () => {
  it('duplicates the client forcing maxRetriesPerRequest to null', () => {
    // The override is the contract that makes the duplicate safe for blocking commands.
    const duplicate = makeClient({ options: { maxRetriesPerRequest: null } })
    const duplicateSpy: Redis['duplicate'] = jest.fn().mockReturnValue(duplicate)
    const source = makeClient({ duplicate: duplicateSpy })

    const result = duplicateConnection(source)

    expect(duplicateSpy).toHaveBeenCalledWith({ maxRetriesPerRequest: null })
    expect(result).toBe(duplicate)
  })
})
