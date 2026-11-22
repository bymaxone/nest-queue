/**
 * @fileoverview Base queue service — per-name Queue cache, typed enqueue/inspect,
 * uncached metrics, and control helpers over BullMQ.
 * @layer server/services
 */

import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  defaultRepeatStrategy,
  type Job,
  type JobsOptions,
  Queue,
  type QueueOptions,
  type RepeatOptions,
} from 'bullmq'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { BulkJob } from '../interfaces/queue-job-data.interface'
import type { JobStatus } from '../../shared/types/job-status.types'
import type { QueueMetrics } from '../../shared/types/queue-metrics.types'
import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { validateJobSchedulerOptions } from '../utils/validate-job-scheduler-options'
import { attachDefaultErrorListener } from '../utils/attach-error-listener'
import { MAX_BULK_SIZE } from '../constants/default-options'
import { assertPageWindow } from '../utils/assert-page-window'
import { assertPrototypeClean } from '../connection/prototype-guard'
import { assertJobInputs } from '../utils/assert-job-inputs'
import { readBulkJobs } from '../utils/read-bulk-jobs'
import { guarded, invalidRepeat } from '../config/guarded-read'
import { readKeysOf, snapshotJobOptions } from '../config/snapshot-options'
import { isReservedJobId } from '../utils/reserved-job-ids'
import { withDeadline } from '../utils/with-deadline'
import { QueueObserverRegistry, type TraceCarrier } from '../observability/queue-observer'
import { withTraceMetadata } from '../observability/trace-carrier'
import { errorSummary, timeoutException, withCommandTimeoutCode } from '../utils/command-timeout'

/** A typed job in the library's public shape. */
type TypedJob<TData, TResult> = Job<TData, TResult>

/** Status filter accepted by {@link QueueService.cleanQueue}, matching BullMQ. */
type CleanableStatus = 'completed' | 'failed' | 'delayed' | 'wait' | 'active' | 'paused'

/**
 * Refuse a cron pattern BullMQ's parser cannot read, before Redis is asked.
 *
 * The parser throws a bare `Error` with no type and no `code`, and so does every Redis server
 * reply error (`READONLY`, `OOM`, `NOAUTH`, a script error), so the two cannot be told apart
 * after the write is attempted. The check therefore runs BullMQ's own repeat strategy, the
 * pure function `upsertJobScheduler` calls for a pattern, where any throw can only be the
 * pattern; the write that follows reports every failure as it is. A consumer-supplied repeat
 * strategy replaces the parser, so the pattern is theirs to define and is not checked here.
 *
 * @param repeat - The pattern schedule being upserted.
 * @param queueOptions - The queue options the module resolved.
 * @throws {QueueException} `INVALID_REPEAT_OPTIONS` (400) when the pattern does not parse.
 */
function assertValidCron(
  repeat: JobSchedulerRepeatOptions,
  queueOptions: ResolvedQueueOptions['queueOptions'],
): void {
  if (queueOptions.settings?.repeatStrategy !== undefined) return
  try {
    defaultRepeatStrategy(Date.now(), repeat)
  } catch {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, HttpStatus.BAD_REQUEST, {
      reason: 'pattern must be a valid cron expression (5- or 6-field)',
    })
  }
}

/**
 * Every option BullMQ's `RepeatOptions` has, held to that type by the compiler. Each is read by name,
 * once, so a schedule the host built as a class with getters is sent as it was checked.
 */
const REPEAT_OPTION_TABLE = {
  endDate: true,
  startDate: true,
  pattern: true,
  key: true,
  limit: true,
  every: true,
  immediately: true,
  count: true,
  offset: true,
  prevMillis: true,
  jobId: true,
  tz: true,
} as const satisfies Record<keyof RepeatOptions, true>
const REPEAT_OPTION_KEYS: readonly string[] = Object.keys(REPEAT_OPTION_TABLE)

/**
 * The central interaction point with BullMQ queues. Maintains a per-name `Queue`
 * cache, applies module defaults to every queue, and exposes typed helpers for
 * enqueueing, inspection, metrics, and lifecycle control.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name)
  readonly #queues = new Map<string, Queue>()
  /** Queues whose first call has already got past the client's ready-wait. */
  readonly #warm = new Set<string>()

  constructor(
    @Inject(ConnectionResolver) private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly options: ResolvedQueueOptions,
    @Optional()
    @Inject(QueueObserverRegistry)
    private readonly observers?: QueueObserverRegistry,
  ) {}

  /**
   * Run an enqueue inside the observers' spans. The trace headers they write are stored with the job
   * by `stamp`, unless BullMQ's own telemetry is configured, which stores its own.
   */
  private observed<T>(
    queueName: string,
    jobName: string | undefined,
    run: (carrier: TraceCarrier) => Promise<T>,
  ): Promise<T> {
    if (this.observers === undefined) return run({})
    const info = jobName === undefined ? { queue: queueName } : { queue: queueName, job: jobName }
    return this.observers.traceEnqueue(info, run)
  }

  /** The options to send BullMQ: the checked ones, with the trace headers when they are to be stored. */
  private stamp(options: JobsOptions | undefined, carrier: TraceCarrier): JobsOptions | undefined {
    return this.options.telemetry === undefined ? withTraceMetadata(options, carrier) : options
  }

  /**
   * Return the cached `Queue` for `queueName`, or create one with the module
   * defaults applied. Subsequent calls with the same name return the same
   * instance.
   *
   * @param queueName - Unique queue name (used as the Redis key prefix).
   * @param overrides - Optional per-queue option overrides.
   */
  getOrCreateQueue<TData = unknown, TResult = unknown>(
    queueName: string,
    overrides?: Partial<Omit<QueueOptions, 'connection' | 'prefix'>>,
  ): Queue<TData, TResult> {
    const existing = this.#queues.get(queueName)
    // The cache is keyed by name and holds default-generic Queues; the caller
    // declares the payload generics, which BullMQ's invariant generics cannot
    // narrow structurally. The cast re-projects the runtime Queue onto the
    // requested generics (data shape is unchanged at runtime).
    if (existing) return existing as unknown as Queue<TData, TResult>

    const queue = new Queue(queueName, {
      connection: this.connection.getClient(),
      prefix: this.options.prefix,
      defaultJobOptions: this.options.defaultJobOptions,
      ...this.options.queueOptions,
      ...(this.options.telemetry ? { telemetry: this.options.telemetry } : {}),
      ...overrides,
    })
    attachDefaultErrorListener(queue, this.logger, 'Queue', queueName)
    this.#queues.set(queueName, queue)
    return queue as unknown as Queue<TData, TResult>
  }

  /**
   * Run one Redis call under the per-call deadline (`enqueueTimeoutMs`), reporting every way Redis
   * can fail to answer as the documented `CONNECTION_TIMEOUT`: the deadline passing, an ioredis
   * command timeout, or a call refused because the connection is down.
   *
   * The first call on a queue name waits for the client to be ready through ONE wait shared by all
   * callers, instead of letting BullMQ start its own unbounded wait per call, so a caller that
   * polls through an outage does not pile up listeners. The call runs only if it is still within
   * its deadline when the client is ready; a caller that was told it timed out never has its call
   * run later, which would turn its retry into a duplicate.
   */
  private call<T>(operation: string, queueName: string, run: () => Promise<T>): Promise<T> {
    let expired = false
    const guarded = withDeadline(
      this.afterReady(queueName).then(() => {
        // Stryker disable next-line StringLiteral: equivalent — the deadline already rejected the caller, so this error is absorbed and never read
        if (expired) throw new Error('the call had already timed out')
        return run()
      }),
      this.options.enqueueTimeoutMs,
      () => {
        expired = true
        return timeoutException(operation, this.options.enqueueTimeoutMs)
      },
    )
    return withCommandTimeoutCode(
      operation,
      () => this.connection.getClient().options.commandTimeout ?? this.options.commandTimeoutMs,
      guarded,
    )
  }

  /** Settle when a call on `queueName` may start: at once for a queue that has been used before. */
  private async afterReady(queueName: string): Promise<void> {
    if (this.#warm.has(queueName)) return
    await this.connection.awaitReady()
    this.#warm.add(queueName)
  }

  /** Resolve the raw cached queue (default generics) for internal delegation. */
  private queueFor(queueName: string): Queue {
    return this.getOrCreateQueue(queueName)
  }

  /**
   * Add a single job to a queue. The queue is created lazily if needed.
   *
   * Delivery is **at-least-once** — a handler may run more than once for the same
   * job (worker crash, lock expiry, or a shutdown that outlasts the drain budget). Make handlers
   * idempotent: use an idempotency key on writes, prefer upserts over inserts, or
   * keep an "already-processed" marker keyed by `job.id`.
   *
   * `options` surfaces BullMQ natives directly — including `jobId` (idempotent
   * insert: a second add with the same id is a no-op while the first exists) and
   * `deduplication` (windowed deduplication). The library writes no deduplication
   * code; BullMQ owns the behavior. The deduplication key is independent of
   * `jobId`, so both can be set together or apart. Both collapse duplicate
   * **producers** and do not change the at-least-once guarantee on the
   * **consumer** side.
   *
   * The deduplication `id` is a shared key across the queue, so a multi-tenant
   * producer MUST scope it by tenant: keyed on the value alone
   * (`` `reindex:${term}` ``), tenant A enqueuing a term suppresses tenant B's job
   * for the same term.
   *
   * Scoping alone is not enough. Two variable fields joined by a delimiter that
   * either may contain do not produce a unique key: with `` `${tenantId}:${term}` ``,
   * the pairs `('a', 'b:c')` and `('a:b', 'c')` both yield `a:b:c`. Percent-encode
   * every variable field so the delimiter cannot appear inside one:
   * `` `${encodeURIComponent(tenantId)}:${encodeURIComponent(term)}` ``.
   *
   * Deduplication modes (`deduplication: { id, ttl?, extend?, replace?, keepLastIfActive? }`):
   *  - Simple `{ id }` — collapse duplicates until the in-flight job completes or fails.
   *  - Throttle `{ id, ttl }` — ignore duplicates for `ttl` milliseconds.
   *  - Debounce `{ id, ttl, extend: true, replace: true }` — keep only the latest
   *    data; each duplicate resets the TTL.
   *  - keep-last-if-active `{ id, keepLastIfActive: true }` — while a job is active,
   *    store the latest data and run a single follow-up when it finishes.
   *
   * @param queueName - Target queue (created lazily if absent).
   * @param jobName - Job identifier used by `@Process` to dispatch.
   * @param data - Typed job payload.
   * @param options - Per-job BullMQ options (priority, delay, `jobId`, `deduplication`, ...).
   * @returns The job BullMQ returned. When a custom `jobId` already exists, or a `deduplication`
   *   rule keeps the job already there (one with `replace` swaps it for the new job), nothing new
   *   is added: BullMQ answers with the id of the EXISTING job and the data and options of THIS
   *   call, so the returned object does not describe what is stored. Call
   *   {@link QueueService.getJob} when you need the stored job.
   * @example Throttle: at most one reindex per term every 5 seconds. Both variable
   *   fields are percent-encoded, so no other tenant/term pair can build this key.
   *   const dedupId = `${encodeURIComponent(tenantId)}:reindex:${encodeURIComponent(term)}`
   *   await queueService.enqueue('search', 'reindex', { term }, {
   *     deduplication: { id: dedupId, ttl: 5_000 },
   *   })
   */
  async enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    jobName: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<TypedJob<TData, TResult>> {
    assertPrototypeClean()
    const checked = assertJobInputs(options, 'options')
    const job = await this.observed(queueName, jobName, (carrier) =>
      this.call('enqueue', queueName, () =>
        this.queueFor(queueName).add(jobName, data, this.stamp(checked, carrier)),
      ),
    )
    return job
  }

  /**
   * Enqueue multiple jobs in a single Redis roundtrip. The batch is bounded by
   * {@link MAX_BULK_SIZE} to guard against a self-inflicted memory spike; any
   * failure is wrapped in a `QueueException`. Delivery is at-least-once, so every
   * job's handler must be idempotent (see {@link QueueService.enqueue}).
   *
   * @param queueName - Target queue.
   * @param jobs - Job descriptors (length must not exceed the bulk size cap).
   * @returns The jobs BullMQ returned, in input order. An entry whose custom `jobId` already
   *   exists is not added again: it carries the EXISTING id with the data of this call, as for
   *   {@link QueueService.enqueue}.
   */
  async enqueueBulk<TData = unknown, TResult = unknown>(
    queueName: string,
    jobs: readonly BulkJob<TData>[],
  ): Promise<TypedJob<TData, TResult>[]> {
    assertPrototypeClean()
    const copied = readBulkJobs(jobs, MAX_BULK_SIZE)
    const checked = copied.map((job, index) =>
      assertJobInputs(job.options, `jobs[${String(index)}].options`),
    )
    try {
      const created = await this.observed(queueName, undefined, (carrier) =>
        this.call('enqueueBulk', queueName, () =>
          this.queueFor(queueName).addBulk(
            copied.map((job, index) => {
              const opts = this.stamp(checked[index], carrier)
              return { name: job.name, data: job.data, ...(opts === undefined ? {} : { opts }) }
            }),
          ),
        ),
      )
      return created
    } catch (err) {
      // A timeout and a full Redis already carry their own code and status; only the rest is wrapped.
      if (err instanceof QueueException && PASSED_THROUGH.has(errorCodeOf(err))) {
        throw err
      }
      // The text of the failure can name the host or the server: it is the cause, never the response.
      throw Object.assign(
        new QueueException(
          QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED,
          HttpStatus.INTERNAL_SERVER_ERROR,
          {
            operation: 'enqueueBulk',
          },
        ),
        { cause: errorSummary(err) },
      )
    }
  }

  /**
   * Fetch a job by id. Returns `null` when the job does not exist.
   *
   * @param queueName - Target queue.
   * @param jobId - The job identifier.
   */
  async getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<TypedJob<TData, TResult> | null> {
    // A reserved id can never be a job, so there is nothing to read; the key under it is not a job hash.
    if (isReservedJobId(jobId)) return null
    const job = await this.call('getJob', queueName, () => this.queueFor(queueName).getJob(jobId))
    return (job as TypedJob<TData, TResult> | undefined) ?? null
  }

  /**
   * Fetch jobs in a given status with pagination.
   *
   * @param queueName - Target queue.
   * @param status - Status filter.
   * @param start - Starting index (inclusive). Default: 0.
   * @param end - Ending index (inclusive). Default: 50. The window may span at most
   *   `MAX_JOBS_PAGE_SIZE` (1000) jobs, and BullMQ's `-1` (everything) is refused.
   * @throws {QueueException} `INVALID_OPTIONS` when the window is not a bounded range of integers.
   */
  async getJobs<TData = unknown, TResult = unknown>(
    queueName: string,
    status: JobStatus,
    start = 0,
    end = 50,
  ): Promise<TypedJob<TData, TResult>[]> {
    assertPageWindow('getJobs', 'jobs', start, end)
    const jobs = await this.call('getJobs', queueName, () =>
      this.queueFor(queueName).getJobs([status], start, end),
    )
    return jobs
  }

  /**
   * Return an uncached snapshot of job counts grouped by status.
   *
   * @param queueName - Target queue.
   */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    const counts = await this.call('getMetrics', queueName, () =>
      this.queueFor(queueName).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    )
    return {
      queue: queueName,
      counts: counts as QueueMetrics['counts'],
      collectedAt: new Date().toISOString(),
    }
  }

  /**
   * Create or update a Job Scheduler — the current BullMQ recurring-jobs API.
   * Idempotent by `schedulerId`: BullMQ performs an atomic `override: true`
   * upsert, so re-registering on every boot updates the schedule in place and
   * never duplicates it. This supersedes the repeatable-jobs surface removed in
   * BullMQ v6.
   *
   * The schedule is validated first, and a cron pattern BullMQ's parser rejects
   * is `INVALID_REPEAT_OPTIONS` (400) before Redis is asked; any other failure
   * propagates as it is.
   *
   * @param queueName - Target queue.
   * @param schedulerId - Stable, unique scheduler identifier (the upsert key).
   * @param repeat - Cron `pattern` OR `every` (ms), plus optional tz/limit/start/end.
   * @param template - Optional job template; `name` defaults to `schedulerId`, `data` to `{}`.
   * @returns The first scheduled (delayed) job, or `undefined`.
   * @throws {QueueException} `INVALID_REPEAT_OPTIONS` (400) for an invalid schedule.
   */
  async upsertJobScheduler<TData = unknown, TResult = unknown>(
    queueName: string,
    schedulerId: string,
    repeat: JobSchedulerRepeatOptions,
    template?: { name?: string; data?: TData; opts?: JobsOptions },
  ): Promise<Job<TData, TResult> | undefined> {
    assertPrototypeClean()
    // The schedule and the template are the host's: each is read once, here, and what is checked is what
    // BullMQ is sent, even from a getter that answers differently the second time.
    const given = guarded(
      'the schedule',
      () => ({
        repeat: readKeysOf(repeat, REPEAT_OPTION_KEYS),
        template: readKeysOf(template, ['name', 'data', 'opts']),
      }),
      invalidRepeat,
    )
    repeat = given.repeat
    template = given.template
    validateJobSchedulerOptions(repeat)
    // The cache holds default-generic queues; the caller declares the payload
    // generics, which BullMQ's invariant `ExtractDataType` cannot narrow. The
    // returned job is re-projected onto the requested generics (unchanged at runtime).
    const queue = this.queueFor(queueName)
    const templateOptions = snapshotJobOptions(template?.opts)
    const jobTemplate = {
      name: template?.name ?? schedulerId,
      data: template?.data ?? {},
      ...(templateOptions === undefined ? {} : { opts: templateOptions }),
    }
    if ('pattern' in repeat) assertValidCron(repeat, this.options.queueOptions)
    const job = await this.call('upsertJobScheduler', queueName, () =>
      queue.upsertJobScheduler(schedulerId, repeat, jobTemplate),
    )
    return job as Job<TData, TResult>
  }

  /**
   * Remove a Job Scheduler by id.
   *
   * @param queueName - Target queue.
   * @param schedulerId - The scheduler identifier to remove.
   * @returns `true` when a scheduler was removed, `false` otherwise.
   */
  async removeJobScheduler(queueName: string, schedulerId: string): Promise<boolean> {
    return this.call('removeJobScheduler', queueName, () =>
      this.queueFor(queueName).removeJobScheduler(schedulerId),
    )
  }

  /**
   * List the Job Schedulers registered on a queue, for inspection or health checks.
   *
   * @param queueName - Target queue.
   * @param start - Page start index (inclusive). Default: 0.
   * @param end - Page end index (inclusive). Default: 50. The window may span at most
   *   `MAX_JOBS_PAGE_SIZE` (1000) entries, and BullMQ's `-1` (everything) is refused.
   * @param asc - Sort ascending by next run time. Default: true.
   * @returns The registered schedulers in the requested page.
   * @throws {QueueException} `INVALID_OPTIONS` when the window is not a bounded range of integers.
   */
  async getJobSchedulers(
    queueName: string,
    start = 0,
    end = 50,
    asc = true,
  ): Promise<Awaited<ReturnType<Queue['getJobSchedulers']>>> {
    assertPageWindow('getJobSchedulers', 'schedulers', start, end)
    return this.call('getJobSchedulers', queueName, () =>
      this.queueFor(queueName).getJobSchedulers(start, end, asc),
    )
  }

  /** Pause a queue, halting the processing of new jobs. */
  async pauseQueue(queueName: string): Promise<void> {
    await this.call('pauseQueue', queueName, () => this.queueFor(queueName).pause())
  }

  /** Resume a previously paused queue. */
  async resumeQueue(queueName: string): Promise<void> {
    await this.call('resumeQueue', queueName, () => this.queueFor(queueName).resume())
  }

  /**
   * Remove up to `limit` jobs older than `gracePeriodMs` in a given status. The
   * argument order mirrors BullMQ's `Queue.clean(grace, limit, type?)` exactly;
   * `limit` is required and `0` means no limit. Returns the removed job ids.
   *
   * @param queueName - Target queue.
   * @param gracePeriodMs - Keep jobs younger than this many milliseconds.
   * @param limit - Maximum number of jobs to remove (`0` = no limit).
   * @param status - Status of jobs to clean.
   */
  async cleanQueue(
    queueName: string,
    gracePeriodMs: number,
    limit: number,
    status?: CleanableStatus,
  ): Promise<string[]> {
    return this.call('cleanQueue', queueName, () =>
      this.queueFor(queueName).clean(gracePeriodMs, limit, status),
    )
  }

  /** Return a read-only view of the cached queues. */
  getCachedQueues(): ReadonlyMap<string, Queue> {
    return this.#queues
  }

  /**
   * Close every cached queue (swallowing per-queue errors) and clear the cache.
   *
   * Deliberately NOT named `onModuleDestroy`: NestJS invokes lifecycle hooks by
   * method name, so a hook here would run on Nest's own schedule, concurrently
   * with — and possibly before — the bounded drain in `QueueLifecycle`. Closing a
   * queue while its worker is still draining is exactly what the ordered sequence
   * exists to prevent. `QueueLifecycle` is the only caller.
   */
  async closeAll(): Promise<void> {
    for (const queue of this.#queues.values()) {
      await queue.close().catch(() => undefined)
    }
    this.#queues.clear()
    this.#warm.clear()
  }
}

/** The codes `enqueueBulk` reports as they are instead of wrapping them in `BULK_ENQUEUE_FAILED`. */
const PASSED_THROUGH: ReadonlySet<string> = new Set([
  QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
  QUEUE_ERROR_CODES.STORAGE_FULL,
])

/** The stable code a `QueueException` carries in its response envelope. */
function errorCodeOf(err: QueueException): string {
  return (err.getResponse() as { error: { code: string } }).error.code
}
