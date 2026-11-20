/**
 * @fileoverview Unit tests for the observer registry: observers wrap an enqueue and an attempt in
 * the order they were registered, share one carrier, can be removed, and cannot fail a job by
 * throwing from the hook that reports its end. With none registered an operation runs untouched.
 * @layer server/observability
 */

import { Logger } from '@nestjs/common'
import { loggedEvents } from '../utils/log-lines'
import { QueueObserverRegistry } from './queue-observer'
import type { QueueObserver } from './queue-observer'

describe('QueueObserverRegistry — enqueue', () => {
  it('runs the enqueue as it is, with an empty carrier, when nothing is registered', async () => {
    const registry = new QueueObserverRegistry()

    const result = await registry.traceEnqueue({ queue: 'q' }, (carrier) =>
      Promise.resolve(Object.keys(carrier)),
    )

    expect(result).toEqual([])
    expect(registry.active).toBe(false)
  })

  it('wraps the enqueue in each observer, the first registered outermost, and shares the carrier', async () => {
    const registry = new QueueObserverRegistry()
    const order: string[] = []
    const observer = (name: string): QueueObserver => ({
      traceEnqueue: async (info, carrier, run) => {
        order.push(`${name} in ${info.queue}`)
        carrier[name] = 'written'
        const result = await run()
        order.push(`${name} out`)
        return result
      },
    })
    registry.register(observer('first'))
    registry.register(observer('second'))

    const carrier = await registry.traceEnqueue({ queue: 'q', job: 'j' }, (written) => {
      order.push('run')
      return Promise.resolve(written)
    })

    expect(order).toEqual(['first in q', 'second in q', 'run', 'second out', 'first out'])
    expect(carrier).toEqual({ first: 'written', second: 'written' })
  })

  it('skips an observer that has no enqueue hook', async () => {
    const registry = new QueueObserverRegistry()
    registry.register({ jobFinished: () => undefined })

    await expect(
      registry.traceEnqueue({ queue: 'q' }, () => Promise.resolve('done')),
    ).resolves.toBe('done')
    expect(registry.active).toBe(true)
  })

  it('passes a rejection of the enqueue through', async () => {
    const registry = new QueueObserverRegistry()
    registry.register({ traceEnqueue: (_info, _carrier, run) => run() })

    await expect(
      registry.traceEnqueue({ queue: 'q' }, () => Promise.reject(new Error('refused'))),
    ).rejects.toThrow('refused')
  })
})

describe('QueueObserverRegistry — process', () => {
  it('runs the attempt as it is when nothing is registered', async () => {
    await expect(
      new QueueObserverRegistry().traceProcess({ queue: 'q' }, {}, () => Promise.resolve(7)),
    ).resolves.toBe(7)
  })

  it('hands each observer the carrier stored with the job and wraps the attempt in order', async () => {
    const registry = new QueueObserverRegistry()
    const order: string[] = []
    const seen: unknown[] = []
    registry.register({
      traceProcess: async (info, carrier, run) => {
        order.push(`outer ${info.queue}/${String(info.job)}`)
        seen.push(carrier)
        return run()
      },
    })
    registry.register({ jobFinished: () => undefined })
    registry.register({
      traceProcess: (_info, _carrier, run) => {
        order.push('inner')
        return run()
      },
    })

    const result = await registry.traceProcess(
      { queue: 'q', job: 'j' },
      { traceparent: 'tp' },
      () => {
        order.push('run')
        return Promise.resolve('ok')
      },
    )

    expect(result).toBe('ok')
    expect(order).toEqual(['outer q/j', 'inner', 'run'])
    expect(seen).toEqual([{ traceparent: 'tp' }])
  })
})

describe('QueueObserverRegistry — jobFinished and removal', () => {
  const event = { queue: 'q', outcome: 'completed', durationSeconds: 0.5 } as const

  it('tells every observer, and ignores one that throws', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new QueueObserverRegistry()
    const heard: unknown[] = []
    registry.register({
      jobFinished: () => {
        throw new Error('observer bug')
      },
    })
    registry.register({ traceEnqueue: (_info, _carrier, run) => run() })
    registry.register({ jobFinished: (finished) => heard.push(finished) })

    expect(() => {
      registry.jobFinished(event)
    }).not.toThrow()
    expect(heard).toEqual([event])
  })

  it('logs the throw of an observer as an event with no value of its own, and says nothing for an observer without the hook', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new QueueObserverRegistry()
    registry.register({ traceEnqueue: (_info, _carrier, run) => run() })
    registry.jobFinished(event)
    expect(warn).not.toHaveBeenCalled()
    registry.register({
      jobFinished: () => {
        throw new Error('SENTINEL-observer-value')
      },
    })

    registry.jobFinished(event)

    expect(loggedEvents(warn)).toStrictEqual([
      {
        event: 'QUEUE_OBSERVER_FAILED',
        message:
          'A queue observer threw from jobFinished; it is ignored and the job is not affected',
        hook: 'jobFinished',
      },
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL')
  })

  it('stops telling an observer that was removed, and removes it once', () => {
    const registry = new QueueObserverRegistry()
    const heard: unknown[] = []
    const remove = registry.register({ jobFinished: (finished) => heard.push(finished) })
    registry.register({ jobFinished: () => undefined })

    remove()
    remove()
    registry.jobFinished(event)

    expect(heard).toEqual([])
    expect(registry.active).toBe(true)
  })

  it('tells an observer that removes itself while it is being told, and the ones after it', () => {
    const registry = new QueueObserverRegistry()
    const heard: string[] = []
    const removeFirst = registry.register({
      jobFinished: () => {
        heard.push('first')
        removeFirst()
      },
    })
    registry.register({ jobFinished: () => heard.push('second') })

    registry.jobFinished(event)
    registry.jobFinished(event)

    expect(heard).toEqual(['first', 'second', 'second'])
  })
})

/** The hook types, without the `undefined` an optional member adds. */
type FinishedHook = NonNullable<QueueObserver['jobFinished']>

/** A hook typed to return nothing that returns something anyway, as an `async` function does. */
const asHook = (hook: () => unknown): FinishedHook => hook
type TraceHook = NonNullable<QueueObserver['traceEnqueue']>

/** Let every microtask and the next macrotask run, so a rejection nobody caught has surfaced. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('QueueObserverRegistry — a hook that returns a promise', () => {
  const event = { queue: 'q', outcome: 'completed', durationSeconds: 0.5 } as const
  let unhandled: jest.Mock

  beforeEach(() => {
    unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', unhandled)
  })

  const rejecting = (): Promise<void> => Promise.reject(new Error('SENTINEL-async-observer'))

  it('logs a rejecting jobFinished as an event and leaves no unhandled rejection', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new QueueObserverRegistry()
    registry.register({ jobFinished: asHook(rejecting) })
    const heard: unknown[] = []
    registry.register({ jobFinished: (finished) => heard.push(finished) })

    registry.jobFinished(event)
    await settle()

    expect(unhandled).not.toHaveBeenCalled()
    expect(heard).toEqual([event])
    expect(loggedEvents(warn)).toStrictEqual([
      {
        event: 'QUEUE_OBSERVER_FAILED',
        message:
          'A queue observer threw from jobFinished; it is ignored and the job is not affected',
        hook: 'jobFinished',
      },
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL')
  })

  it('logs a thenable that is not a Promise, and one whose then throws', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new QueueObserverRegistry()
    const thenable = {
      then: (_resolve: () => void, reject: (reason: unknown) => void) => {
        reject(new Error('thenable'))
      },
    }
    const throwing = {
      get then(): never {
        throw new Error('getter')
      },
    }
    registry.register({ jobFinished: asHook(() => thenable) })
    registry.register({ jobFinished: asHook(() => throwing) })

    registry.jobFinished(event)
    await settle()

    expect(unhandled).not.toHaveBeenCalled()
    expect(loggedEvents(warn)).toHaveLength(2)
  })

  it('says nothing for a jobFinished that resolves', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new QueueObserverRegistry()
    registry.register({ jobFinished: asHook(() => Promise.resolve()) })

    registry.jobFinished(event)
    await settle()

    expect(warn).not.toHaveBeenCalled()
  })
})

describe.each(['traceEnqueue', 'traceProcess'] as const)(
  'QueueObserverRegistry — %s that fails',
  (hook) => {
    const operate = (
      registry: QueueObserverRegistry,
      run: () => Promise<string>,
    ): Promise<string> =>
      hook === 'traceEnqueue'
        ? registry.traceEnqueue({ queue: 'q' }, run)
        : registry.traceProcess({ queue: 'q' }, {}, run)
    const observe = (trace: TraceHook): QueueObserver =>
      hook === 'traceEnqueue' ? { traceEnqueue: trace } : { traceProcess: trace }
    const logged = (warn: jest.SpyInstance): unknown =>
      loggedEvents(warn).map((line) => [line.event, line.hook])

    it.each([
      [
        'throws before it runs the operation',
        (): never => {
          throw new Error('sync')
        },
      ],
      ['rejects before it runs the operation', () => Promise.reject(new Error('async'))],
    ])('still runs the operation once when the observer %s', async (_name, trace) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const registry = new QueueObserverRegistry()
      registry.register(observe(trace))
      const run = jest.fn(() => Promise.resolve('result'))

      await expect(operate(registry, run)).resolves.toBe('result')

      expect(run).toHaveBeenCalledTimes(1)
      expect(logged(warn)).toStrictEqual([['QUEUE_OBSERVER_FAILED', hook]])
    })

    it('runs the operation once when the observer returns without running it, and passes its error through', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const registry = new QueueObserverRegistry()
      registry.register(observe(() => Promise.resolve('skipped') as never))
      const run = jest.fn(() => Promise.resolve('result'))

      await expect(operate(registry, run)).resolves.toBe('result')

      expect(run).toHaveBeenCalledTimes(1)
      expect(logged(warn)).toStrictEqual([['QUEUE_OBSERVER_FAILED', hook]])
      const own = new Error('the processor failed')

      await expect(operate(registry, () => Promise.reject(own))).rejects.toBe(own)
      expect(logged(warn)).toHaveLength(2)
    })

    it.each([
      ['the observer returns without running it', () => Promise.resolve('skipped') as never],
      [
        'the observer runs it and lets the throw through',
        (_i: unknown, _c: unknown, run: () => Promise<never>) => run(),
      ],
    ])(
      'runs an operation that throws synchronously once, and passes its error through, when %s',
      async (_name, trace) => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        const registry = new QueueObserverRegistry()
        registry.register(observe(trace))
        let calls = 0

        const outcome = await operate(registry, () => {
          calls += 1
          throw new Error(`call ${String(calls)}`)
        }).catch((error: unknown) => error)

        expect(calls).toBe(1)
        expect(outcome).toEqual(new Error('call 1'))
      },
    )

    it('returns what an observer returns after running the operation, and runs it once however often it asks', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const registry = new QueueObserverRegistry()
      registry.register(
        observe(async (_info, _carrier, run) => {
          await run()
          await run()
          return 'replaced' as never
        }),
      )
      const run = jest.fn(() => Promise.resolve('result'))

      await expect(operate(registry, run)).resolves.toBe('replaced')

      expect(run).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
    })

    it('runs the operation once and passes its error through when the observer fails before running it', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const own = new Error('the processor failed')
      const registry = new QueueObserverRegistry()
      registry.register(observe(() => Promise.reject(new Error('observer'))))
      const run = jest.fn(() => Promise.reject(own))

      await expect(operate(registry, run)).rejects.toBe(own)

      expect(run).toHaveBeenCalledTimes(1)
      expect(logged(warn)).toStrictEqual([['QUEUE_OBSERVER_FAILED', hook]])
    })

    it('leaves no unhandled rejection when the observer starts the operation, does not await it, and the operation then rejects', async () => {
      const unhandled = jest.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const registry = new QueueObserverRegistry()
        registry.register(
          observe((_info, _carrier, run) => {
            void run()
            return Promise.resolve('returned early') as never
          }),
        )

        await expect(
          operate(
            registry,
            () => new Promise((_resolve, reject) => setImmediate(reject, new Error('late'))),
          ),
        ).resolves.toBe('returned early')
        await settle()

        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('returns the operation result when the observer fails after running it', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const registry = new QueueObserverRegistry()
      registry.register(
        observe(async (_info, _carrier, run) => {
          await run()
          throw new Error('after')
        }),
      )

      await expect(operate(registry, () => Promise.resolve('result'))).resolves.toBe('result')

      expect(logged(warn)).toStrictEqual([['QUEUE_OBSERVER_FAILED', hook]])
    })

    it('passes the error of the operation through as it is, and logs only an observer that replaces it', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const own = new Error('the processor failed')
      const recorded: unknown[] = []
      const registry = new QueueObserverRegistry()
      registry.register(observe((_info, _carrier, run) => run()))
      const rethrowing = registry.register(
        observe((_info, _carrier, run) =>
          // A tracing wrapper records the error and rethrows it.
          run().catch((error: unknown) => {
            recorded.push(error)
            throw error
          }),
        ),
      )

      await expect(operate(registry, () => Promise.reject(own))).rejects.toBe(own)
      expect(recorded).toEqual([own])
      expect(warn).not.toHaveBeenCalled()
      rethrowing()
      registry.register(
        observe(async (_info, _carrier, run) => {
          await run().catch(() => undefined)
          throw new Error('replacement')
        }),
      )

      await expect(operate(registry, () => Promise.reject(own))).rejects.toBe(own)
      expect(logged(warn)).toStrictEqual([['QUEUE_OBSERVER_FAILED', hook]])
    })
  },
)

describe('QueueObserverRegistry — the event each observer receives', () => {
  it('hands every observer its own frozen copy, so one cannot change what the next one hears', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const registry = new QueueObserverRegistry()
    const seen: unknown[] = []
    registry.register({
      jobFinished: (event) => {
        seen.push(event)
        ;(event as { outcome: string }).outcome = 'failed'
      },
    })
    registry.register({ jobFinished: (event) => seen.push(event) })
    const original = { queue: 'q', outcome: 'completed', durationSeconds: 0.5 } as const

    registry.jobFinished(original)

    expect(seen).toEqual([original, original])
    expect(seen[0]).not.toBe(seen[1])
    expect(Object.isFrozen(seen[1])).toBe(true)
    expect(original.outcome).toBe('completed')
  })
})
