/**
 * @fileoverview Unit tests for what the library passes on of an error Redis answered a command with.
 * Each value is shaped as ioredis shapes it; nothing but the reply code may remain of it.
 * @layer server/utils
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

const SENTINEL = 'All sentinels are unreachable; the text of the last error is not kept'
const QUEUE_STATE = 'Command queue state error; the text of the last reply is not kept'
const NEXT_ITERATION = 'A job scheduler iteration was not added; the text of the cause is not kept'

/** A file of an installed package, found from its manifest. */
function installed(name: string, file: string): string {
  return readFileSync(join(dirname(require.resolve(`${name}/package.json`)), file), 'utf8')
}

describe('redactRedisError, on an error built out of another error’s text', () => {
  it.each<[string, string, string, string | undefined]>([
    [
      'sentinels that retry',
      `All sentinels are unreachable. Retrying from scratch after 10ms. Last error: ERR ${SECRET}`,
      SENTINEL,
      'ERR',
    ],
    [
      'sentinels that gave up',
      `All sentinels are unreachable and retry is disabled. Last error: WRONGPASS ${SECRET}`,
      SENTINEL,
      'WRONGPASS',
    ],
    [
      'sentinels with text of no code',
      `All sentinels are unreachable and retry is disabled. Last error: wrong ${SECRET}`,
      SENTINEL,
      undefined,
    ],
    [
      'an unexpected error reply',
      `Command queue state error. If you can reproduce this, please report it. Last error: ERR ${SECRET}`,
      QUEUE_STATE,
      'ERR',
    ],
    [
      'an unexpected reply that is data',
      `Command queue state error. If you can reproduce this, please report it. Last reply: DUMMYPAYLOAD7`,
      QUEUE_STATE,
      undefined,
    ],
    [
      'an unexpected data reply that quotes the other marker',
      'Command queue state error. If you can reproduce this, please report it. Last reply: x Last error: DUMMYPAYLOAD7',
      QUEUE_STATE,
      undefined,
    ],
    [
      'a job scheduler iteration',
      `Failed to add repeatable job for next iteration: OOM ${SECRET}`,
      NEXT_ITERATION,
      'OOM',
    ],
  ])('replaces the one of %s', (_label, text, message, code) => {
    const kept = redactRedisError(new Error(text)) as Error & { code?: string }

    expect(kept.name).toBe('RedisCommandError')
    expect(kept.message).toBe(message)
    expect(kept.code).toBe(code)
    expect(visible(kept)).not.toContain(SECRET)
    expect(visible(kept)).not.toContain('DUMMYPAYLOAD7')
  })

  it('replaces an error that has one in its cause', () => {
    const inner = new Error(`Failed to add repeatable job for next iteration: ERR ${SECRET}`)
    const kept = redactRedisError(new Error('outer', { cause: inner })) as Error

    expect(kept.message).toBe(REDIS_FAILURE_MESSAGE)
    expect(visible(kept)).not.toContain(SECRET)
  })

  it('replaces a cluster failure that holds a reply as its last node error', () => {
    const failed = Object.assign(new Error('Failed to refresh slots cache.'), {
      lastNodeError: reply(`ERR ${SECRET}`),
    })
    const kept = redactRedisError(failed) as Error

    expect(kept.message).toBe(REDIS_FAILURE_MESSAGE)
    expect(visible(kept)).not.toContain(SECRET)
  })

  it.each<[string, unknown]>([
    [
      'sentinels with no last error',
      new Error('All sentinels are unreachable and retry is disabled.'),
    ],
    ['text that only quotes an opening', new Error('x: Command queue state error Last error: y')],
    [
      'a cluster failure with no reply',
      Object.assign(new Error('Failed'), { lastNodeError: new Error('Command timed out') }),
    ],
    ['a message that is not text', { message: 1 }],
  ])('returns %s as it is', (_label, value) => {
    expect(redactRedisError(value)).toBe(value)
  })

  it.each<[string, string, string]>([
    ['ioredis', 'built/connectors/SentinelConnector/index.js', 'All sentinels are unreachable'],
    ['ioredis', 'built/connectors/SentinelConnector/index.js', ' Last error: ${lastError.message}'],
    ['ioredis', 'built/DataHandler.js', 'Command queue state error'],
    ['ioredis', 'built/DataHandler.js', ' Last error: ${reply.message}'],
    ['ioredis', 'built/DataHandler.js', ' Last reply: ${reply.toString()}'],
    ['bullmq', 'dist/cjs/classes/worker.js', 'Failed to add repeatable job for next iteration: '],
    ['bullmq', 'dist/esm/classes/worker.js', 'Failed to add repeatable job for next iteration: '],
  ])('still finds in the installed %s %s the text it matches: %s', (name, file, text) => {
    expect(installed(name, file)).toContain(text)
  })
})
