/**
 * @fileoverview Unit tests for the line the registry writes when BullMQ reports a failed attempt:
 * one `QUEUE_JOB_FAILED` warning that names the queue, the job, the attempt and the class of the
 * error, and carries neither the payload nor the error. BullMQ `Worker` is mocked, so the `failed`
 * event is emitted here with what BullMQ passes to it.
 * @layer server/services
 */

import type { EventEmitter } from 'node:events'
import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { WorkerRegistry } from './worker-registry.service'
import { loggedEvents, loggedText } from '../utils/log-lines'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

jest.mock('bullmq', () => {
  const events = jest.requireActual<{ EventEmitter: new () => object }>('node:events')
  return { Worker: jest.fn(() => new events.EventEmitter()) }
})

/** A value that must never be logged: it stands for what a payload or an error text can hold. */
const SECRET = 'SECRET-do-not-log'

/** A minimal fake Redis whose `duplicate()` yields a stub the registry can disconnect. */
function fakeConnection(): ConnectionResolver {
  const redis = {
    duplicate: jest
      .fn()
      .mockReturnValue({ status: 'ready', on: jest.fn(), disconnect: jest.fn(), quit: jest.fn() }),
  } as unknown as Redis
  return { getClient: jest.fn().mockReturnValue(redis) } as unknown as ConnectionResolver
}

/** The workers of a registry, one per registration path, with the lines written at `warn`. */
function setup(): {
  workers: { email: EventEmitter; video: EventEmitter }
  warn: jest.SpyInstance
} {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  const registry = new WorkerRegistry(fakeConnection(), {
    prefix: 'bull',
  } as unknown as ResolvedQueueOptions)
  const inProcess = registry.register({ queueName: 'email', handler: () => Promise.resolve() })
  const sandboxed = registry.registerSandboxed({ queueName: 'video', processorFile: '/tmp/p.js' })
  return { workers: { email: inProcess, video: sandboxed }, warn }
}

/** The `QUEUE_JOB_FAILED` events written. */
function failures(warn: jest.SpyInstance): unknown[] {
  return loggedEvents(warn).filter((event) => event.event === 'QUEUE_JOB_FAILED')
}

/** A job as BullMQ hands it to `failed`, with a secret in its payload. */
function job(attemptsMade: number): object {
  return { id: '42', name: 'send', attemptsMade, data: { token: SECRET }, opts: {} }
}

class SmtpRefused extends Error {}

describe('WorkerRegistry — the log of a failed job', () => {
  it.each(['email', 'video'] as const)(
    'writes one warning for each failed attempt of the %s worker',
    (queue) => {
      const { workers, warn } = setup()

      workers[queue].emit('failed', job(1), new SmtpRefused(SECRET), 'active')
      workers[queue].emit('failed', job(2), new SmtpRefused(SECRET), 'active')

      expect(failures(warn)).toStrictEqual(
        [1, 2].map((attempt) => ({
          event: 'QUEUE_JOB_FAILED',
          message: 'A job attempt failed',
          queue,
          jobName: 'send',
          jobId: '42',
          attempt,
          errorClass: 'SmtpRefused',
        })),
      )
      expect(loggedText(warn)).not.toContain(SECRET)
    },
  )

  it.each([
    ['a string', SECRET, 'String'],
    ['a plain object that names a constructor', { constructor: { name: SECRET } }, 'Object'],
    [
      'an error whose name is overwritten',
      Object.assign(new Error('x'), { name: SECRET }),
      'Error',
    ],
    ['an object with no prototype', Object.create(null) as object, 'unknown'],
    ['nothing', undefined, 'unknown'],
    ['a class with no name', new (class extends Error {})(), 'unknown'],
  ])('names the class of %s without reading what it carries', (_label, thrown, errorClass) => {
    const { workers, warn } = setup()

    workers.email.emit('failed', job(1), thrown, 'active')

    expect(failures(warn)).toEqual([expect.objectContaining({ errorClass })])
    expect(loggedText(warn)).not.toContain(SECRET)
  })

  /** The name and id written for a job whose name and id are both `value`. */
  function written(value: string): unknown[] {
    const { workers, warn } = setup()

    workers.email.emit('failed', { id: value, name: value }, new SmtpRefused(), 'active')

    return failures(warn).map((event) => {
      const { jobName, jobId } = event as { jobName: unknown; jobId: unknown }
      return [jobName, jobId]
    })
  }

  it.each([
    ['128 characters as they are', 'a'.repeat(128), 'a'.repeat(128)],
    ['129 characters cut to 128 and an ellipsis', 'a'.repeat(129), `${'a'.repeat(128)}…`],
    ['line breaks taken out', 'a\rb\nc d e\r\nf', 'abcdef'],
    ['a long value with line breaks', `\n${'a'.repeat(200)}`, `${'a'.repeat(127)}…`],
    ['no half of a character at the cut', `${'a'.repeat(127)}😀tail`, `${'a'.repeat(127)}…`],
    ['a whole character that ends at the cut', `${'a'.repeat(126)}😀tail`, `${'a'.repeat(126)}😀…`],
    ['a short value with its last character whole', 'done 😀', 'done 😀'],
  ])('writes a job name and id with %s', (_label, value, expected) => {
    expect(written(value)).toStrictEqual([[expected, expected]])
  })

  it.each([
    ['a carriage return', '\r'],
    ['a line feed', '\n'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
    ['a tab', '\t'],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
    ['a next line', '\u0085'],
    ['an escape', '\u001b'],
    ['a null', '\u0000'],
    ['a delete', '\u007f'],
    ['the last C1 control', '\u009f'],
  ])('writes a job name and id without %s', (_label, control) => {
    expect(written(`a${control}b${control}`)).toStrictEqual([['ab', 'ab']])
  })

  it('keeps the characters that border the control ranges', () => {
    const value = ' ~\u00a0\u2027\u202a'

    expect(written(value)).toStrictEqual([[value, value]])
  })

  it('writes the class of an error a sandboxed processor failed with, and no member of it', () => {
    // The error is built as the parent side of BullMQ's sandbox builds it. This pins what the library
    // does with that value, not what BullMQ sends from the child process.
    const { workers, warn } = setup()
    const rebuilt = Object.assign(new Error(), {
      name: SECRET,
      message: SECRET,
      stack: SECRET,
      command: { name: 'set', args: [SECRET] },
    })

    workers.video.emit('failed', job(1), rebuilt, 'active')

    expect(failures(warn)).toStrictEqual([
      {
        event: 'QUEUE_JOB_FAILED',
        message: 'A job attempt failed',
        queue: 'video',
        jobName: 'send',
        jobId: '42',
        attempt: 1,
        errorClass: 'Error',
      },
    ])
    expect(loggedText(warn)).not.toContain(SECRET)
  })

  it('writes the queue and the class when BullMQ has no job to give', () => {
    const { workers, warn } = setup()

    workers.email.emit('failed', undefined, new SmtpRefused(), 'active')

    expect(failures(warn)).toStrictEqual([
      {
        event: 'QUEUE_JOB_FAILED',
        message: 'A job attempt failed',
        queue: 'email',
        errorClass: 'SmtpRefused',
      },
    ])
  })
})
