/**
 * @fileoverview Unit test for the case of no OpenTelemetry SDK: the API is a no-op, so the spans cost
 * nothing, the operation runs as it is and no header is written for the queue to store.
 * @layer observability
 */

import 'reflect-metadata'
import { QueueObserverRegistry } from '@bymax-one/nest-queue'
import { QueueTracingObserver } from './queue-tracing.observer'

describe('QueueTracingObserver without an SDK', () => {
  it('runs the operation and writes no trace context', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())
    const carrier: Record<string, string> = {}

    const result = await observer.traceEnqueue({ queue: 'email' }, carrier, () =>
      Promise.resolve('added'),
    )

    expect(result).toBe('added')
    expect(carrier).toEqual({})
  })

  it('runs the processor as it is', async () => {
    const observer = new QueueTracingObserver(new QueueObserverRegistry())

    await expect(
      observer.traceProcess({ queue: 'email' }, {}, () => Promise.resolve(7)),
    ).resolves.toBe(7)
  })
})
