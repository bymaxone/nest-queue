/**
 * @fileoverview Unit tests for how `QueueService.upsertJobScheduler` tells a cron validation error
 * apart from an operational failure. BullMQ `Queue` is mocked so no Redis is needed, while the cron
 * validation itself runs through BullMQ's real repeat strategy.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import { defaultRepeatStrategy } from 'bullmq'
import { ReplyError } from 'ioredis'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'
import type { ResolvedQueueOptions } from '../config/resolved-options'

interface MockQueue {
  upsertJobScheduler: jest.Mock
  close: jest.Mock
}

const queueInstances: MockQueue[] = []

jest.mock('bullmq', () => ({
  defaultRepeatStrategy: jest.fn(
    jest.requireActual<{ defaultRepeatStrategy: (...args: unknown[]) => unknown }>('bullmq')
      .defaultRepeatStrategy,
  ),
  Queue: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      upsertJobScheduler: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    }) as MockQueue
    queueInstances.push(instance)
    return instance
  }),
}))

/** The ioredis reply error: the error a Redis server answer becomes, which carries no `code`. */
const RedisReplyError = ReplyError as new (message: string) => Error

/** Build the service with the given extra queue options. */
function makeService(queueOptions: ResolvedQueueOptions['queueOptions'] = {}): QueueService {
  const connection = {
    getClient: jest.fn().mockReturnValue({ id: 'client' }),
  } as unknown as ConnectionResolver
  const options: ResolvedQueueOptions = {
    connection: { url: 'redis://localhost:6379' },
    defaultJobOptions: {},
    prefix: 'bull',
    queueOptions,
    flows: { enabled: false },
    metrics: { enabled: false, cacheTtlMs: 5000 },
    shutdown: { drainTimeoutMs: 30000, drainOnShutdown: false },
    connectionReadyTimeoutMs: 10000,
  }
  return new QueueService(connection, options)
}

beforeEach(() => {
  queueInstances.length = 0
})

describe('QueueService.upsertJobScheduler — failure classification', () => {
  it.each([
    [
      'READONLY (a replica refused the write)',
      "READONLY You can't write against a read only replica.",
    ],
    ['OOM (the server is out of memory)', 'OOM command not allowed when used memory > maxmemory.'],
    ['NOAUTH (the connection is not authenticated)', 'NOAUTH Authentication required.'],
  ])('propagates a Redis reply error without a code untouched: %s', async (_label, message) => {
    // A reply error carries no string `code`, so it used to be relabelled "invalid cron" (400)
    // for a perfectly valid pattern, telling the caller not to retry a write Redis refused.
    const service = makeService()
    service.getOrCreateQueue('cleanup')
    const refused = new RedisReplyError(message)
    queueInstances[0]?.upsertJobScheduler.mockRejectedValue(refused)

    await expect(
      service.upsertJobScheduler('cleanup', 'nightly', { pattern: '0 3 * * *' }),
    ).rejects.toBe(refused)
  })

  it.each(['not a cron', '60 * * * *', '*/0 * * * *', '1-0 * * * *', '* * * * * * *', '@bogus'])(
    'rejects the invalid cron pattern %j as INVALID_REPEAT_OPTIONS before Redis is asked',
    async (pattern) => {
      // A cron parse error comes from a pure function with no I/O, so it is the only failure that is
      // the caller's mistake; Redis is never reached for it.
      const service = makeService()
      service.getOrCreateQueue('cleanup')

      const err: unknown = await service
        .upsertJobScheduler('cleanup', 'nightly', { pattern })
        .catch((e: unknown) => e)

      expect(err).toBeInstanceOf(QueueException)
      const body = (err as QueueException).getResponse() as { error: { code: string } }
      expect(body.error.code).toBe(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS)
      expect((err as QueueException).getStatus()).toBe(400)
      expect(queueInstances[0]?.upsertJobScheduler).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'its next run falls after its end date',
      () => ({ pattern: '0 0 1 1 *', endDate: Date.now() + 3_600_000 }),
    ],
    [
      'its iteration limit is already reached',
      () => ({ pattern: '0 3 * * *', limit: 1, count: 1 }),
    ],
    [
      'it starts in the far future',
      () => ({ pattern: '0 3 * * *', startDate: '2090-01-01T00:00:00Z' }),
    ],
  ])('hands a valid pattern to BullMQ even when %s', async (_label, build) => {
    // A finished or not-yet-started schedule is valid: BullMQ's own upsert accepts it (it simply
    // adds no job), so the pre-check must not turn it into INVALID_REPEAT_OPTIONS. (A past
    // `endDate` is refused earlier, by the library's own validation, and is not in this class.)
    const service = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)

    await expect(service.upsertJobScheduler('cleanup', 'nightly', build())).resolves.toBeUndefined()

    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a date that never exists', { pattern: '0 0 30 2 *' }],
    ['a time zone that does not exist', { pattern: '0 3 * * *', tz: 'Not/AZone' }],
    [
      'a malformed pattern on a schedule whose limit is reached',
      { pattern: 'not a cron', limit: 1, count: 1 },
    ],
  ])('rejects %s as INVALID_REPEAT_OPTIONS', async (_label, repeat) => {
    // The parser refuses the first two on its own, and BullMQ's upsert would raise the same throw.
    // The last is refused here even though BullMQ returns before parsing a schedule whose limit is
    // reached, because a malformed pattern is the caller's mistake whatever the limit says.
    const service = makeService()
    service.getOrCreateQueue('cleanup')

    const err: unknown = await service
      .upsertJobScheduler('cleanup', 'nightly', repeat)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(QueueException)
    const body = (err as QueueException).getResponse() as { error: { code: string } }
    expect(body.error.code).toBe(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS)
    expect(queueInstances[0]?.upsertJobScheduler).not.toHaveBeenCalled()
  })

  it('does not validate a pattern itself when the consumer configured a custom repeat strategy', async () => {
    // With `settings.repeatStrategy` BullMQ does not use the cron parser at all, so a pattern that
    // the parser would refuse is the consumer's to define.
    const service = makeService({ settings: { repeatStrategy: () => undefined } })
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)

    await service.upsertJobScheduler('cleanup', 'nightly', { pattern: 'every full moon' })

    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledTimes(1)
  })

  it('checks a cron pattern once and never checks an interval schedule', async () => {
    // An interval schedule has no pattern for the parser to read; running the strategy on it would
    // validate something that is not there.
    const service = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)
    const strategy = defaultRepeatStrategy as unknown as jest.Mock
    strategy.mockClear()

    await service.upsertJobScheduler('cleanup', 'heartbeat', { every: 60_000 })
    expect(strategy).not.toHaveBeenCalled()

    await service.upsertJobScheduler('cleanup', 'nightly', { pattern: '0 3 * * *' })
    expect(strategy).toHaveBeenCalledTimes(1)
  })

  it('still sends a valid pattern with its options to BullMQ', async () => {
    // Validation must not change what a valid schedule sends.
    const service = makeService()
    service.getOrCreateQueue('cleanup')
    queueInstances[0]?.upsertJobScheduler.mockResolvedValue(undefined)

    await service.upsertJobScheduler('cleanup', 'nightly', {
      pattern: '0 3 * * *',
      tz: 'America/Sao_Paulo',
    })

    expect(queueInstances[0]?.upsertJobScheduler).toHaveBeenCalledWith(
      'nightly',
      { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
      { name: 'nightly', data: {} },
    )
  })
})
