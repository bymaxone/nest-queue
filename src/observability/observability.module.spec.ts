/**
 * @fileoverview Unit test for the observability module wiring: it provides and exports the metrics
 * contributor, the readiness indicator and the tracing observer, and Nest resolves them next to the
 * queue module, with the tracing observer registered on the module's observer registry.
 * @layer observability
 */

import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { BymaxQueueModule, ConnectionResolver, QueueObserverRegistry } from '@bymax-one/nest-queue'
import { BymaxQueueObservabilityModule } from './observability.module'
import { QueueHealthIndicator } from './queue-health.indicator'
import { QueueMetricsContributor } from './queue-metrics.contributor'
import { QueueTracingObserver } from './queue-tracing.observer'

describe('BymaxQueueObservabilityModule', () => {
  it('provides and exports the contributor, the indicator and the tracing observer', () => {
    const providers = Reflect.getMetadata('providers', BymaxQueueObservabilityModule) as unknown[]
    const exported = Reflect.getMetadata('exports', BymaxQueueObservabilityModule) as unknown[]

    expect(providers).toEqual([QueueMetricsContributor, QueueHealthIndicator, QueueTracingObserver])
    expect(exported).toEqual(providers)
  })

  it('resolves next to the queue module, and the tracing observer registers on init', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } }),
        BymaxQueueObservabilityModule,
      ],
    })
      .overrideProvider(ConnectionResolver)
      .useValue({
        getClient: jest.fn(),
        getMode: jest.fn(),
        teardown: jest.fn().mockResolvedValue(undefined),
      })
      .compile()

    expect(moduleRef.get(QueueMetricsContributor)).toBeInstanceOf(QueueMetricsContributor)
    expect(moduleRef.get(QueueTracingObserver)).toBeInstanceOf(QueueTracingObserver)
    await moduleRef.init()
    expect(moduleRef.get(QueueObserverRegistry).active).toBe(true)
    await moduleRef.close()
    expect(moduleRef.get(QueueObserverRegistry).active).toBe(false)
  })
})
