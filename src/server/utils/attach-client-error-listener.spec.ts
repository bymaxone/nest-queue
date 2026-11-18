/**
 * @fileoverview Unit tests for the persistent `error` listener on a Redis client the library
 * constructs. ioredis prints `[ioredis] Unhandled error event` to raw stderr when a client emits
 * `error` with no listener, so the listener must stay for the client's whole life and must survive
 * any value a client can pass. The value goes to the logger as the error itself, never as text in
 * the message: the logger knows how to serialise and redact an error, and the message is not the
 * place for what a connection error holds (an address, part of a URL).
 * @layer server/utils
 */

import { EventEmitter } from 'node:events'
import { Logger } from '@nestjs/common'
import { attachClientErrorListener } from './attach-client-error-listener'
import { loggedEvents } from './log-lines'

/** A real Nest logger whose `error` is spied on. */
function makeLogger(): { logger: Logger; lines: () => ReturnType<typeof loggedEvents> } {
  const logger = new Logger('attach-client-error-listener.spec')
  const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
  return { logger, lines: () => loggedEvents(spy) }
}

/** The event the listener logs for a connection `role`, with the error it was given. */
function clientError(role: string, err: unknown): object {
  return {
    event: 'QUEUE_CLIENT_ERROR',
    message: `Redis connection (${role}) emitted an error`,
    role,
    err,
  }
}

describe('attachClientErrorListener', () => {
  it('logs every error a client emits, naming the connection, and keeps listening', () => {
    // A listener removed after the first event would leave the second outage unhandled.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'worker: email')
    const first = new Error('ECONNREFUSED')
    const second = new Error('ECONNRESET')

    client.emit('error', first)
    client.emit('error', second)

    expect(lines()).toStrictEqual([
      clientError('worker: email', first),
      clientError('worker: email', second),
    ])
    expect(client.listenerCount('error')).toBe(1)
  })

  it('carries an error whose message is empty as it is, so the logger can read its type and code', () => {
    // Node's connect error for a host with two addresses is an AggregateError with message ''.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')
    const refused = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:1')]), {
      code: 'ECONNREFUSED',
    })

    client.emit('error', refused)

    expect(lines()[0]?.err).toBe(refused)
    expect(lines()[0]?.message).toBe('Redis connection (owned) emitted an error')
  })

  it('never puts anything the error holds in the message', () => {
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')
    const nested = new Error('connect ECONNREFUSED redis://user:SENTINEL@host:1')

    client.emit('error', new AggregateError([nested], 'SENTINEL-in-message'))

    expect(lines()[0]?.message).not.toContain('SENTINEL')
  })

  it.each([
    ['an empty message and no name', { message: '' }],
    ['a string', 'just a string'],
    ['undefined', undefined],
    ['a null-prototype object', Object.create(null) as object],
    [
      'a name that throws when read',
      {
        message: '',
        get name(): string {
          throw new Error('name failed')
        },
      },
    ],
  ])('carries %s as the error, without throwing out of emit', (_label, value) => {
    // A throw inside the listener escapes `emit` to the client's caller.
    const client = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachClientErrorListener(client, logger, 'owned')

    expect(() => client.emit('error', value)).not.toThrow()

    expect(lines()).toStrictEqual([clientError('owned', value)])
  })
})
