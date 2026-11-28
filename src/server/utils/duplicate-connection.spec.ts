/**
 * @fileoverview Unit tests for the blocking-role connection duplicate.
 * @layer server/utils
 */

import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { duplicateConnection, retireDuplicates } from './duplicate-connection'

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

// BullMQ builds a worker's blocking connection by duplicating the connection it is handed.
describe('what a library duplicate duplicates in turn', () => {
  const source = (): Redis => {
    const client = new Redis({ lazyConnect: true, port: 1, host: '127.0.0.1' })
    client.on('error', () => undefined)
    return client
  }

  it('has an error listener that logs under the same role, and keeps the override', () => {
    const logger = new Logger('test')
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    const duplicate = duplicateConnection(source(), logger, 'worker: q')

    const made = duplicate.duplicate({ connectionName: 'blocking' })
    made.emit('error', new Error('gone'))

    expect(made.options.connectionName).toBe('blocking')
    expect(made.listenerCount('error')).toBe(1)
    expect(JSON.stringify(logged.mock.calls)).toContain('(worker: q)')
  })

  it('is ended by the retirement, every one of them, and connect no longer opens it', async () => {
    const duplicate = duplicateConnection(source(), new Logger('test'), 'worker: q')
    const made = [duplicate.duplicate(), duplicate.duplicate()]
    const disconnects = made.map((client) => jest.spyOn(client, 'disconnect'))

    retireDuplicates(duplicate)
    await Promise.all(made.map((client) => client.connect()))

    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledTimes(1)
    for (const client of made) expect(['wait', 'end']).toContain(client.status)
    for (const client of made) expect(client.listenerCount('error')).toBe(1)
  })

  it('leaves the duplicate itself to its owner', () => {
    const duplicate = duplicateConnection(source(), new Logger('test'), 'worker: q')
    const disconnect = jest.spyOn(duplicate, 'disconnect')

    retireDuplicates(duplicate)

    expect(disconnect).not.toHaveBeenCalled()
  })

  // The source can be the host's own client, and a later registration duplicates it again.
  it('leaves the source client and a later duplicate able to connect', () => {
    const host = source()
    const released = duplicateConnection(host, new Logger('test'), 'worker: q')
    const blocking = released.duplicate()

    retireDuplicates(released)
    const next = duplicateConnection(host, new Logger('test'), 'worker: q').duplicate()

    expect(blocking.connect).not.toBe(Redis.prototype.connect)
    expect(host.connect).toBe(Redis.prototype.connect)
    expect(host.duplicate).toBe(Redis.prototype.duplicate)
    expect(next.connect).toBe(Redis.prototype.connect)
  })

  it('is nothing for a client the library did not duplicate', () => {
    expect(() => {
      retireDuplicates(source())
    }).not.toThrow()
  })
})
