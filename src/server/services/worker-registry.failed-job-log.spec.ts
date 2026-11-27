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
      .mockReturnValue({ status: 'ready', disconnect: jest.fn(), quit: jest.fn() }),
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
