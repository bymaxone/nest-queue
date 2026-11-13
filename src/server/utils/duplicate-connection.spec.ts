/**
 * @fileoverview Unit tests for the blocking-role connection duplicate.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'
import { duplicateConnection } from './duplicate-connection'

describe('duplicateConnection', () => {
  // A worker blocks on BZPOPMIN/BLMOVE for longer than any command deadline, and its loop has to
  // survive a reconnect: the duplicate must not inherit the producer's fail-fast policy.
  it('overrides the producer policy for the blocking roles', () => {
    const duplicate = jest.fn<unknown, [Record<string, unknown>]>().mockReturnValue('dup')
    const result = duplicateConnection({ duplicate } as unknown as Redis)

    expect(result).toBe('dup')
    const override = duplicate.mock.calls[0]?.[0] ?? {}
    expect(override.maxRetriesPerRequest).toBeNull()
    expect(override.enableOfflineQueue).toBe(true)
    expect('commandTimeout' in override).toBe(true)
    expect(override.commandTimeout).toBeUndefined()
  })
})
