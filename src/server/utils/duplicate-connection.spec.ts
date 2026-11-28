/**
 * @fileoverview Unit tests for the blocking-role connection duplicate.
 * @layer server/utils
 */

import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { duplicateConnection } from './duplicate-connection'

describe('duplicateConnection', () => {
  // A worker blocks on BZPOPMIN/BLMOVE for longer than any command deadline, and its loop has to
  // survive a reconnect: the duplicate must not inherit the producer's fail-fast policy.
  it('overrides the producer policy for the blocking roles', () => {
    const copy = { on: jest.fn() }
    const duplicate = jest.fn<unknown, [Record<string, unknown>]>().mockReturnValue(copy)
    const result = duplicateConnection(
      { duplicate } as unknown as Redis,
      new Logger('test'),
      'test',
    )

    expect(result).toBe(copy)
    const override = duplicate.mock.calls[0]?.[0] ?? {}
    expect(override.maxRetriesPerRequest).toBeNull()
    expect(override.enableOfflineQueue).toBe(true)
    expect('commandTimeout' in override).toBe(true)
    expect(override.commandTimeout).toBeUndefined()
  })

  it('gives the duplicate an error listener that logs under its role', () => {
    const logger = new Logger('test')
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    const on = jest.fn<undefined, [string, (err: unknown) => void]>()
    const source = { duplicate: () => ({ on }) } as unknown as Redis

    duplicateConnection(source, logger, 'worker: q')

    expect(on).toHaveBeenCalledTimes(1)
    expect(on.mock.calls[0]?.[0]).toBe('error')
    on.mock.calls[0]?.[1](new Error('gone'))
    expect(JSON.stringify(logged.mock.calls)).toContain('(worker: q)')
  })
})
