/**
 * @fileoverview Unit tests for how the registry reads an observer's trace hook. The hook is the
 * host's: a getter can throw, answer something that is not a function, or answer differently the
 * second time. None of those may fail the enqueue or the processing, or reach the caller as the
 * host's own error; each is the observer failing, logged once, and the operation runs as it is.
 * @layer server/observability
 */

import { Logger } from '@nestjs/common'
import { loggedEvents } from '../utils/log-lines'
import { QueueObserverRegistry } from './queue-observer'
import type { QueueObserver } from './queue-observer'

/** Run the operation the hook wraps, resolving to what the operation returns. */
const RUN = {
  traceEnqueue: (registry: QueueObserverRegistry): Promise<string> =>
    registry.traceEnqueue({ queue: 'q' }, () => Promise.resolve('done')),
  traceProcess: (registry: QueueObserverRegistry): Promise<string> =>
    registry.traceProcess({ queue: 'q' }, {}, () => Promise.resolve('done')),
} as const

/** An observer whose `hook` is the host's getter. */
function observerWith(hook: 'traceEnqueue' | 'traceProcess', get: () => unknown): QueueObserver {
  return Object.defineProperty({}, hook, { get, enumerable: true })
}

describe.each(['traceEnqueue', 'traceProcess'] as const)(
  'QueueObserverRegistry — the %s hook',
  (hook) => {
    let warn: jest.SpyInstance

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    })

    /** One log line for the observer failing, naming the hook and carrying no value of the host's. */
    const failedOnce = [
      {
        event: 'QUEUE_OBSERVER_FAILED',
        message: `A queue observer threw from ${hook}; it is ignored and the job is not affected`,
        hook,
      },
    ]

    it('runs the operation and logs one failure when reading the hook throws', async () => {
      const registry = new QueueObserverRegistry()
      registry.register(
        observerWith(hook, () => {
          throw new Error('SENTINEL-getter')
        }),
      )

      await expect(RUN[hook](registry)).resolves.toBe('done')

      expect(loggedEvents(warn)).toStrictEqual(failedOnce)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL')
    })

    it.each([
      ['a string', 'x'],
      ['a number', 7],
      ['an object', {}],
      ['true', true],
    ])('runs the operation and logs one failure when the hook is %s', async (_label, value) => {
      const registry = new QueueObserverRegistry()
      registry.register(observerWith(hook, () => value))

      await expect(RUN[hook](registry)).resolves.toBe('done')

      expect(loggedEvents(warn)).toStrictEqual(failedOnce)
    })

    it.each([undefined, null])(
      'treats a hook that is %s as absent, with nothing logged',
      async (value) => {
        const registry = new QueueObserverRegistry()
        registry.register(observerWith(hook, () => value))

        await expect(RUN[hook](registry)).resolves.toBe('done')

        expect(warn).not.toHaveBeenCalled()
      },
    )

    it('reads the hook once for one operation', async () => {
      const registry = new QueueObserverRegistry()
      const reads = jest.fn()
      registry.register(
        observerWith(hook, () => {
          reads()
          return (_info: unknown, _a: unknown, run: () => Promise<unknown>) => run()
        }),
      )

      await RUN[hook](registry)

      expect(reads).toHaveBeenCalledTimes(1)
    })

    it('still runs the observers after the one whose hook could not be read', async () => {
      const registry = new QueueObserverRegistry()
      const seen: string[] = []
      registry.register(
        observerWith(hook, () => {
          throw new Error('first')
        }),
      )
      registry.register(
        observerWith(hook, () => (_info: unknown, _a: unknown, run: () => Promise<unknown>) => {
          seen.push('second')
          return run()
        }),
      )

      await expect(RUN[hook](registry)).resolves.toBe('done')

      expect(seen).toEqual(['second'])
      expect(loggedEvents(warn)).toStrictEqual(failedOnce)
    })
  },
)
