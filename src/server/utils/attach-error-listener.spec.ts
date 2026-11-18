/**
 * @fileoverview Unit tests for the fallback `error` listener. It must survive any value an emitter
 * can pass, because a throw inside a listener escapes `emit` and can end the process, and it hands the
 * value to the logger as the error itself, never as text in the message.
 * @layer server/utils
 */

import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { Logger } from '@nestjs/common'
import { attachDefaultErrorListener } from './attach-error-listener'
import { loggedEvents } from './log-lines'

/** A real Nest logger whose `error` is spied on, so no cast is needed to satisfy `Logger`. */
function makeLogger(): { logger: Logger; lines: () => ReturnType<typeof loggedEvents> } {
  const logger = new Logger('attach-error-listener.spec')
  const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
  return { logger, lines: () => loggedEvents(spy) }
}

const SENTINEL = 'SENTINEL-error-text-do-not-interpolate'

describe('attachDefaultErrorListener', () => {
  it.each([
    ['an Error', new Error('boom')],
    ['a plain { message }', { message: 'plain' }],
    ['an Error from another realm', runInNewContext('new Error("foreign")') as unknown],
    ['a string', 'just a string'],
    ['undefined', undefined],
    ['null', null],
    ['a null-prototype object', Object.create(null) as object],
    [
      'an object whose toString throws',
      {
        toString(): string {
          throw new Error('toString failed')
        },
      },
    ],
  ])('carries %s as the error, without throwing out of emit', (_label, value) => {
    // A listener that throws makes `emit('error')` throw to the emitter's caller.
    const emitter = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachDefaultErrorListener(emitter, logger, 'Worker', 'email')

    expect(() => emitter.emit('error', value)).not.toThrow()

    const [logged] = lines()
    expect(lines()).toHaveLength(1)
    expect(logged).toMatchObject({
      event: 'QUEUE_EMITTER_ERROR',
      message: 'Worker for queue "email" emitted an error',
      kind: 'Worker',
      queue: 'email',
    })
    expect(logged?.err).toBe(value)
  })

  it('never puts the text of the error in the message', () => {
    const emitter = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachDefaultErrorListener(emitter, logger, 'Queue', 'email')

    emitter.emit('error', new Error(SENTINEL))

    expect(lines()[0]?.message).not.toContain(SENTINEL)
    expect(lines()[0]?.err).toEqual(new Error(SENTINEL))
  })
})
