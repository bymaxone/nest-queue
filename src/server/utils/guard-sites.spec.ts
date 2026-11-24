/**
 * @fileoverview Unit tests that each place the library runs the prototype guard before it decides is
 * pinned by what it changes for the caller: the quit and the deadline are refused when the prototype
 * is polluted at entry, or polluted between the start of the wait and the await of its verdict and
 * clean again by the time the work answers, so only the guard before the await can see it; the
 * refusal is logged with the site that failed closed; and a bulk add is refused when the prototype
 * was polluted while its trees ran.
 * @layer test
 */

import type { FlowJob, JobNode } from 'bullmq'
import type { Redis } from 'ioredis'
import { assertPrototypeClean, NativePromise } from '../connection/prototype-guard'
import { QueueException } from '../errors/queue-exception'
import { runFlowBulk } from './add-flow-trees'
import { QUEUE_LOG_EVENTS, reportRefusal } from './log-event'
import { loggedEvents } from './log-lines'
import { quitWithin } from './quit-within'
import { withDeadline } from './with-deadline'

const PLANT = 'zzGuardSitePlant'
const realSetTimeout = globalThis.setTimeout

/** Pollute `Object.prototype` with a key that is not a standard name. */
function plant(): void {
  ;(Object.prototype as Record<string, unknown>)[PLANT] = 'planted'
}

/** Put `Object.prototype` back. */
function clean(): void {
  Reflect.deleteProperty(Object.prototype, PLANT)
}

/**
 * Make the next timer the library arms plant the key right after it is armed, which is after the
 * guard inside the wait has run and before the guard the caller runs ahead of its await.
 */
function plantWhenTimerIsArmed(): void {
  let planted = false
  jest
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args)
      if (!planted) {
        planted = true
        plant()
      }
      return timer
    })
}

/** Work that answers `value` on a later tick, with the prototype clean again by then. */
function answersCleanLater<T>(value: T): Promise<T> {
  return new NativePromise<T>((resolve) => {
    setImmediate(() => {
      clean()
      resolve(value)
    })
  })
}

/** A logger whose methods are spies. */
const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }

/** A client stub whose `quit` is `quit`, and its `disconnect` spy. */
function clientWith(quit: () => Promise<unknown>): { client: Redis; disconnect: jest.Mock } {
  const disconnect = jest.fn()
  return { client: { status: 'ready', quit, disconnect } as unknown as Redis, disconnect }
}

/** What a settled call came to. */
async function settled(call: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await call }
  } catch (error) {
    return { error }
  }
}

afterEach(() => {
  jest.restoreAllMocks()
  logger.log.mockClear()
  logger.warn.mockClear()
  logger.error.mockClear()
  clean()
})

describe('quitWithin runs the guard before it quits and before it waits', () => {
  it('does not send the quit when the prototype is polluted at entry, and disconnects', async () => {
    const quit = jest.fn(() => Promise.resolve('OK'))
    const { client, disconnect } = clientWith(quit)
    plant()

    await quitWithin(client, 1000, logger)

    expect(quit).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('refuses an answered quit when the prototype was polluted after the wait began', async () => {
    const { client, disconnect } = clientWith(() => answersCleanLater('OK'))
    plantWhenTimerIsArmed()

    await quitWithin(client, 1000, logger)

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(loggedEvents(logger.error)).toMatchObject([
      { event: QUEUE_LOG_EVENTS.GUARD_REFUSED, site: 'teardown' },
    ])
  })
})

describe('withDeadline runs the guard before it waits', () => {
  it('rejects with the refusal for work that answered after the prototype was polluted and cleaned', async () => {
    plantWhenTimerIsArmed()

    const seen = await settled(
      withDeadline(answersCleanLater('answer'), 1000, () => new Error('deadline')),
    )

    expect(seen).not.toHaveProperty('value')
    expect(seen.error).toBeInstanceOf(QueueException)
    expect(seen.error).toMatchObject({ message: expect.not.stringContaining('deadline') as string })
  })
})

describe('reportRefusal', () => {
  /** The error the guard throws when it refuses. */
  function refusal(): unknown {
    plant()
    try {
      assertPrototypeClean()
    } catch (error) {
      return error
    } finally {
      clean()
    }
    throw new Error('the guard did not refuse')
  }

  it('logs the refusal of the guard, with its text and the site', () => {
    const err = refusal()

    reportRefusal(logger, err, 'health')

    expect(loggedEvents(logger.error)).toEqual([
      {
        event: QUEUE_LOG_EVENTS.GUARD_REFUSED,
        message: 'The prototype guard refused; failed closed',
        site: 'health',
        err,
      },
    ])
  })

  it('logs nothing for an error that is not a refusal of the guard', () => {
    reportRefusal(logger, new Error('redis down'), 'health')

    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('runFlowBulk runs the guard after its trees', () => {
  it('rejects the batch when the prototype was polluted while a tree was added', async () => {
    const add = (flow: FlowJob): Promise<JobNode> => {
      plant()
      return Promise.resolve({ job: { id: flow.name } } as unknown as JobNode)
    }

    const run = runFlowBulk([{ name: 'a', queueName: 'q' }], add, 'addFlowBulk', 1)
    const seen = await settled(run.done)

    expect(seen).not.toHaveProperty('value')
    expect(seen.error).toBeInstanceOf(QueueException)
  })
})
