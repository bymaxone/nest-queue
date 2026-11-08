/**
 * @fileoverview Unit tests for the persistent `error` listener on a Redis client the library
 * constructs. ioredis prints `[ioredis] Unhandled error event` to raw stderr when a client emits
 * `error` with no listener, so the listener must stay for the client's whole life and must survive
 * any value a client can pass.
 * @layer server/utils
 */

import { EventEmitter } from 'node:events'
import { Logger } from '@nestjs/common'
import { attachClientErrorListener } from './attach-client-error-listener'

/** A real Nest logger whose `error` is spied on. */
function makeLogger(): { logger: Logger; lines: () => unknown[] } {
  const logger = new Logger('attach-client-error-listener.spec')
  const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
  return { logger, lines: () => spy.mock.calls.map((call: unknown[]): unknown => call[0]) }
}

describe('attachClientErrorListener', () => {
  it('logs every error a client emits, naming the connection, and keeps listening', () => {
    // A listener removed after the first event would leave the second outage unhandled.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'worker: email')

    client.emit('error', new Error('ECONNREFUSED'))
    client.emit('error', new Error('ECONNRESET'))

    expect(lines()).toEqual([
      'Redis connection (worker: email) emitted an error: ECONNREFUSED',
      'Redis connection (worker: email) emitted an error: ECONNRESET',
    ])
    expect(client.listenerCount('error')).toBe(1)
  })

  it('names an error whose message is empty by its type and code', () => {
    // Node's connect error for a host with two addresses is an AggregateError with message '';
    // a line that ended after "emitted an error:" would hide what failed.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')
    const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:1')]), {
      code: 'ECONNREFUSED',
    })

    client.emit('error', refused)

    expect(lines()).toEqual([
      'Redis connection (owned) emitted an error: AggregateError [ECONNREFUSED]',
    ])
  })

  it('does not reach into the error for anything but its message, name and code', () => {
    // The nested errors of an AggregateError carry addresses; only the three fields are used.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')
    const nested = new Error('connect ECONNREFUSED redis://user:SENTINEL@host:1')

    client.emit('error', new AggregateError([nested]))

    expect(JSON.stringify(lines())).not.toContain('SENTINEL')
  })

  it.each([
    ['an empty message and no name', { message: '' }, 'unknown error'],
    ['an empty message and an empty name', { message: '', name: '' }, 'unknown error'],
    ['an empty message and no code', new AggregateError([]), 'AggregateError'],
    ['an empty message and a numeric code', { message: '', name: 'Fault', code: 7 }, 'Fault'],
    [
      'an empty message and a name that throws when read',
      {
        message: '',
        get name(): string {
          throw new Error('name failed')
        },
      },
      'unknown error',
    ],
  ])('describes an error with %s', (_label, value, expected) => {
    // Every fallback must still produce a line, and none may throw out of emit.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')

    expect(() => client.emit('error', value)).not.toThrow()
    expect(lines()).toEqual([`Redis connection (owned) emitted an error: ${expected}`])
  })

  it.each([
    ['a string', 'just a string', 'just a string'],
    ['undefined', undefined, 'undefined'],
    ['a null-prototype object', Object.create(null) as object, 'unknown error'],
  ])('logs %s without throwing out of emit', (_label, value, expected) => {
    // A throw inside the listener escapes `emit` to the client's caller.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')

    expect(() => client.emit('error', value)).not.toThrow()
    expect(lines()).toEqual([`Redis connection (owned) emitted an error: ${expected}`])
  })
})
