/**
 * @fileoverview Pins the README's Metrics table to the collectors the contributor registers: every
 * metric is listed once with its type and labels, and nothing is listed that is not registered.
 * @layer observability
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Registry } from 'prom-client'
import { QueueObserverRegistry, type MetricsService } from '@bymax-one/nest-queue'
import { QueueMetricsContributor } from './queue-metrics.contributor'

const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf8')

/** The rows of the Metrics table: name, type, labels, as the README writes them. */
function documented(): { name: string; type: string; labels: string[] }[] {
  const lines = readme.split('\n')
  const start = lines.findIndex((line) => line.startsWith('### Metrics'))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('### '))
  return lines
    .slice(start, end)
    .filter((line) => line.startsWith('| `bymax_'))
    .map((line) => {
      const [name = '', type = '', labels = ''] = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
      return {
        name: name.replaceAll('`', ''),
        type,
        labels: labels
          .replaceAll('`', '')
          .split(',')
          .map((label) => label.trim()),
      }
    })
}

describe('README metrics', () => {
  it('lists each registered metric once, with its type and labels', () => {
    const registry = new Registry()
    new QueueMetricsContributor(new QueueObserverRegistry(), {} as MetricsService).registerMetrics(
      registry,
    )
    const registered = registry.getMetricsAsArray().map((metric) => ({
      name: metric.name,
      type: (metric as unknown as { type: string }).type,
      labels: [...(metric as unknown as { labelNames: string[] }).labelNames],
    }))

    expect(documented()).toEqual(registered)
  })
})
