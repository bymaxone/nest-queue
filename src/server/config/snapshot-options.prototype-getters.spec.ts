/**
 * @fileoverview Unit tests that a module option a host defines as a getter on a class prototype is
 * read by name: the copy of the enumerable keys alone would drop it, so each name the snapshot knows
 * is pinned here by a literal list of its own, not by iterating the list the source holds.
 * @layer server/config
 */

import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { snapshotOptions } from './snapshot-options'

/** A host whose only field is `name`, answered by a getter on the prototype, as a class has it. */
function hostWith(name: string, value: unknown): Record<string, unknown> {
  class Host {}
  Object.defineProperty(Host.prototype, name, { get: () => value, configurable: true })
  return new Host() as unknown as Record<string, unknown>
}

const telemetry = { traceEnqueue: () => undefined }

describe('a top-level option that is a getter on a class prototype', () => {
  it.each([
    ['prefix', 'p'],
    ['isGlobal', true],
    ['connectionReadyTimeoutMs', 1234],
    ['commandTimeoutMs', 2345],
    ['enqueueTimeoutMs', 3456],
  ])('keeps %s as the getter answers it', (name, value) => {
    const snapshot = snapshotOptions(hostWith(name, value) as unknown as BymaxQueueModuleOptions)

    expect(snapshot).toHaveProperty([name], value)
  })

  it.each([
    ['connection', { url: 'redis://prototype:6379' }],
    ['defaultJobOptions', { attempts: 5 }],
    ['queueOptions', { streams: { events: { maxLen: 7 } } }],
    ['flows', { enabled: true }],
    ['metrics', { enabled: true }],
    ['shutdown', { drainOnShutdown: true }],
  ])('keeps the content of %s as the getter answers it', (name, value) => {
    const snapshot = snapshotOptions(hostWith(name, value) as unknown as BymaxQueueModuleOptions)

    expect(snapshot).toHaveProperty([name])
    expect(snapshot[name as keyof BymaxQueueModuleOptions]).toMatchObject(value)
  })

  it('keeps telemetry by reference as the getter answers it', () => {
    const snapshot = snapshotOptions(
      hostWith('telemetry', telemetry) as unknown as BymaxQueueModuleOptions,
    )

    expect(snapshot.telemetry).toBe(telemetry)
  })
})

describe('the metrics group that is a class instance', () => {
  it.each([
    ['enabled', true],
    ['cacheTtlMs', 1000],
  ])('reads %s from a getter on the prototype', (name, value) => {
    const metrics = hostWith(name, value)
    const snapshot = snapshotOptions({
      connection: { url: 'redis://localhost:6379' },
      metrics,
    })

    expect(snapshot.metrics).toHaveProperty([name], value)
  })
})
