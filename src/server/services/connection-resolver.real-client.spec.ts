/**
 * @fileoverview Mode A null-retries probe against real ioredis clients and a real BullMQ worker.
 * @layer server/services
 */

import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'

// `connection-resolver.service.spec.ts` drives the probe with scripted fakes, so it can only show
// that the resolver reacts to the answer it was handed. These cases use real clients: the probe
// either sees what ioredis actually produces or it does not, and BullMQ's own check is the
// authority on what a worker connection must look like.

/** Options for a client that is "connecting" and never reaches a server, so no test needs Redis. */
const unreachable: RedisOptions = {
  host: '127.0.0.1',
  port: 1,
  maxRetriesPerRequest: 3,
  retryStrategy: () => null,
}

/** A real client that keeps the duplicates it hands out, honouring the override like ioredis does. */
class RecordingRedis extends Redis {
  readonly duplicates: Redis[] = []

  override duplicate(override?: Partial<RedisOptions>): Redis {
    const copy = super.duplicate(override)
    this.duplicates.push(copy)
    return copy
  }
}

/** A real client whose `duplicate()` drops the override, as a wrapper that ignores it would. */
class OverrideIgnoringRedis extends RecordingRedis {
  override duplicate(): Redis {
    return super.duplicate()
  }
}

const open: Redis[] = []

/** Build a client of the given class and make sure the test closes it. */
function client<T extends Redis>(Type: new (options: RedisOptions) => T): T {
  const created = new Type(unreachable)
  created.on('error', () => undefined)
  open.push(created)
  return created
}

/** Resolve the Mode A connection for a client and return what init threw, if anything. */
async function initWith(redis: Redis): Promise<unknown> {
  try {
    await new ConnectionResolver({ connection: { client: redis } }).init()
    return undefined
  } catch (err) {
    return err
  }
}

/** Wait for a client that was told to disconnect to reach `end`; its status moves on a later tick. */
async function settle(redis: Redis | undefined): Promise<string | undefined> {
  if (redis === undefined) return undefined
  if (redis.status !== 'end') {
    await Promise.race([
      new Promise((resolve) => redis.once('end', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  }
  return redis.status
}

afterEach(() => {
  for (const redis of open.splice(0)) redis.disconnect()
})

describe('ConnectionResolver Mode A probe, with real ioredis', () => {
  // A stock client created with finite retries is the case the override exists for: the duplicate
  // comes back with `null`, so the probe passes and the consumer needs to do nothing.
  it('accepts a stock client with finite retries and closes the probe it opened', async () => {
    const redis = client(RecordingRedis)

    const failure = await initWith(redis)

    expect(failure).toBeUndefined()
    expect(redis.options.maxRetriesPerRequest).toBe(3)
    expect(redis.duplicates).toHaveLength(1)
    expect(redis.duplicates[0]?.options.maxRetriesPerRequest).toBeNull()
    expect(await settle(redis.duplicates[0])).toBe('end')
  })

  // The case the probe exists for: a client whose `duplicate()` ignores the override would hand
  // BullMQ a worker connection with finite retries, so init must refuse it, and must still close
  // the probe it opened to find out.
  it('refuses a client whose duplicate() ignores the override and closes the probe', async () => {
    const redis = client(OverrideIgnoringRedis)

    const failure = await initWith(redis)

    expect(failure).toBeInstanceOf(QueueException)
    const body = (failure as QueueException).getResponse() as {
      error: { code: string; details: unknown }
    }
    expect(body.error.code).toBe(QUEUE_ERROR_CODES.CONNECTION_REQUIRES_NULL_RETRIES)
    expect(body.error.details).toEqual({ actualValue: 3, expectedValue: null })
    expect(await settle(redis.duplicates[0])).toBe('end')
  })

  // The probe is only worth having if the connection it rejects is one BullMQ would reject too.
  // Without the probe, this is the failure a consumer would meet when the first worker is built.
  it('rejects exactly the connection BullMQ refuses to build a Worker on', async () => {
    const redis = client(OverrideIgnoringRedis)
    await initWith(redis)
    const rejected = redis.duplicates[0]
    if (rejected === undefined) throw new Error('init opened no probe')

    expect(
      () => new Worker('probe', () => Promise.resolve(), { connection: rejected, autorun: false }),
    ).toThrow('maxRetriesPerRequest must be null')
  })
})
