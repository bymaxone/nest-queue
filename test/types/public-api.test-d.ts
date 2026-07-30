/**
 * @fileoverview Compile-time type tests for the public API of `@bymax-one/nest-queue`.
 * @layer test
 *
 * The published signatures are part of the product: a consumer typing a job
 * payload, narrowing a `JobStatus`, or switching on a `QueueErrorCode` depends on
 * these shapes being exactly what the documentation promises. These assertions
 * lock the generic flow through the producer API, the discriminated union behind
 * the Job Schedulers surface, and the identity of the constants re-exported from
 * both subpaths — so a refactor that silently widens or loosens a signature fails
 * `pnpm test:types` (`tsc`). There is no runtime here; everything is checked by
 * the compiler.
 */
import type { DynamicModule } from '@nestjs/common'
import type { Job } from 'bullmq'

// Everything is imported with `import type`: the assertions only ever appear in
// type position (`typeof X`), so nothing here emits a runtime import.
import type {
  BymaxQueueModule,
  BymaxQueueModuleOptions,
  BulkJob,
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_REDIS_CLIENT,
  BYMAX_QUEUE_CONNECTION_MODE,
  BYMAX_QUEUE_RESOLVED_OPTIONS,
  JobSchedulerRepeatOptions,
  JobStatus,
  JOB_STATUS,
  QueueErrorCode,
  QueueMetrics,
  QueueService,
  QUEUE_ERROR_CODES,
} from '@bymax-one/nest-queue'
import type {
  JobStatus as SharedJobStatus,
  QueueErrorCode as SharedQueueErrorCode,
  QUEUE_ERROR_CODES as SHARED_QUEUE_ERROR_CODES,
} from '@bymax-one/nest-queue/shared'

/** Exact (invariant) type equality — stricter than mutual assignability. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
/** Compiles only when the assertion holds; a false assertion is a type error. */
type Expect<T extends true> = T
/** One-way assignability — `A` is accepted wherever `B` is expected. */
type Extends<A, B> = A extends B ? true : false

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

// Both registration entry points resolve to a NestJS `DynamicModule` — consumers
// spread the result straight into an `imports` array.
export type _ForRoot = Expect<Equal<ReturnType<typeof BymaxQueueModule.forRoot>, DynamicModule>>
export type _ForRootAsync = Expect<
  Equal<ReturnType<typeof BymaxQueueModule.forRootAsync>, DynamicModule>
>
// `forRoot` takes the public options object directly — no resolved/internal shape
// leaks into the signature — and accepts the `isGlobal` extra on top of it.
type ForRootArg = Parameters<typeof BymaxQueueModule.forRoot>[0]
export type _ForRootAcceptsOptions = Expect<Extends<BymaxQueueModuleOptions, ForRootArg>>
export type _ForRootAcceptsIsGlobal = Expect<
  Extends<BymaxQueueModuleOptions & { isGlobal: true }, ForRootArg>
>

// Injection tokens are Symbols, not strings — a string token collides across
// libraries sharing a container.
export type _OptionsToken = Expect<Extends<typeof BYMAX_QUEUE_OPTIONS, symbol>>
export type _ClientToken = Expect<Extends<typeof BYMAX_QUEUE_REDIS_CLIENT, symbol>>
export type _ModeToken = Expect<Extends<typeof BYMAX_QUEUE_CONNECTION_MODE, symbol>>
export type _ResolvedToken = Expect<Extends<typeof BYMAX_QUEUE_RESOLVED_OPTIONS, symbol>>

// ---------------------------------------------------------------------------
// Producer API — the generics must reach the returned Job
// ---------------------------------------------------------------------------

interface WelcomePayload {
  userId: string
}
interface WelcomeResult {
  delivered: boolean
}

declare const queueService: QueueService
declare const bulk: readonly BulkJob<WelcomePayload>[]

// `enqueue<TData, TResult>` threads BOTH parameters into the resolved Job, so a
// consumer reads `job.data.userId` and `job.returnvalue.delivered` without a cast.
const _enqueued = queueService.enqueue<WelcomePayload, WelcomeResult>('welcome', 'send', {
  userId: 'u1',
})
export type _Enqueue = Expect<Equal<typeof _enqueued, Promise<Job<WelcomePayload, WelcomeResult>>>>

// `getJob` resolves to `null` — never `undefined` — for a missing job, so the
// documented `=== null` narrowing holds.
const _fetched = queueService.getJob<WelcomePayload, WelcomeResult>('welcome', '42')
export type _GetJob = Expect<
  Equal<typeof _fetched, Promise<Job<WelcomePayload, WelcomeResult> | null>>
>

// The status filter is the six-member union, not a bare `string`: a typo is a
// compile error rather than a query that silently returns nothing.
export type _GetJobsStatusArg = Expect<Equal<Parameters<QueueService['getJobs']>[1], JobStatus>>

// Bulk input is a readonly array — the service cannot mutate a caller's batch —
// and the generics reach the created jobs just like the single-job path.
const _bulkEnqueued = queueService.enqueueBulk<WelcomePayload, WelcomeResult>('welcome', bulk)
export type _EnqueueBulk = Expect<
  Equal<typeof _bulkEnqueued, Promise<Job<WelcomePayload, WelcomeResult>[]>>
>

// `BulkJob.options` is optional; `name` and `data` are not.
export type _BulkJobShape = Expect<
  Equal<keyof BulkJob<WelcomePayload>, 'name' | 'data' | 'options'>
>

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

// Every status is a required key of the counts record — a partial snapshot would
// force consumers into `?? 0` at every read site.
export type _MetricsCounts = Expect<Equal<QueueMetrics['counts'], Record<JobStatus, number>>>
export type _MetricsCollectedAt = Expect<Equal<QueueMetrics['collectedAt'], string>>

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

// The union and the constant object stay in sync in BOTH directions: adding a
// member to one without the other breaks here.
export type _JobStatusUnion = Expect<
  Equal<JobStatus, 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'>
>
export type _JobStatusConstCoversUnion = Expect<
  Equal<(typeof JOB_STATUS)[keyof typeof JOB_STATUS], JobStatus>
>

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

// The code union is derived from the catalog, so a new entry widens the union
// automatically and an exhaustive `switch` in consumer code stops compiling.
export type _ErrorCodeUnion = Expect<
  Equal<QueueErrorCode, (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES]>
>

// The server barrel re-exports the shared catalog rather than declaring a second
// copy — two catalogs would drift and consumers comparing across subpaths would
// silently never match.
export type _SharedErrorCodesIdentity = Expect<
  Equal<typeof QUEUE_ERROR_CODES, typeof SHARED_QUEUE_ERROR_CODES>
>
export type _SharedErrorCodeType = Expect<Equal<QueueErrorCode, SharedQueueErrorCode>>
export type _SharedJobStatusType = Expect<Equal<JobStatus, SharedJobStatus>>

// ---------------------------------------------------------------------------
// Job Schedulers — the recurring-jobs union consumers construct
// ---------------------------------------------------------------------------

// Both arms are constructible, each with only its own optional fields.
export type _CronArm = Expect<
  Extends<{ pattern: '0 3 * * *'; tz: 'America/Sao_Paulo'; limit: 10 }, JobSchedulerRepeatOptions>
>
export type _IntervalArm = Expect<
  Extends<{ every: 60_000; offset: 500; limit: 10 }, JobSchedulerRepeatOptions>
>
// The cron and interval arms together account for the WHOLE union — a third arm
// would be a recurrence mode `validateJobSchedulerOptions` does not know how to
// check, and it would reach BullMQ unvalidated.
export type _UnionIsExactlyTwoArms = Expect<
  Equal<
    | Extract<JobSchedulerRepeatOptions, { pattern: string }>
    | Extract<JobSchedulerRepeatOptions, { every: number }>,
    JobSchedulerRepeatOptions
  >
>

// `pattern` is a plain string: cron validation is BullMQ's `cron-parser` at
// runtime, never a template-literal type that would reject valid 6-field patterns.
export type _CronPatternIsString = Expect<
  Equal<Extract<JobSchedulerRepeatOptions, { pattern: string }>['pattern'], string>
>
// The interval arm is milliseconds — a number, never a duration string.
export type _IntervalIsNumber = Expect<
  Equal<Extract<JobSchedulerRepeatOptions, { every: number }>['every'], number>
>
