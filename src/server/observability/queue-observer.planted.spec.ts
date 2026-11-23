/**
 * @fileoverview Unit tests for a hook name planted on the root prototype: an observer that does not
 * define a hook has none, so the registry must not call one that `Object.prototype` answers with,
 * while a hook the observer owns, or a method of its class, is still called.
 * @layer server/observability
 */

import { QueueObserverRegistry } from './queue-observer'
import type { QueueObserver } from './queue-observer'

/** Plant `hook` on the root prototype as a function that counts its calls, and run `body`. */
async function withPlantedHook(
  hook: string,
  body: (calls: () => number) => Promise<void>,
): Promise<void> {
  let calls = 0
  Object.defineProperty(Object.prototype, hook, {
    value: (...args: unknown[]): unknown => {
      calls += 1
      return args.at(-1) instanceof Function ? (args.at(-1) as () => unknown)() : undefined
    },
    configurable: true,
    writable: true,
  })
  try {
    await body(() => calls)
  } finally {
    Reflect.deleteProperty(Object.prototype, hook)
  }
}

describe('QueueObserverRegistry ignores a hook planted on the root prototype', () => {
  it('does not call a planted traceEnqueue', async () => {
    await withPlantedHook('traceEnqueue', async (calls) => {
      const registry = new QueueObserverRegistry()
      registry.register({})

      await expect(
        registry.traceEnqueue({ queue: 'q' }, () => Promise.resolve('done')),
      ).resolves.toBe('done')
      expect(calls()).toBe(0)
    })
  })

  it('does not call a planted traceProcess', async () => {
    await withPlantedHook('traceProcess', async (calls) => {
      const registry = new QueueObserverRegistry()
      registry.register({})

      await expect(
        registry.traceProcess({ queue: 'q' }, {}, () => Promise.resolve('done')),
      ).resolves.toBe('done')
      expect(calls()).toBe(0)
    })
  })

  it('does not call a planted jobFinished', async () => {
    await withPlantedHook('jobFinished', (calls) => {
      const registry = new QueueObserverRegistry()
      registry.register({})

      registry.jobFinished({ queue: 'q', outcome: 'completed' } as never)

      expect(calls()).toBe(0)
      return Promise.resolve()
    })
  })

  it('still calls a hook the observer owns and a method of its class', async () => {
    const seen: string[] = []
    class Own implements QueueObserver {
      jobFinished(): void {
        seen.push('class')
      }
    }
    const registry = new QueueObserverRegistry()
    registry.register(new Own())
    registry.register({
      traceEnqueue: <T>(_i: unknown, _c: unknown, run: () => Promise<T>): Promise<T> => {
        seen.push('own')
        return run()
      },
    })

    await registry.traceEnqueue({ queue: 'q' }, () => Promise.resolve(1))
    registry.jobFinished({ queue: 'q', outcome: 'completed' } as never)

    expect(seen).toEqual(['own', 'class'])
  })
})
