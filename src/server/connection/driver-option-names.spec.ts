/**
 * @fileoverview Unit tests for the driver option names: the list is complete against the type of the
 * options of ioredis, `withOwnKeys` gives every name an own key without changing a client, and a key
 * planted on `Object.prototype` after a real client was built is not read from its options. A key planted
 * before the build is a different moment, and the own keys do not cover it.
 * @layer server/connection
 */

import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { DRIVER_OPTION_NAMES, withOwnKeys } from './driver-option-names'

/** The string keys of `Object.prototype`, which no test may leave a key beyond. */
const STANDARD = new Set(Object.getOwnPropertyNames(Object.prototype))

/**
 * Every key of the options of ioredis. A key ioredis adds fails the type check here, and a key it
 * removes does too, so this record and the list under test cannot drift from the driver silently.
 */
const EVERY_RECORDED_KEY = {
  Connector: true,
  autoPipeliningIgnoredCommands: true,
  autoResendUnfulfilledCommands: true,
  autoResubscribe: true,
  blockingTimeout: true,
  blockingTimeoutGrace: true,
  clientInfoTag: true,
  commandQueue: true,
  commandTimeout: true,
  connectTimeout: true,
  connectionName: true,
  db: true,
  disableClientInfo: true,
  disconnectTimeout: true,
  enableAutoPipelining: true,
  enableOfflineQueue: true,
  enableReadyCheck: true,
  enableTLSForSentinelMode: true,
  failoverDetector: true,
  family: true,
  himportFieldsets: true,
  host: true,
  keepAlive: true,
  keyPrefix: true,
  lazyConnect: true,
  maxLoadingRetryTime: true,
  maxRetriesPerRequest: true,
  monitor: true,
  name: true,
  natMap: true,
  noDelay: true,
  offlineQueue: true,
  password: true,
  path: true,
  port: true,
  preferredSlaves: true,
  protocol: true,
  readOnly: true,
  reconnectOnError: true,
  replyMapping: true,
  retryStrategy: true,
  role: true,
  scripts: true,
  sentinelCommandTimeout: true,
  sentinelMaxConnections: true,
  sentinelPassword: true,
  sentinelReconnectStrategy: true,
  sentinelRetryStrategy: true,
  sentinelTLS: true,
  sentinelUsername: true,
  sentinels: true,
  showFriendlyErrorStack: true,
  socketTimeout: true,
  stringNumbers: true,
  tls: true,
  updateSentinels: true,
  username: true,
} as const satisfies Record<keyof RedisOptions, true>

afterEach(() => {
  const extra = Object.getOwnPropertyNames(Object.prototype).filter((n) => !STANDARD.has(n))
  for (const name of extra) Reflect.deleteProperty(Object.prototype, name)
  if (extra.length > 0) throw new Error('a test left a key on Object.prototype')
})

/** A lazy client that is never connected, and is closed when the body is done. */
function withClient<T>(options: object, body: (client: Redis) => T): T {
  const client = new Redis(options)
  try {
    return body(client)
  } finally {
    client.disconnect()
  }
}

/** What a client holds under a name, as a record (the type does not list `timeout`). */
function optionOf(client: Redis, name: string): unknown {
  return (client.options as unknown as Record<string, unknown>)[name]
}

describe('DRIVER_OPTION_NAMES', () => {
  it('is sorted and holds no duplicate', () => {
    expect([...DRIVER_OPTION_NAMES]).toEqual([...DRIVER_OPTION_NAMES].sort())
    expect(new Set(DRIVER_OPTION_NAMES).size).toBe(DRIVER_OPTION_NAMES.length)
  })

  it('holds timeout, which ioredis reads and does not type', () => {
    expect(DRIVER_OPTION_NAMES).toContain('timeout')
  })

  it('holds every key of the options of ioredis, and nothing else but timeout', () => {
    const typed = Object.keys(EVERY_RECORDED_KEY)

    for (const name of typed) expect(DRIVER_OPTION_NAMES).toContain(name)
    expect(DRIVER_OPTION_NAMES.filter((name) => !typed.includes(name))).toEqual(['timeout'])
  })
})

describe('withOwnKeys', () => {
  it('returns an object with no prototype and every name as an own key', () => {
    const options = withOwnKeys({ host: 'h' })

    expect(Object.getPrototypeOf(options)).toBeNull()
    for (const name of DRIVER_OPTION_NAMES) {
      expect(Object.hasOwn(options, name)).toBe(true)
    }
  })

  it('holds undefined for a name the options leave out, and the given value for one they hold', () => {
    const marker = (): number => 1
    const options = withOwnKeys({ host: 'h', port: 1, retryStrategy: marker }) as Record<
      string,
      unknown
    >

    expect(options.path).toBeUndefined()
    expect(options.host).toBe('h')
    expect(options.port).toBe(1)
    expect(options.retryStrategy).toBe(marker)
  })

  it('keeps a key of the options that is not a driver name', () => {
    const options = withOwnKeys({ extra: 1 }) as Record<string, unknown>

    expect(options.extra).toBe(1)
  })

  it('builds the same client as the options alone do, for every name', () => {
    const plain: RedisOptions = { host: '127.0.0.1', port: 6379, lazyConnect: true }

    withClient(plain, (a) => {
      withClient(withOwnKeys(plain), (b) => {
        for (const name of DRIVER_OPTION_NAMES) {
          expect([name, optionOf(b, name)]).toEqual([name, optionOf(a, name)])
        }
        expect(optionOf(b, 'host')).toBe('127.0.0.1')
        expect(optionOf(b, 'port')).toBe(6379)
        expect(optionOf(b, 'retryStrategy')).toBe(optionOf(a, 'retryStrategy'))
        expect(optionOf(b, 'maxRetriesPerRequest')).toBe(20)
        expect(optionOf(b, 'enableOfflineQueue')).toBe(true)
        expect(b.status).toBe('wait')
      })
    })
  })

  it('keeps the values a host gave, over the defaults of ioredis', () => {
    const given: RedisOptions = {
      host: '127.0.0.1',
      port: 6379,
      lazyConnect: true,
      db: 3,
      keyPrefix: 'p:',
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      commandTimeout: 1234,
    }

    withClient(withOwnKeys(given), (client) => {
      expect(client.options.db).toBe(3)
      expect(client.options.keyPrefix).toBe('p:')
      expect(client.options.enableOfflineQueue).toBe(false)
      expect(client.options.maxRetriesPerRequest).toBeNull()
      expect(client.options.commandTimeout).toBe(1234)
    })
  })
})

/** Plant `name` on `Object.prototype`, run `body`, and take it off again. */
function planted<T>(name: string, enumerable: boolean, marker: string, body: () => T): T {
  Object.defineProperty(Object.prototype, name, {
    value: marker,
    configurable: true,
    writable: true,
    enumerable,
  })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, name)
  }
}

/** The option a lazy client reads under `name` when built from `options`. */
function readBuilt(options: object, name: string): unknown {
  return withClient(options, (client) => optionOf(client, name))
}

/** What the read of a name is when the client could not be built. */
const THROWN = Symbol('thrown')

const BASE: RedisOptions = { host: '127.0.0.1', port: 6379, lazyConnect: true }

describe('a key planted on Object.prototype BEFORE the client is built', () => {
  // Moment one: the plant precedes the build. A key that is not enumerable is found only by a read of
  // the name on the options object, and an own `undefined` shadows it. The plant the own keys do not
  // stop is the enumerable one, below.
  it.each([...DRIVER_OPTION_NAMES])(
    'is not read from a client built with the names own: %s',
    (name) => {
      const marker = `planted-${name}`

      const read = planted(name, false, marker, () => readBuilt(withOwnKeys(BASE), name))

      expect(read).not.toBe(marker)
    },
  )

  it('is read from a client built without the names own, which is what they prevent', () => {
    const read = planted('path', false, 'planted-path', () => readBuilt(BASE, 'path'))

    expect(read).toBe('planted-path')
  })

  // MEASURED LIMIT, before the build only. A key planted by assignment is enumerable, and ioredis fills the options with
  // `defaults(options, Redis.defaultOptions)`, which walks `for (key in defaultOptions)`: that walk
  // finds the planted key through the prototype and copies it into any option that holds `undefined`,
  // own or absent. The own keys cannot stop that; the names below are the ones with no default of
  // ioredis's own, which therefore receive the planted value. The refusal of a polluted prototype
  // before the client is built (see the resolver) is what covers them. If ioredis changes this walk,
  // this list is the thing to shrink.
  const READ_WHEN_ENUMERABLE: ReadonlySet<string> = new Set([
    'blockingTimeout',
    'commandQueue',
    'commandTimeout',
    'monitor',
    'offlineQueue',
    'path',
    'preferredSlaves',
    'sentinelCommandTimeout',
    'sentinelPassword',
    'sentinelTLS',
    'sentinelUsername',
    'showFriendlyErrorStack',
    'socketTimeout',
    'timeout',
    'tls',
  ])

  // These three are read and used while the client is built, so the planted marker makes the
  // construction throw instead of being left in the options.
  const THROWS_WHEN_ENUMERABLE: ReadonlySet<string> = new Set([
    'Connector',
    'himportFieldsets',
    'scripts',
  ])

  it.each([...DRIVER_OPTION_NAMES])('is read as ioredis reads an enumerable key: %s', (name) => {
    const marker = `planted-${name}`

    const read = planted(name, true, marker, () => {
      try {
        return readBuilt(withOwnKeys(BASE), name)
      } catch {
        return THROWN
      }
    })

    if (THROWS_WHEN_ENUMERABLE.has(name)) expect(read).toBe(THROWN)
    else if (READ_WHEN_ENUMERABLE.has(name)) expect(read).toBe(marker)
    else expect(read).not.toBe(marker)
  })
})

/** The names ioredis reads from `client.options` after the build, as measured on ioredis 6.0.0. */
const READ_AFTER_BUILD: readonly string[] = [
  'Connector',
  'blockingTimeout',
  'commandQueue',
  'commandTimeout',
  'monitor',
  'offlineQueue',
  'path',
  'preferredSlaves',
  'scripts',
  'sentinelCommandTimeout',
  'sentinelPassword',
  'sentinelTLS',
  'sentinelUsername',
  'showFriendlyErrorStack',
  'socketTimeout',
  'timeout',
  'tls',
]

/** Build a lazy client from `options`, THEN plant `name`, and report what the client reads under it. */
function readPlantedAfterBuild(options: object, name: string, enumerable: boolean): unknown {
  const client = new Redis(options)
  try {
    return planted(name, enumerable, `planted-${name}`, () => optionOf(client, name))
  } finally {
    client.disconnect()
  }
}

describe('a key planted on Object.prototype AFTER the client is built', () => {
  // Moment two: the plant follows the build, which is what a reconnect of a long-lived client meets.
  // An own `undefined` on the options shadows it, for every name and for both kinds of plant.
  it.each(
    [true, false].flatMap((enumerable) =>
      DRIVER_OPTION_NAMES.map((name) => [name, enumerable] as const),
    ),
  )(
    'is not read from a client built with the names own: %s (enumerable %s)',
    (name, enumerable) => {
      const read = readPlantedAfterBuild(withOwnKeys(BASE), name, enumerable)

      expect(read).not.toBe(`planted-${name}`)
    },
  )

  // Control: without the own keys the same plant IS read for these names, so the shadow matters.
  it.each(
    [true, false].flatMap((enumerable) =>
      READ_AFTER_BUILD.map((name) => [name, enumerable] as const),
    ),
  )('is read from a client built without the names own: %s (enumerable %s)', (name, enumerable) => {
    const read = readPlantedAfterBuild(BASE, name, enumerable)

    expect(read).toBe(`planted-${name}`)
  })

  it('lists only names that are driver option names', () => {
    for (const name of READ_AFTER_BUILD) expect(DRIVER_OPTION_NAMES).toContain(name)
    expect(READ_AFTER_BUILD).toHaveLength(17)
  })
})
