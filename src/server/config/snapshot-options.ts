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
import { guarded } from './guarded-read'
import { copyFields, readByName } from './read-by-name'

/**
 * Every option BullMQ's `JobsOptions` has, and the compiler holds the table to that type: a key it
 * adds fails the build here, and a key removed does too. Each is read by name, so one the host
 * defined as a getter on a class, or as a hidden field, reaches BullMQ instead of being dropped by a
 * copy of the enumerable keys, which would lose a `deduplication` or a `lifo` without a word.
 */
const JOB_OPTION_TABLE = {
  timestamp: true,
  priority: true,
  delay: true,
  attempts: true,
  backoff: true,
  lifo: true,
  removeOnComplete: true,
  removeOnFail: true,
  keepLogs: true,
  stackTraceLimit: true,
  sizeLimit: true,
  repeatJobKey: true,
  jobId: true,
  parent: true,
  prevMillis: true,
  deduplication: true,
  failParentOnFailure: true,
  continueParentOnFailure: true,
  ignoreDependencyOnFailure: true,
  removeDependencyOnFailure: true,
  telemetry: true,
} as const satisfies Record<keyof JobsOptions, true>

/** The job options, each read by name even when it is inherited or hidden. */
const JOB_OPTION_KEYS: readonly string[] = Object.keys(JOB_OPTION_TABLE)

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
/** The options that switch a behaviour on or off, which must be a boolean or absent, never `null`. */
const TOP_LEVEL_FLAGS = ['isGlobal'] as const
const FLOWS_FLAGS = ['enabled'] as const
const METRICS_FLAGS = ['enabled'] as const
const SHUTDOWN_FLAGS = ['drainOnShutdown'] as const
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
 * An empty copy with no prototype, so a read of a key the copy does not hold answers `undefined` and
 * never what was planted on the root prototype, which a plain object would hand back.
 */
function emptyCopy(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

/** Put `value` at `key` as an own data property, which `__proto__` too becomes, not a prototype. */
function defineValue(copy: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Copy the set values of a group: every own enumerable key and every `known` key, each read once by
 * property access. A value that is not an object is returned as it is, for validation to judge. A
 * `null` is "not given" except under a `flags` key, where it is kept for validation to refuse: a
 * flag from an unset environment variable must not read as the default.
 */
function setValuesOf<T>(
  group: T,
  known: readonly string[],
  flags: readonly string[] = [],
  path = 'the module options',
): T {
  if (typeof group !== 'object') return group
  const source = group as unknown as Record<string, unknown>
  const copy = emptyCopy()
  for (const key of new Set(guarded(path, () => [...Object.keys(source), ...known]))) {
    const value = guarded(`${path}.${key}`, () => readByName(source, key))
    if (value === undefined || (value === null && !flags.includes(key))) continue
    defineValue(copy, key, value)
  }
  return copy as T
}

/**
 * Copy the keys of a group as the caller gave them: every own enumerable key with its value, `undefined`
 * and `null` included, and every `known` key that is not own and holds a value, so an inherited getter
 * counts. Each is read once. A value that is not an object, and an array, is returned as it is, for
 * validation to judge.
 *
 * @param group - A group of options, such as the options of one job.
 * @param known - The keys to read by property access even when the group does not hold them as its own.
 * @returns A plain copy the caller can validate and send on without a second read.
 */
export function readKeys<T>(group: T, known: readonly string[]): T {
  return guarded('the job options', () => readKeysOf(group, known))
}

/**
 * The read of {@link readKeys} with no guard of its own, for a caller that refuses with a code of
 * its own: a throw of the host's getter reaches that caller as it is.
 *
 * @param group - A group of options.
 * @param known - The keys to read by property access even when the group does not hold them as its own.
 * @returns A plain copy.
 */
export function readKeysOf<T>(group: T, known: readonly string[]): T {
  if (typeof group !== 'object' || group === null || Array.isArray(group)) return group
  const source = group as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) defineValue(copy, key, source[key])
  for (const key of known) {
    if (Object.hasOwn(copy, key)) continue
    const value = readByName(source, key)
    if (value !== undefined) defineValue(copy, key, value)
  }
  return copy as T
}

/** The keys of the objects a job's options may hold. */
const NESTED_JOB_OPTION_KEYS: readonly (readonly [string, readonly string[]])[] = [
  ['backoff', ['type', 'delay', 'jitter']],
  ['removeOnComplete', ['age', 'count']],
  ['removeOnFail', ['age', 'count']],
  ['parent', ['id', 'queue']],
]

/** The objects a group of job options holds, each read once, in a copy that keeps the rest as it is. */
function readNestedJobOptions(group: unknown): unknown {
  if (typeof group !== 'object' || group === null) return group
  const copy = group as Record<string, unknown>
  for (const [name, known] of NESTED_JOB_OPTION_KEYS) {
    if (name in copy) copy[name] = readKeys(copy[name], known)
  }
  return copy
}

/**
 * The connection once: the `client` by reference, since it is an object nothing may copy, the `url`
 * as the string read, and the `options` with each field read once, so the resolver that connects
 * later reads the copy and never the host's object again.
 */
function snapshotConnection(connection: unknown): unknown {
  if (typeof connection !== 'object' || connection === null) return connection
  return guarded('connection', () => {
    const copy = emptyCopy()
    for (const key of ['client', 'url', 'options']) {
      if (!Reflect.has(connection, key)) continue
      const value = readByName(connection, key)
      defineValue(copy, key, key === 'options' ? copyFields(value) : value)
    }
    return copy
  })
}

/**
 * Read the options of one job once, with the objects they hold, so what is validated is what BullMQ is
 * handed even when a value is a getter that answers differently the second time.
 *
 * @param options - The options of one job, as the caller gave them.
 * @returns A plain copy, or `options` itself when it is not an object.
 */
export function snapshotJobOptions<T extends JobsOptions | undefined>(options: T): T {
  const copy = readKeys<Record<string, unknown> | null | undefined>(
    options as never,
    JOB_OPTION_KEYS,
  )
  if (typeof copy !== 'object' || copy === null) return copy as T
  for (const [name, known] of NESTED_JOB_OPTION_KEYS) {
    if (name in copy) copy[name] = readKeys(copy[name], known)
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
  const copy = setValuesOf(opts, TOP_LEVEL_KEYS, TOP_LEVEL_FLAGS) as unknown as Record<
    string,
    unknown
  >
  const groups: [string, readonly string[], readonly string[]][] = [
    ['defaultJobOptions', JOB_OPTION_KEYS, []],
    ['flows', FLOWS_KEYS, FLOWS_FLAGS],
    ['metrics', METRICS_KEYS, METRICS_FLAGS],
    ['shutdown', SHUTDOWN_KEYS, SHUTDOWN_FLAGS],
  ]
  for (const [name, known, flags] of groups) {
    if (name in copy) copy[name] = setValuesOf(copy[name], known, flags, name)
  }
  if ('connection' in copy) copy.connection = snapshotConnection(copy.connection)
  if ('queueOptions' in copy) {
    copy.queueOptions = guarded('queueOptions', () => copyFields(copy.queueOptions))
  }
  if ('defaultJobOptions' in copy)
    copy.defaultJobOptions = readNestedJobOptions(copy.defaultJobOptions)
  return copy as unknown as BymaxQueueModuleOptions
}
