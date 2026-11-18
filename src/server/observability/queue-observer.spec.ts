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
