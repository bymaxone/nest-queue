/**
 * @fileoverview Unit tests for the fallback `error` listener. It must survive any value an emitter
 * can pass, because a throw inside a listener escapes `emit` and can end the process.
 * @layer server/utils
 */

import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import type { Logger } from '@nestjs/common'
import { attachDefaultErrorListener } from './attach-error-listener'

/** A logger double that records the `error` lines. */
function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  const logger = {
    error: (line: string): void => {
      lines.push(line)
    },
  } as unknown as Logger
  return { logger, lines }
}

describe('attachDefaultErrorListener', () => {
  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['a plain { message }', { message: 'plain' }, 'plain'],
    ['an Error from another realm', runInNewContext('new Error("foreign")') as unknown, 'foreign'],
    ['a string', 'just a string', 'just a string'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['a null-prototype object', Object.create(null) as object, 'unknown error'],
    [
      'an object whose toString throws',
      {
        toString(): string {
          throw new Error('toString failed')
        },
      },
      'unknown error',
    ],
  ])('logs %s without throwing out of emit', (_label, value, expected) => {
    // A listener that throws makes `emit('error')` throw to the emitter's caller.
    const emitter = new EventEmitter()
    const { logger, lines } = makeLogger()
    attachDefaultErrorListener(emitter, logger, 'Worker', 'email')

    expect(() => emitter.emit('error', value)).not.toThrow()
    expect(lines).toEqual([`Worker for queue "email" emitted an error: ${expected}`])
  })
})
