/**
 * @fileoverview Unit tests for the queue's Prometheus metrics: the registry is scraped after the
 * actions, so a counter, a histogram and a gauge are read as a consumer's Prometheus would read
 * them, and the labels are checked to come from closed sets. The observer registry and the metrics
 * service are real or stubbed at their edges; prom-client is real.
 * @layer observability
 */

import 'reflect-metadata'
import { Registry } from 'prom-client'
import { QueueObserverRegistry, type MetricsService } from '@bymax-one/nest-queue'
import type { QueueMetrics } from '@bymax-one/nest-queue/shared'
import { BYMAX_METRICS_CONTRIBUTOR_METADATA } from '@bymax-one/nest-core/metrics'
import { QueueMetricsContributor } from './queue-metrics.contributor'

/** A snapshot of one queue's counts. */
function snapshot(queue: string, counts: Partial<QueueMetrics['counts']> = {}): QueueMetrics {
  return {
    queue,
    counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, ...counts },
    collectedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** A contributor over a fresh registry, with the snapshots `getAllWithinBound` answers. */
function setup(getAll: () => Promise<readonly QueueMetrics[]>): {
  observers: QueueObserverRegistry
  registry: Registry
} {
  const observers = new QueueObserverRegistry()
  const registry = new Registry()
  new QueueMetricsContributor(observers, {
    getAllWithinBound: getAll,
  } as unknown as MetricsService).registerMetrics(registry)
  return { observers, registry }
}

/** The samples of one metric, as `name{labels} value` lines. */
async function samples(registry: Registry, name: string): Promise<string[]> {
  return (await registry.metrics()).split('\n').filter((line) => line.startsWith(name))
}

describe('QueueMetricsContributor', () => {
  it('is marked so @bymax-one/nest-core finds it', () => {
    expect(Reflect.getMetadata(BYMAX_METRICS_CONTRIBUTOR_METADATA, QueueMetricsContributor)).toBe(
      true,
    )
  })

  it('counts each outcome of an attempt by queue', async () => {
    const { observers, registry } = setup(() => Promise.resolve([]))

    observers.jobFinished({ queue: 'email', outcome: 'completed', durationSeconds: 0.2 })
    observers.jobFinished({ queue: 'email', outcome: 'completed', durationSeconds: 0.2 })
    observers.jobFinished({ queue: 'email', outcome: 'retried', durationSeconds: 0.2 })
    observers.jobFinished({ queue: 'billing', outcome: 'failed', durationSeconds: 0.2 })

    expect(await samples(registry, 'bymax_queue_jobs_total')).toEqual([
      'bymax_queue_jobs_total{queue="email",outcome="completed"} 2',
      'bymax_queue_jobs_total{queue="email",outcome="retried"} 1',
      'bymax_queue_jobs_total{queue="billing",outcome="failed"} 1',
    ])
  })

  it('observes the duration in seconds by queue', async () => {
    const { observers, registry } = setup(() => Promise.resolve([]))

    observers.jobFinished({ queue: 'email', outcome: 'completed', durationSeconds: 0.2 })
    observers.jobFinished({ queue: 'email', outcome: 'completed', durationSeconds: 3 })

    const lines = await samples(registry, 'bymax_queue_job_duration_seconds')
    expect(lines).toContain('bymax_queue_job_duration_seconds_bucket{le="0.25",queue="email"} 1')
    expect(lines).toContain('bymax_queue_job_duration_seconds_bucket{le="5",queue="email"} 2')
    expect(lines).toContain('bymax_queue_job_duration_seconds_count{queue="email"} 2')
    expect(lines).toContain('bymax_queue_job_duration_seconds_sum{queue="email"} 3.2')
  })

  it('reports the depth of each queue by state from the cached snapshot, and only those states', async () => {
    const { registry } = setup(() =>
      Promise.resolve([
        snapshot('email', { waiting: 4, active: 1, delayed: 2, failed: 3, completed: 99 }),
      ]),
    )

    expect(await samples(registry, 'bymax_queue_depth{')).toEqual([
      'bymax_queue_depth{queue="email",state="waiting"} 4',
      'bymax_queue_depth{queue="email",state="active"} 1',
      'bymax_queue_depth{queue="email",state="delayed"} 2',
      'bymax_queue_depth{queue="email",state="failed"} 3',
    ])
  })

  it('drops a queue that is gone from the next scrape', async () => {
    let queues = [snapshot('email', { waiting: 1 }), snapshot('billing', { waiting: 2 })]
    const { registry } = setup(() => Promise.resolve(queues))
    await registry.metrics()

    queues = [snapshot('email', { waiting: 1 })]

    const lines = await samples(registry, 'bymax_queue_depth{')
    expect(lines.some((line) => line.includes('billing'))).toBe(false)
    expect(lines.some((line) => line.includes('email'))).toBe(true)
  })

  it('keeps the previous depth in place while the next read is still waited for', async () => {
    let answer: (value: readonly QueueMetrics[]) => void = () => undefined
    let reads = 0
    const { registry } = setup(() => {
      reads += 1
      if (reads === 1) return Promise.resolve([snapshot('email', { waiting: 1 })])
      return new Promise((resolve) => {
        answer = resolve
      })
    })
    await registry.metrics()
    const gauge = registry.getSingleMetric('bymax_queue_depth') as unknown as {
      hashMap: Record<string, unknown>
    }

    const second = registry.metrics()

    expect(Object.keys(gauge.hashMap)).toHaveLength(4)
    answer([])
    await second
    expect(Object.keys(gauge.hashMap)).toHaveLength(0)
  })

  it('reports no depth while metrics are off or Redis does not answer, and the scrape still works', async () => {
    const { observers, registry } = setup(() => Promise.reject(new Error('METRICS_DISABLED')))
    observers.jobFinished({ queue: 'email', outcome: 'completed', durationSeconds: 0.1 })

    expect(await samples(registry, 'bymax_queue_depth{')).toEqual([])
    expect(await samples(registry, 'bymax_queue_jobs_total')).toHaveLength(1)
  })

  it('has labels only from closed sets, and never an id, a name or an error', async () => {
    const { observers, registry } = setup(() =>
      Promise.resolve([snapshot('email', { waiting: 1 })]),
    )
    for (const outcome of ['completed', 'failed', 'retried'] as const) {
      observers.jobFinished({ queue: 'email', outcome, durationSeconds: 0.1 })
    }

    const text = await registry.metrics()
    const labelNames = new Set(
      [...text.matchAll(/\{([^}]*)\}/g)].flatMap(([, labels = '']) =>
        labels.split(',').map((pair) => pair.split('=')[0] ?? ''),
      ),
    )
    expect([...labelNames].sort()).toEqual(['le', 'outcome', 'queue', 'state'])
    const outcomes = [...text.matchAll(/outcome="([^"]*)"/g)].map(([, value]) => value)
    expect(new Set(outcomes)).toEqual(new Set(['completed', 'failed', 'retried']))
    const states = [...text.matchAll(/state="([^"]*)"/g)].map(([, value]) => value)
    expect(new Set(states)).toEqual(new Set(['waiting', 'active', 'delayed', 'failed']))
  })
})
