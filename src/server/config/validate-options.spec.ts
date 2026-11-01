/**
 * @fileoverview Unit tests for bootstrap option validation.
 * @layer server/config
 */

import { Redis } from 'ioredis'
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
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection is required')
  })

  it('throws when connection is explicitly null', () => {
    // A null connection is treated as missing, not dereferenced.
    const opts = { connection: null } as unknown as BymaxQueueModuleOptions
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection is required')
  })

  it('throws a typed exception (not a raw TypeError) for a primitive connection', () => {
    // A misconfigured connection string must yield INVALID_OPTIONS, never a TypeError from `in`.
    const opts = { connection: 'redis://localhost:6379' } as unknown as BymaxQueueModuleOptions
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection is required')
  })

  it('throws when connection specifies none of client/url/options', () => {
    // An empty connection object cannot be resolved into a client.
    const opts = { connection: {} as never }
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection must specify client | url | options')
  })

  it('throws when client coexists with url', () => {
    // Mode A and Mode B are mutually exclusive.
    const opts = { connection: { client: {}, url: 'redis://x' } as never }
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection.client is mutually exclusive with url/options')
  })

  it('throws when client coexists with options', () => {
    // Passing options alongside a client is ambiguous.
    const opts = { connection: { client: {}, options: {} } as never }
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection.client is mutually exclusive with url/options')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a number', 6379],
    ['an object', {}],
  ])('throws when connection.url is %s', (_label, url) => {
    // ioredis turns each of these into a silent connection to localhost (or to a port named by
    // the number), so the module must refuse them before a client is ever built.
    const opts = { connection: { url } } as unknown as BymaxQueueModuleOptions
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection.url must be a non-empty string')
  })

  it('refuses an unusable url even when options accompany it', () => {
    // `{ url, options }` is a valid arm, so a bad url there is refused too, not defaulted.
    const opts = {
      connection: { url: '', options: { host: 'redis.internal' } },
    } as unknown as BymaxQueueModuleOptions
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('connection.url must be a non-empty string')
  })

  it('accepts a url together with options', () => {
    // The `{ url, options }` arm stays valid when the url is a real string.
    expect(() => {
      validateOptions({ connection: { url: 'redis://localhost:6379', options: { db: 1 } } })
    }).not.toThrow()
  })

  // Strings ioredis refuses with a raw `TypeError: Invalid URL`, which the module turns into a typed error.
  const unparseable = [
    'not a url',
    'redis://h:99999',
    'redis://h:abc',
    'a b:1',
    'h:abc',
    '//a b:1',
    'a:redis://h',
  ]
  // Strings ioredis accepts, in every form its parser handles.
  const parseable = [
    'redis://localhost:6379',
    'rediss://user:pass@h:2/3',
    'redis://[::1]:6379',
    'REDIS://H:1',
    '127.0.0.1:6379',
    'localhost:6379',
    '//h:1',
    'h',
    '/var/run/redis.sock',
    '/tmp/redis.sock?db=2',
  ]

  it.each(unparseable)('throws a typed error when connection.url is %j', (url) => {
    // ioredis would throw `Invalid URL` at client construction, far from the configuration.
    expect(
      reasonOf(() => {
        validateOptions({ connection: { url } })
      }),
    ).toBe('connection.url is not a valid Redis URL')
  })

  it.each(parseable)('accepts connection.url %j', (url) => {
    // Unix socket paths and bare host[:port] are valid ioredis input, not only redis:// URLs.
    expect(() => {
      validateOptions({ connection: { url } })
    }).not.toThrow()
  })

  it.each([...unparseable, ...parseable])('agrees with ioredis about %j', (url) => {
    // The rule is "refuse what ioredis cannot parse", so it is measured against ioredis itself
    // rather than against a list of cases written to match it.
    const client = ((): Redis | undefined => {
      try {
        return new Redis(url, { lazyConnect: true })
      } catch {
        return undefined
      }
    })()
    client?.disconnect()
    const refused = ((): boolean => {
      try {
        validateOptions({ connection: { url } })
        return false
      } catch {
        return true
      }
    })()
    expect(refused).toBe(client === undefined)
  })

  it('throws when shutdown.drainTimeoutMs is not positive', () => {
    // A non-positive drain timeout would force-close immediately.
    const opts: BymaxQueueModuleOptions = {
      connection: { url: 'redis://x' },
      shutdown: { drainTimeoutMs: 0 },
    }
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('shutdown.drainTimeoutMs must be > 0')
  })

  it('throws when metrics.cacheTtlMs is negative', () => {
    // A negative TTL is meaningless.
    const opts: BymaxQueueModuleOptions = {
      connection: { url: 'redis://x' },
      metrics: { cacheTtlMs: -1 },
    }
    expect(
      reasonOf(() => {
        validateOptions(opts)
      }),
    ).toBe('metrics.cacheTtlMs must be >= 0')
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
