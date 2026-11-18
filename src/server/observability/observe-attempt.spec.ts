/**
 * @fileoverview Unit tests for observing one attempt of a job: the processor runs inside the
 * observers' process span with the headers stored with the job, the outcome and the duration are
 * reported, and the result or the error of the processor passes through untouched.
 * @layer server/observability
 */

import { DelayedError, RateLimitError, WaitingChildrenError, WaitingError } from 'bullmq'
import type { Job } from 'bullmq'
import { observeAttempt } from './observe-attempt'
import { QueueObserverRegistry } from './queue-observer'
import type { JobFinishedEvent } from './queue-observer'

/** A job as the worker receives it, with the given metadata and attempts. */
function jobWith(metadata: string | undefined, attemptsMade = 0, attempts = 1): Job {
  return {
    name: 'send',
    attemptsMade,
    opts: { attempts, ...(metadata === undefined ? {} : { telemetry: { metadata } }) },
  } as unknown as Job
}

/** A registry that records what it is told. */
function recording(): {
  registry: QueueObserverRegistry
  finished: JobFinishedEvent[]
  seen: unknown[]
} {
  const registry = new QueueObserverRegistry()
  const finished: JobFinishedEvent[] = []
  const seen: unknown[] = []
  registry.register({
    traceProcess: (info, carrier, run) => {
      seen.push({ info, carrier })
      return run()
    },
    jobFinished: (event) => finished.push(event),
  })
  return { registry, finished, seen }
}

describe('observeAttempt', () => {
  it('returns the result, reports completed with a duration, and passes the stored headers', async () => {
    const { registry, finished, seen } = recording()
    const metadata = JSON.stringify({ traceparent: 'tp' })

    const result = await observeAttempt(registry, 'email', jobWith(metadata), () =>
      Promise.resolve('sent'),
    )

    expect(result).toBe('sent')
    expect(seen).toEqual([
      { info: { queue: 'email', job: 'send' }, carrier: { traceparent: 'tp' } },
    ])
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ queue: 'email', outcome: 'completed' })
    expect(finished[0]?.durationSeconds).toBeGreaterThanOrEqual(0)
  })

  it('measures the time the processor ran', async () => {
    const { registry, finished } = recording()

    await observeAttempt(registry, 'email', jobWith(undefined), async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
    })

    expect(finished[0]?.durationSeconds).toBeGreaterThanOrEqual(0.02)
    expect(finished[0]?.durationSeconds).toBeLessThan(5)
  })

  it('rethrows the error as it is and reports retried while attempts remain', async () => {
    const { registry, finished } = recording()
    const error = new Error('boom')

    await expect(
      observeAttempt(registry, 'email', jobWith(undefined, 0, 3), () => Promise.reject(error)),
    ).rejects.toBe(error)

    expect(finished).toMatchObject([{ queue: 'email', outcome: 'retried' }])
  })

  it('reports failed on the last attempt', async () => {
    const { registry, finished } = recording()

    await observeAttempt(registry, 'email', jobWith(undefined, 2, 3), () =>
      Promise.reject(new Error('boom')),
    ).catch(() => undefined)

    expect(finished).toMatchObject([{ outcome: 'failed' }])
  })

  it('reports nothing for an error that hands the job back to BullMQ', async () => {
    const { registry, finished } = recording()
    const delayed = Object.assign(new Error('moved'), { name: 'DelayedError' })

    await expect(
      observeAttempt(registry, 'email', jobWith(undefined), () => Promise.reject(delayed)),
    ).rejects.toBe(delayed)

    expect(finished).toEqual([])
  })

  it.each([
    ['DelayedError', new DelayedError()],
    ['WaitingChildrenError', new WaitingChildrenError()],
    ['RateLimitError', new RateLimitError()],
    ['WaitingError', new WaitingError()],
  ])('counts nothing when the processor hands the job back with %s', async (_name, error) => {
    const { registry, finished } = recording()

    await expect(
      observeAttempt(registry, 'email', jobWith(undefined, 2, 3), () => Promise.reject(error)),
    ).rejects.toBe(error)

    expect(finished).toEqual([])
  })

  it('observes a job built by hand with no options, as a host does to call a handler in its own test', async () => {
    const { registry, finished, seen } = recording()
    const bare = { name: 'send', attemptsMade: 0 } as unknown as Job

    await expect(
      observeAttempt(registry, 'email', bare, () => Promise.resolve('ok')),
    ).resolves.toBe('ok')
    await expect(
      observeAttempt(registry, 'email', bare, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')

    expect(seen).toMatchObject([{ carrier: {} }, { carrier: {} }])
    expect(finished).toMatchObject([{ outcome: 'completed' }, { outcome: 'failed' }])
  })

  it('continues the trace of metadata that was already stored with the job, whoever wrote it', async () => {
    const { registry, seen } = recording()
    const written = JSON.stringify({ traceparent: 'tp', tracestate: 'a=b' })

    await observeAttempt(registry, 'email', jobWith(written), () => Promise.resolve())

    expect(seen).toMatchObject([{ carrier: { traceparent: 'tp', tracestate: 'a=b' } }])
  })
})
