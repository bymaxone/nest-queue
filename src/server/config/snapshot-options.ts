/**
 * @fileoverview One read of the module options, as a plain object with the unset values dropped.
 * A key that holds `undefined` or `null` is "not given": spread over the library defaults it would
 * overwrite them, and a validator that read it would refuse a value the consumer never set. Each
 * known key of a group is read by property access, so a getter, own or inherited from a class,
 * counts as a value, and the result is read once, so a getter that answers differently the second
 * time cannot pass validation with one value and be applied with another.
 * @layer server/config
 */

import type { JobsOptions } from 'bullmq'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'

/** The job options whose values are checked, so each is read even when it is inherited. */
const JOB_OPTION_KEYS = [
  'attempts',
  'delay',
  'priority',
  'backoff',
  'removeOnComplete',
  'removeOnFail',
] as const satisfies readonly (keyof JobsOptions)[]

const FLOWS_KEYS = ['enabled'] as const satisfies readonly (keyof NonNullable<
  BymaxQueueModuleOptions['flows']
>)[]
const METRICS_KEYS = ['enabled', 'cacheTtlMs'] as const satisfies readonly (keyof NonNullable<
  BymaxQueueModuleOptions['metrics']
>)[]
const SHUTDOWN_KEYS = [
  'drainTimeoutMs',
  'drainOnShutdown',
] as const satisfies readonly (keyof NonNullable<BymaxQueueModuleOptions['shutdown']>)[]
const TOP_LEVEL_KEYS = [
  'connection',
  'defaultJobOptions',
  'prefix',
  'queueOptions',
  'flows',
  'metrics',
  'telemetry',
  'shutdown',
  'isGlobal',
  'connectionReadyTimeoutMs',
  'commandTimeoutMs',
  'enqueueTimeoutMs',
] as const satisfies readonly (keyof BymaxQueueModuleOptions)[]

/**
 * Copy the set values of a group: every own enumerable key and every `known` key, each read once by
 * property access. A value that is not an object is returned as it is, for validation to judge.
 */
function setValuesOf<T>(group: T, known: readonly string[]): T {
  if (typeof group !== 'object') return group
  const source = group as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(source), ...known])) {
    const value = source[key]
    if (value !== undefined && value !== null) copy[key] = value
  }
  return copy as T
}

/**
 * Read the module options once into a plain object: every group has its unset keys dropped and its
 * known keys read by property access. `connection`, `queueOptions` and `telemetry` are kept by
 * reference, since they hold clients and functions that must not be copied.
 *
 * @param opts - The module options as the consumer gave them.
 * @returns A plain copy that validation and the defaults can both read without a second look.
 */
export function snapshotOptions(opts: BymaxQueueModuleOptions): BymaxQueueModuleOptions {
  const copy = setValuesOf(opts, TOP_LEVEL_KEYS) as unknown as Record<string, unknown>
  const groups: [string, readonly string[]][] = [
    ['defaultJobOptions', JOB_OPTION_KEYS],
    ['flows', FLOWS_KEYS],
    ['metrics', METRICS_KEYS],
    ['shutdown', SHUTDOWN_KEYS],
  ]
  for (const [name, known] of groups) {
    if (name in copy) copy[name] = setValuesOf(copy[name], known)
  }
  return copy as unknown as BymaxQueueModuleOptions
}
