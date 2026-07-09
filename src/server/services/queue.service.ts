/**
 * @fileoverview Base queue service — per-name Queue cache, typed enqueue/inspect,
 * uncached metrics, and control helpers over BullMQ.
 * @layer server/services
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { type Job, type JobsOptions, Queue, type QueueOptions } from 'bullmq'
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

/** Maximum number of jobs accepted by a single `enqueueBulk` call. */
const MAX_BULK_SIZE = 1000

/** A typed job in the library's public shape. */
type TypedJob<TData, TResult> = Job<TData, TResult>

/** Status filter accepted by {@link QueueService.cleanQueue}, matching BullMQ. */
type CleanableStatus = 'completed' | 'failed' | 'delayed' | 'wait' | 'active' | 'paused'

/**
 * The central interaction point with BullMQ queues. Maintains a per-name `Queue`
 * cache, applies module defaults to every queue, and exposes typed helpers for
 * enqueueing, inspection, metrics, and lifecycle control.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>()

  constructor(
    @Inject(ConnectionResolver) private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly options: ResolvedQueueOptions,
  ) {}

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
    const existing = this.queues.get(queueName)
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
    this.queues.set(queueName, queue)
    return queue as unknown as Queue<TData, TResult>
  }

  /** Resolve the raw cached queue (default generics) for internal delegation. */
  private queueFor(queueName: string): Queue {
    return this.getOrCreateQueue(queueName)
  }

  /**
   * Add a single job to a queue. The queue is created lazily if needed.
   *
   * Delivery is **at-least-once** — a handler may run more than once for the same
   * job (worker crash, lock expiry, or a shutdown force-close). Make handlers
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
   * @returns The created job.
   * @example Throttle: at most one reindex per term every 5 seconds.
   *   await queueService.enqueue('search', 'reindex', { term }, {
   *     deduplication: { id: `reindex:${term}`, ttl: 5_000 },
   *   })
   */
  async enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    jobName: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<TypedJob<TData, TResult>> {
    const job = await this.queueFor(queueName).add(jobName, data, options)
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
   */
  async enqueueBulk<TData = unknown, TResult = unknown>(
    queueName: string,
    jobs: readonly BulkJob<TData>[],
  ): Promise<TypedJob<TData, TResult>[]> {
    if (jobs.length > MAX_BULK_SIZE) {
      throw new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, 500, {
        reason: 'batch size exceeds limit',
        limit: MAX_BULK_SIZE,
        received: jobs.length,
      })
    }
    try {
      const created = await this.queueFor(queueName).addBulk(
        jobs.map((job) => ({
          name: job.name,
          data: job.data,
          ...(job.options === undefined ? {} : { opts: job.options }),
        })),
      )
      return created
    } catch (err) {
      throw new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, 500, {
        cause: (err as Error).message,
      })
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
    const job = await this.queueFor(queueName).getJob(jobId)
    return (job as TypedJob<TData, TResult> | undefined) ?? null
  }

  /**
   * Fetch jobs in a given status with pagination.
   *
   * @param queueName - Target queue.
   * @param status - Status filter.
   * @param start - Starting index (inclusive). Default: 0.
   * @param end - Ending index (inclusive). Default: 50.
   */
  async getJobs<TData = unknown, TResult = unknown>(
    queueName: string,
    status: JobStatus,
    start = 0,
    end = 50,
  ): Promise<TypedJob<TData, TResult>[]> {
    const jobs = await this.queueFor(queueName).getJobs([status], start, end)
    return jobs
  }

  /**
   * Return an uncached snapshot of job counts grouped by status.
   *
   * @param queueName - Target queue.
   */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    const counts = await this.queueFor(queueName).getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
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
   * The schedule is structurally validated first; the cron string itself is
   * parsed by BullMQ at registration time, and a parse failure is rethrown as
   * `INVALID_REPEAT_OPTIONS` (400).
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
    validateJobSchedulerOptions(repeat)
    // The cache holds default-generic queues; the caller declares the payload
    // generics, which BullMQ's invariant `ExtractDataType` cannot narrow. The
    // returned job is re-projected onto the requested generics (unchanged at runtime).
    const queue = this.queueFor(queueName)
    const jobTemplate = {
      name: template?.name ?? schedulerId,
      data: template?.data ?? {},
      ...(template?.opts === undefined ? {} : { opts: template.opts }),
    }
    if ('pattern' in repeat) {
      try {
        const job = await queue.upsertJobScheduler(schedulerId, repeat, jobTemplate)
        return job as Job<TData, TResult>
      } catch {
        // BullMQ delegates cron parsing to its bundled parser; an unparseable
        // pattern surfaces here as a thrown error.
        throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, 400, {
          reason: 'pattern must be a valid cron expression (5- or 6-field)',
        })
      }
    }
    const job = await queue.upsertJobScheduler(schedulerId, repeat, jobTemplate)
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
    return this.queueFor(queueName).removeJobScheduler(schedulerId)
  }

  /**
   * List the Job Schedulers registered on a queue, for inspection or health checks.
   *
   * @param queueName - Target queue.
   * @param start - Page start index (inclusive). Default: 0.
   * @param end - Page end index (inclusive). Default: 50.
   * @param asc - Sort ascending by next run time. Default: true.
   * @returns The registered schedulers in the requested page.
   */
  async getJobSchedulers(
    queueName: string,
    start = 0,
    end = 50,
    asc = true,
  ): Promise<Awaited<ReturnType<Queue['getJobSchedulers']>>> {
    return this.queueFor(queueName).getJobSchedulers(start, end, asc)
  }

  /** Pause a queue, halting the processing of new jobs. */
  async pauseQueue(queueName: string): Promise<void> {
    await this.queueFor(queueName).pause()
  }

  /** Resume a previously paused queue. */
  async resumeQueue(queueName: string): Promise<void> {
    await this.queueFor(queueName).resume()
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
    return this.queueFor(queueName).clean(gracePeriodMs, limit, status)
  }

  /** Return a read-only view of the cached queues. */
  getCachedQueues(): ReadonlyMap<string, Queue> {
    return this.queues
  }

  /** Close every cached queue (swallowing per-queue errors) and clear the cache. */
  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close().catch(() => undefined)
    }
    this.queues.clear()
  }
}
