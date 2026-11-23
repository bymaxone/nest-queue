/**
 * @fileoverview Tests for the probe `guardSentinelConnector` installs on a sentinel connector: the
 * options it builds for the client that asks one sentinel for the master, branch by branch, checked
 * against a mocked driver client that records what it was constructed with.
 * @layer server/connection
 */

import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { DRIVER_OPTION_NAMES } from './driver-option-names'
import { GuardedConnector, guardSentinelConnector } from './guarded-connector'

jest.mock('ioredis', () => ({
  AbstractConnector: jest.requireActual<{ AbstractConnector: unknown }>('ioredis')
    .AbstractConnector,
  Redis: jest.fn(),
}))

const RedisMock = Redis as unknown as jest.Mock

/** The probe builder as the wrapper leaves it on the connector. */
interface IProbeConnector {
  options: RedisOptions
  connect: jest.Mock
  connectToSentinel: (endpoint: object, probeOptions?: object) => unknown
}

beforeEach(() => {
  RedisMock.mockClear()
})

/** Wrap a fake sentinel client over `options` and return its connector. */
function wrapped(options: object): IProbeConnector {
  const connector = { options, connect: jest.fn(), connectToSentinel: jest.fn() }
  guardSentinelConnector({ connector })
  return connector
}

/** Ask for a probe and return the options the driver client was constructed with. */
function built(options: object, endpoint: object, probeOptions?: object): Record<string, unknown> {
  const connector = wrapped(options)
  connector.connectToSentinel(endpoint, probeOptions)
  expect(RedisMock).toHaveBeenCalledTimes(1)
  return (RedisMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>
}

describe('the probe of a guarded sentinel connector', () => {
  it('returns the client it built', () => {
    const connector = wrapped({})

    const probe = connector.connectToSentinel({ host: 'h' })

    expect(probe).toBeInstanceOf(Redis)
    expect(probe).toBe(RedisMock.mock.instances[0])
  })

  it('carries the guarded connector and an own key for every driver option', () => {
    const options = built({}, { host: 'h' })

    expect(options.Connector).toBe(GuardedConnector)
    expect(Object.getPrototypeOf(options)).toBeNull()
    for (const name of DRIVER_OPTION_NAMES) expect(Object.hasOwn(options, name)).toBe(true)
    expect(options.lazyConnect).toBeUndefined()
  })

  it('sends null credentials when the sentinel ones are absent', () => {
    const options = built({}, { host: 'h' })

    expect(options.username).toBeNull()
    expect(options.password).toBeNull()
  })

  it('sends the sentinel credentials when given', () => {
    const options = built({ sentinelUsername: 'u', sentinelPassword: 'p' }, { host: 'h' })

    expect(options.username).toBe('u')
    expect(options.password).toBe('p')
  })

  it('defaults the port to 26379 and keeps one that is given', () => {
    expect(built({}, { host: 'h' }).port).toBe(26379)
    RedisMock.mockClear()
    expect(built({}, { host: 'h', port: 5000 }).port).toBe(5000)
  })

  it.each([
    ['the endpoint family when given, with a path', { path: '/s', family: 6 }, 4, 4],
    ['the endpoint family when given, with no path', { family: 6 }, 4, 4],
    [
      'no family when the client connects over a path',
      { path: '/s', family: 6 },
      undefined,
      undefined,
    ],
    ['the client family when the path is empty', { path: '', family: 6 }, undefined, 6],
    ['the client family when there is no path', { family: 6 }, undefined, 6],
  ])('uses %s', (_name, clientOptions, endpointFamily, expected) => {
    const options = built(clientOptions, { host: 'h', family: endpointFamily })

    expect(options.family).toBe(expected)
  })

  it('copies the host, the tls options and the timeouts the way ioredis does', () => {
    const sentinelTLS = { servername: 's' }
    const options = built(
      { sentinelTLS, protocol: 3, connectTimeout: 7, sentinelCommandTimeout: 9, tls: { ca: 'x' } },
      { host: 'sentinel.local' },
    )

    expect(options.host).toBe('sentinel.local')
    expect(options.tls).toBe(sentinelTLS)
    expect(options.protocol).toBe(3)
    expect(options.connectTimeout).toBe(7)
    expect(options.commandTimeout).toBe(9)
    expect(options.retryStrategy).toBeNull()
    expect(options.enableReadyCheck).toBe(false)
    expect(options.replyMapping).toBe('legacy')
  })

  it('lets the options of the caller win over the defaults, but not over the connector', () => {
    const options = built({}, { host: 'h' }, { lazyConnect: true, port: 1, Connector: Object })

    expect(options.lazyConnect).toBe(true)
    expect(options.port).toBe(1)
    expect(options.Connector).toBe(GuardedConnector)
  })
})
