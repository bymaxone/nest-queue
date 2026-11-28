/**
 * @fileoverview What is passed on when Redis refuses a command: the rejection of each call, what an
 * observer is shown and what the listeners log. Only the reply code may remain. BullMQ is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { Logger } from '@nestjs/common'
import { ReplyError } from 'ioredis'
import type { Redis } from 'ioredis'
import type { FlowJob } from 'bullmq'
import { FlowService } from './flow.service'
import { QueueService } from './queue.service'
import { WorkerRegistry } from './worker-registry.service'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { QueueObserverRegistry } from '../observability/queue-observer'
import { attachClientErrorListener } from '../utils/attach-client-error-listener'
import { attachDefaultErrorListener } from '../utils/attach-error-listener'
import { loggedEvents } from '../utils/log-lines'
import { REDIS_FAILURE_MESSAGE } from '../utils/redact-redis-error'

const SECRET = 'dummy-secret-6f1c'

const Reply = ReplyError as new (message: string) => Error

/** A reply with an argument in its text and the command on it, as ioredis hands it over. */
function refusal(): Error {
  const message = `NOPERM this user has no permissions, with args beginning with: '${SECRET}'`
  return Object.assign(new Reply(message), { command: { name: 'evalsha', args: [SECRET] } })
}

jest.mock('bullmq', () => {
  const { EventEmitter: Emitter } = jest.requireActual<{ EventEmitter: typeof EventEmitter }>(
    'node:events',
  )
  const refused = (): Promise<never> => Promise.reject(mockState.refusal())
  const instance = (methods: string[]): object =>
    Object.assign(
      new Emitter(),
      Object.fromEntries(methods.map((method) => [method, refused])),
      method('close'),
    )
  const method = (name: string): object => ({ [name]: () => Promise.resolve() })
  return {
    QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
    defaultRepeatStrategy: () => undefined,
    Queue: jest
      .fn()
      .mockImplementation(() =>
        instance(['add', 'upsertJobScheduler', 'getJobCounts', 'getJob', 'addBulk']),
      ),
    Job: { fromId: refused },
    FlowProducer: jest.fn().mockImplementation(() => instance(['add'])),
    Worker: jest
      .fn()
      .mockImplementation(() =>
        Object.assign(new Emitter(), { close: () => Promise.reject(mockState.refusal()) }),
      ),
  }
})

/** Read by the mock, which is hoisted above every other declaration of this file. */
const mockState = { refusal }

const options: ResolvedQueueOptions = {
  connection: { url: 'redis://localhost:6379' },
  defaultJobOptions: {},
  prefix: 'bull',
  queueOptions: {},
  flows: { enabled: true },
  metrics: { enabled: false, cacheTtlMs: 5000, collectTimeoutMs: 1000 },
  shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
  connectionReadyTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  enqueueTimeoutMs: 10000,
}

/** The producer connection the services read. */
function connection(): ConnectionResolver {
  const duplicate = Object.assign(new EventEmitter(), {
    status: 'ready',
    options: {},
    quit: () => Promise.resolve('OK'),
    disconnect: () => undefined,
  }) as unknown as Redis
  return {
    getClient: () => ({ options: { commandTimeout: 5000 }, duplicate: () => duplicate }),
    awaitReady: () => Promise.resolve(),
  } as unknown as ConnectionResolver
}

/** The observers of a module, with one that records what it is rejected with. */
function recording(): { observers: QueueObserverRegistry; seen: unknown[] } {
  const observers = new QueueObserverRegistry()
  const seen: unknown[] = []
  observers.register({
    traceEnqueue: (_info, _carrier, run) =>
      run().catch((error: unknown) => {
        seen.push(error)
        throw error
      }),
  })
  return { observers, seen }
}

/** Everything a logger or a serialiser can reach of a value. */
function visible(value: unknown): string {
  const error = value as Error
  return JSON.stringify([error, error.message, error.name, error.stack, error.cause])
}

/** Hold a rejection to the replacement: its code, the fixed message, nothing else. */
async function expectReplaced(work: Promise<unknown>): Promise<void> {
  const rejected = await work.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(rejected).toMatchObject({
    name: 'RedisCommandError',
    message: REDIS_FAILURE_MESSAGE,
    code: 'NOPERM',
  })
  expect(visible(rejected)).not.toContain(SECRET)
}

const tree: FlowJob = { name: 'parent', queueName: 'orders' }

describe('a call Redis refuses', () => {
  it.each<[string, (service: QueueService) => Promise<unknown>]>([
    ['enqueue', (service) => service.enqueue('email', 'send', { token: SECRET })],
    [
      'upsertJobScheduler',
      (service) => service.upsertJobScheduler('email', 'nightly', { every: 1000 }),
    ],
    ['getJob', (service) => service.getJob('email', '1')],
    ['getMetrics', (service) => service.getMetrics('email')],
  ])('%s rejects with the reply code alone', async (_label, call) => {
    await expectReplaced(call(new QueueService(connection(), options)))
  })

  it('enqueueBulk keeps the reply code alone in its cause', async () => {
    const service = new QueueService(connection(), options)

    const rejected = (await service
      .enqueueBulk('email', [{ name: 'send', data: { token: SECRET } }])
      .catch((error: unknown) => error)) as Error

    expect(rejected.cause).toMatchObject({ name: 'RedisCommandError', code: 'NOPERM' })
    expect(visible(rejected)).not.toContain(SECRET)
    expect(visible(rejected.cause)).not.toContain(SECRET)
  })

  it('FlowService.add rejects with the reply code alone', async () => {
    await expectReplaced(new FlowService(connection(), true, 'bull').add(tree))
  })

  it.each<[string, (observers: QueueObserverRegistry) => Promise<unknown>]>([
    [
      'enqueue',
      (observers) =>
        new QueueService(connection(), options, observers).enqueue('email', 'send', {}),
    ],
    [
      'FlowService.add',
      (observers) =>
        new FlowService(connection(), true, 'bull', undefined, 3000, observers).add(tree),
    ],
  ])('shows an observer of %s the reply code alone, and does not blame it', async (_l, call) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { observers, seen } = recording()

    await expectReplaced(call(observers))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'RedisCommandError', code: 'NOPERM' })
    expect(visible(seen[0])).not.toContain(SECRET)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('unregister rejects with the reply code alone', async () => {
    const registry = new WorkerRegistry(connection(), options)
    registry.register({ queueName: 'email', handler: () => Promise.resolve() })

    await expectReplaced(registry.unregister('email'))
  })
})

describe('an error event Redis caused', () => {
  /** The line one listener logs for `refusal()`. */
  function logged(attach: (emitter: EventEmitter, logger: Logger) => void): unknown {
    const logger = new Logger('redis-reply-handling.spec')
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    const emitter = new EventEmitter()
    attach(emitter, logger)
    emitter.emit('error', refusal())
    return loggedEvents(spy)[0]?.err
  }

  it.each<[string, (emitter: EventEmitter, logger: Logger) => void]>([
    [
      'a client the library opened',
      (emitter, logger) => {
        attachClientErrorListener(emitter, logger, 'owned')
      },
    ],
    [
      'a queue on a client of the host',
      (emitter, logger) => {
        attachDefaultErrorListener(emitter, logger, 'Queue', 'email')
      },
    ],
    [
      'a worker whose finishing move was refused',
      (emitter, logger) => {
        attachDefaultErrorListener(emitter, logger, 'Worker', 'email')
      },
    ],
  ])('is logged by its code alone for %s', (_label, attach) => {
    const err = logged(attach)

    expect(err).toMatchObject({ name: 'RedisCommandError', code: 'NOPERM' })
    expect(visible(err)).not.toContain(SECRET)
  })
})
