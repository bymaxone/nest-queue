/**
 * @fileoverview Unit tests for how the module options are read: a key that holds `undefined` or
 * `null` is "not given" in every group, so it keeps the library default instead of overwriting it,
 * a getter (own or inherited from a class) counts as a value, and the options are read once, so a
 * getter that answers differently the second time cannot pass validation and be applied differently.
 * @layer server/config
 */

import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { applyDefaults } from './resolved-options'
import { snapshotOptions } from './snapshot-options'
import { validateOptions } from './validate-options'

const connection = { url: 'redis://localhost:6379' }

/** Module options with the given extra fields, typed loosely because the point is bad input. */
function optionsWith(extra: Record<string, unknown>): BymaxQueueModuleOptions {
  return { connection, ...extra }
}

/** A class whose `enabled` is a getter on the prototype, as a class instance has it. */
class InstanceFlows {
  constructor(private readonly enabledValue: unknown) {}
  get enabled(): unknown {
    return this.enabledValue
  }
}

/** A class whose `attempts` is a getter on the prototype, as a class instance has it. */
class InstanceOptions {
  constructor(private readonly attemptsValue: unknown) {}
  get attempts(): unknown {
    return this.attemptsValue
  }
}

describe('a key that holds undefined or null is not given', () => {
  it.each([undefined, null])('keeps the default job options when attempts is %s', (unset) => {
    const resolved = applyDefaults(optionsWith({ defaultJobOptions: { attempts: unset } }))

    expect(resolved.defaultJobOptions.attempts).toBe(3)
    expect(resolved.defaultJobOptions.removeOnFail).toEqual({ age: 604_800, count: 5000 })
  })

  it.each([undefined, null])('keeps the default of every grouped option when it is %s', (unset) => {
    const resolved = applyDefaults(
      optionsWith({
        flows: { enabled: unset },
        metrics: { enabled: unset, cacheTtlMs: unset },
        shutdown: { drainTimeoutMs: unset, drainOnShutdown: unset },
        prefix: unset,
        commandTimeoutMs: unset,
      }),
    )

    expect(resolved.flows).toEqual({ enabled: false })
    expect(resolved.metrics).toEqual({ enabled: false, cacheTtlMs: 5000 })
    expect(resolved.shutdown).toEqual({ drainTimeoutMs: 30_000, drainOnShutdown: false })
    expect(resolved.prefix).toBe('bull')
    expect(resolved.commandTimeoutMs).toBe(5000)
  })

  it.each([undefined, null])('validates a group of %s values as an empty one', (unset) => {
    expect(() => {
      validateOptions(
        optionsWith({
          defaultJobOptions: { delay: unset, priority: unset },
          metrics: { cacheTtlMs: unset },
          shutdown: { drainTimeoutMs: unset },
          enqueueTimeoutMs: unset,
        }),
      )
    }).not.toThrow()
  })

  it('still refuses a value that is set and wrong, in the same group as an unset one', () => {
    expect(() => {
      validateOptions(optionsWith({ shutdown: { drainTimeoutMs: -1, drainOnShutdown: undefined } }))
    }).toThrow()
  })
})

describe('a group that is a class instance', () => {
  it('reads an inherited getter as a value, so it is validated and applied', () => {
    const options = optionsWith({ defaultJobOptions: new InstanceOptions(5) })

    expect(() => {
      validateOptions(options)
    }).not.toThrow()
    expect(applyDefaults(options).defaultJobOptions.attempts).toBe(5)
  })

  it('refuses an inherited getter that holds a bad value', () => {
    expect(() => {
      validateOptions(optionsWith({ defaultJobOptions: new InstanceOptions(-1) }))
    }).toThrow()
  })

  it.each([undefined, null])('keeps the default when the inherited getter holds %s', (unset) => {
    const resolved = applyDefaults(optionsWith({ defaultJobOptions: new InstanceOptions(unset) }))

    expect(resolved.defaultJobOptions.attempts).toBe(3)
  })
})

describe('the other groups that are a class instance', () => {
  it('reads an inherited getter of the flows group as a value', () => {
    expect(applyDefaults(optionsWith({ flows: new InstanceFlows(true) })).flows).toEqual({
      enabled: true,
    })
  })

  it('copies the flows group with no prototype and without its unset keys', () => {
    // A `null` flag is kept, not dropped: it is the same mistake as an unset environment variable, and
    // validation refuses it by name, where a dropped one would read as the default.
    expect(snapshotOptions(optionsWith({ flows: { enabled: null } })).flows).toEqual({
      enabled: null,
    })
    expect(snapshotOptions(optionsWith({ flows: {} })).flows).toEqual({})
    const copy = snapshotOptions(optionsWith({ flows: new InstanceFlows(true) })).flows

    expect(copy).toMatchObject({ enabled: true })
    // No prototype, so a key planted on the root prototype is not answered for a key the copy lacks.
    expect(Object.getPrototypeOf(copy)).toBeNull()
  })

  it('leaves a group that was not given out of the copy', () => {
    const snapshot = snapshotOptions(optionsWith({}))

    for (const name of ['defaultJobOptions', 'flows', 'metrics', 'shutdown']) {
      expect(name in snapshot).toBe(false)
    }
  })
})

describe('the options are read once', () => {
  it('reads a getter one time, so the value that is validated is the value that is applied', () => {
    let reads = 0
    const options = optionsWith({
      defaultJobOptions: {
        get attempts(): number {
          reads += 1
          return reads === 1 ? 4 : -1
        },
      },
    })

    const snapshot = snapshotOptions(options)
    validateOptions(snapshot)
    const resolved = applyDefaults(snapshot)

    expect(reads).toBe(1)
    expect(resolved.defaultJobOptions.attempts).toBe(4)
  })

  it('keeps the connection, the queue options and the telemetry by reference', () => {
    const queueOptions = { settings: {} }
    const telemetry = { name: 't' }

    const snapshot = snapshotOptions(optionsWith({ queueOptions, telemetry }))

    expect(snapshot.connection).toBe(connection)
    expect(snapshot.queueOptions).toBe(queueOptions)
    expect(snapshot.telemetry).toBe(telemetry)
  })

  it('leaves a group that is not an object for validation to judge', () => {
    const snapshot = snapshotOptions(optionsWith({ defaultJobOptions: 'nope', flows: 7 }))

    expect(snapshot.defaultJobOptions).toBe('nope')
    expect(snapshot.flows).toBe(7)
  })
})
