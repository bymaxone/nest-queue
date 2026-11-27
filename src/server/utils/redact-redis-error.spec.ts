/**
 * @fileoverview Unit tests for what the library passes on of an error Redis answered a command with.
 * Each value is shaped as ioredis shapes it; nothing but the reply code may remain of it.
 * @layer server/utils
 */

import { ReplyError } from 'ioredis'
import { REDIS_FAILURE_MESSAGE, redactRedisError, redisFailure } from './redact-redis-error'

const SECRET = 'dummy-secret-6f1c'

const Reply = ReplyError as new (message: string) => Error

/** A reply with the command ioredis hangs on it. */
function reply(message: string): Error {
  return Object.assign(new Reply(message), { command: { name: 'auth', args: [SECRET] } })
}

/** Everything a logger or a serialiser can reach of a value. */
function visible(value: unknown): string {
  const error = value as Error
  return JSON.stringify([error, error.message, error.name, error.stack, error.cause])
}

/** A `cause` chain of `length` errors that ends at `end`. */
function chain(length: number, end: Error = new Error('end')): Error {
  let head = end
  for (let index = 1; index < length; index += 1) head = new Error('link', { cause: head })
  return head
}

describe('redactRedisError', () => {
  it.each([
    ['WRONGPASS invalid username-password pair', 'WRONGPASS'],
    [`ERR unknown command 'AUTH', with args beginning with: '${SECRET}' `, 'ERR'],
    [`NOPERM ${SECRET}`, 'NOPERM'],
    ['OOM', 'OOM'],
    ['NOSCRIPT_2 no matching script', 'NOSCRIPT_2'],
  ])('keeps only the code of %s', (message, code) => {
    const kept = redactRedisError(reply(message)) as Error & { code?: string }

    expect(kept.name).toBe('RedisCommandError')
    expect(kept.message).toBe(REDIS_FAILURE_MESSAGE)
    expect(kept.code).toBe(code)
    expect(Object.keys(kept).sort()).toEqual(['code', 'name'])
    expect(visible(kept)).not.toContain(SECRET)
  })

  it.each([
    ['text that starts in lower case', `wrong ${SECRET}`],
    ['a word that only starts upper case', `Command ${SECRET}`],
    ['a code run into other text', `ERR:${SECRET}`],
    ['a word longer than a code', `${'A'.repeat(33)} ${SECRET}`],
    ['an empty message', ''],
  ])('gives no code to %s', (_label, message) => {
    const kept = redactRedisError(reply(message)) as Error

    expect(Object.keys(kept)).toEqual(['name'])
    expect(visible(kept)).not.toContain(SECRET)
  })

  it('takes the code the error already has before the first word of its message', () => {
    const coded = Object.assign(reply('ERR syntax'), { code: 'EXECABORT' })

    expect(redactRedisError(coded)).toMatchObject({ code: 'EXECABORT' })
  })

  it('reads no code from a `code` of another shape, and falls back to the message', () => {
    const coded = Object.assign(reply('ERR syntax'), { code: SECRET })

    expect(redactRedisError(coded)).toMatchObject({ code: 'ERR' })
  })

  it.each<[string, unknown]>([
    ['a reply with no command', new Reply(`ERR ${SECRET}`)],
    [
      'a command aborted with the connection',
      Object.assign(new Error('Command aborted due to connection close'), {
        command: { name: 'set', args: [SECRET] },
      }),
    ],
    [
      'an aborted transaction',
      Object.assign(new Error(`EXECABORT ${SECRET}`), { previousErrors: [] }),
    ],
    ['a reply in a cause', new Error(SECRET, { cause: reply('ERR x') })],
    ['a reply two causes down', chain(3, reply(`ERR ${SECRET}`))],
    ['a reply in an aggregate', new AggregateError([new Error('a'), reply(`ERR ${SECRET}`)])],
    ['a chain too long to read', chain(17)],
  ])('replaces %s', (_label, value) => {
    const kept = redactRedisError(value) as Error

    expect(kept).not.toBe(value)
    expect(kept.message).toBe(REDIS_FAILURE_MESSAGE)
    expect(visible(kept)).not.toContain(SECRET)
  })

  it('replaces an error that is its own cause', () => {
    const loop = new Error('loop')
    loop.cause = loop

    expect(redactRedisError(loop)).toMatchObject({ name: 'RedisCommandError' })
  })

  it('replaces a value whose members cannot be read', () => {
    const value = {
      get cause(): never {
        throw new Error(SECRET)
      },
      get message(): never {
        throw new Error(SECRET)
      },
    }

    const kept = redactRedisError(value) as Error

    expect(Object.keys(kept)).toEqual(['name'])
    expect(visible(kept)).not.toContain(SECRET)
  })

  it.each<[string, unknown]>([
    ['a refused connection', Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })],
    ['a timeout of the driver', new Error('Command timed out')],
    ['a chain of sixteen', chain(16)],
    ['an error with a command of another shape', Object.assign(new Error('x'), { command: 'ls' })],
    ['an error with a null command', Object.assign(new Error('x'), { command: null })],
    ['an aggregate with no reply', new AggregateError([new Error('a')])],
    ['an object whose errors is not a list', { errors: 'none' }],
    ['a string', 'text'],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    [
      'an object whose name cannot be read',
      {
        get name(): never {
          throw new Error('name failed')
        },
      },
    ],
  ])('returns %s as it is', (_label, value) => {
    expect(redactRedisError(value)).toBe(value)
  })

  it('gives one replacement for one error, however often it is reported', () => {
    const refused = reply('ERR x')

    expect(redactRedisError(refused)).toBe(redactRedisError(refused))
    expect(redisFailure(refused)).toBe(redactRedisError(refused))
    expect(redactRedisError(reply('ERR x'))).not.toBe(redactRedisError(refused))
  })

  it.each<[unknown]>([[null], ['text'], [undefined]])(
    'stands for %p with a replacement of its own',
    (value) => {
      const first = redisFailure(value)

      expect(first.message).toBe(REDIS_FAILURE_MESSAGE)
      expect(redisFailure(value)).not.toBe(first)
    },
  )
})
