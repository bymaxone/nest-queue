/**
 * @fileoverview Unit tests for bootstrap option validation.
 * @layer server/config
 */

import { validateOptions } from './validate-options'
import { QueueException } from '../errors/queue-exception'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'

/** Read the failing reason out of a thrown QueueException. */
function reasonOf(run: () => void): string {
  try {
    run()
    throw new Error('expected throw')
  } catch (err) {
    if (!(err instanceof QueueException)) throw err
    const body = err.getResponse() as { error: { details: { reason: string } } }
    return body.error.details.reason
  }
}

describe('validateOptions', () => {
  it('accepts a minimal Mode B (url) configuration', () => {
    // The happy path leaves the options untouched.
    expect(() => {
      validateOptions({ connection: { url: 'redis://localhost:6379' } })
    }).not.toThrow()
  })

  it('throws when connection is missing', () => {
    // connection is required for the module to function.
    const opts = {} as BymaxQueueModuleOptions
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('connection is required')
  })

  it('throws when connection is explicitly null', () => {
    // A null connection is treated as missing, not dereferenced.
    const opts = { connection: null } as unknown as BymaxQueueModuleOptions
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('connection is required')
  })

  it('throws a typed exception (not a raw TypeError) for a primitive connection', () => {
    // A misconfigured connection string must yield INVALID_OPTIONS, never a TypeError from `in`.
    const opts = { connection: 'redis://localhost:6379' } as unknown as BymaxQueueModuleOptions
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('connection is required')
  })

  it('throws when connection specifies none of client/url/options', () => {
    // An empty connection object cannot be resolved into a client.
    const opts = { connection: {} as never }
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('connection must specify client | url | options')
  })

  it('throws when client coexists with url', () => {
    // Mode A and Mode B are mutually exclusive.
    const opts = { connection: { client: {}, url: 'redis://x' } as never }
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('connection.client is mutually exclusive with url/options')
  })

  it('throws when client coexists with options', () => {
    // Passing options alongside a client is ambiguous.
    const opts = { connection: { client: {}, options: {} } as never }
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('connection.client is mutually exclusive with url/options')
  })

  it('throws when shutdown.drainTimeoutMs is not positive', () => {
    // A non-positive drain timeout would force-close immediately.
    const opts: BymaxQueueModuleOptions = {
      connection: { url: 'redis://x' },
      shutdown: { drainTimeoutMs: 0 },
    }
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('shutdown.drainTimeoutMs must be > 0')
  })

  it('throws when metrics.cacheTtlMs is negative', () => {
    // A negative TTL is meaningless.
    const opts: BymaxQueueModuleOptions = {
      connection: { url: 'redis://x' },
      metrics: { cacheTtlMs: -1 },
    }
    expect(reasonOf(() => {
      validateOptions(opts)
    })).toBe('metrics.cacheTtlMs must be >= 0')
  })

  it('accepts a zero metrics.cacheTtlMs and a positive drain timeout', () => {
    // Zero TTL (always fresh) and a positive drain window are both valid.
    expect(() => {
      validateOptions({
        connection: { options: { host: 'localhost' } },
        metrics: { cacheTtlMs: 0 },
        shutdown: { drainTimeoutMs: 1000 },
      })
    }).not.toThrow()
  })
})
