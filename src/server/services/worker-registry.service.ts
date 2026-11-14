/**
 * @fileoverview `WorkerRegistry` — creates, tracks, and destroys BullMQ
 * `Worker` instances. Provides both an in-process path (handler function, NestJS
 * DI available) and a file-based sandboxed path (no NestJS DI). Every worker
 * connection is a duplicate of the Queue-role client with
 * `maxRetriesPerRequest: null`, as required by BullMQ blocking commands. The
 * duplicated connection is tracked alongside the worker so the shutdown
 * orchestrator can close exactly the connections the library opened.
 * @layer server/services
 */

import { isAbsolute, extname } from 'node:path'
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { Worker } from 'bullmq'
import type { Job, WorkerOptions as BullWorkerOptions } from 'bullmq'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'
import { attachDefaultErrorListener } from '../utils/attach-error-listener'
import { describeError } from '../utils/describe-error'
import { withDeadline } from '../utils/with-deadline'
import { isTimerDelayMs } from '../utils/timer-delay'
import { workerOptionProblem } from '../utils/worker-option-problem'
import { isAbandoned } from '../utils/abandoned-workers'
import type { WorkerOptions } from '../interfaces/worker-options.interface'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { DEFAULT_WORKER_CONCURRENCY } from '../constants/default-options'

/**
 * Configuration for registering an in-process (NestJS-DI-backed) worker.
 *
 * @template TData - Shape of the job data payload.
 * @template TResult - Shape of the job result.
 */
export interface ProgrammaticWorkerConfig<TData = unknown, TResult = unknown> {
  /** BullMQ queue the worker should consume. */
  queueName: string
  /**
   * Async function that processes a single job. Must be idempotent. Its optional second argument
   * is the job's `AbortSignal`: it aborts when the job's `jobTimeoutMs` passes or when BullMQ
   * cancels the job (`worker.cancelJob()`, `worker.cancelAllJobs()`). Closing the worker does not
   * abort it. Pass it to whatever the handler awaits so the work stops with the job.
   */
  handler: (job: Job<TData, TResult>, signal?: AbortSignal) => Promise<TResult>
  /** Optional worker tuning overrides. */
  options?: WorkerOptions
}

/**
 * Configuration for registering a sandboxed (file-based, out-of-process) worker.
 * The processor runs in a separate Node.js process and cannot access NestJS DI.
 * `processorFile` must be an absolute path or a `file:` URL with a `.js`, `.cjs`,
 * or `.mjs` extension.
 *
 * @see https://docs.bullmq.io/guide/workers/sandboxed-processors
 */
export interface SandboxedWorkerConfig {
  /** BullMQ queue the worker should consume. */
  queueName: string
  /**
   * Absolute path or `file:` URL to the compiled `.js`/`.cjs`/`.mjs` processor
   * artifact. Relative paths and non-JS extensions are rejected at registration
   * time. The file must export a default async function
   * `(job: Job) => Promise<unknown>`.
   */
  processorFile: string | URL
  /** Optional worker tuning overrides, including `useWorkerThreads`. */
  options?: WorkerOptions & { useWorkerThreads?: boolean }
}

/**
 * A registered worker paired with the duplicated connection the library opened
 * for it. Pairing them lets the shutdown orchestrator close the worker and then
 * release its connection without a separate lookup.
 */
interface WorkerEntry {
  /** The BullMQ worker instance. */
  worker: Worker
  /** The duplicated ioredis connection the library created for this worker. */
  connection: Redis
}

/**
 * Creates and lifecycle-manages BullMQ `Worker` instances on behalf of the
 * module. Supports two registration paths:
 *
 * - **Programmatic** (`register`) — in-process handler; NestJS DI is available
 *   inside the handler function.
 * - **Sandboxed** (`registerSandboxed`) — file-based, out-of-process; the
 *   processor file is loaded in a separate Node.js child process and has **no**
 *   access to NestJS DI.
 *
 * All workers use a duplicated Redis connection (`maxRetriesPerRequest: null`)
 * for the blocking `BRPOPLPUSH`/`BZPOPMIN`/`BLMOVE` commands. The duplicated
 * connection is closed immediately when the Worker constructor fails, preventing
 * a connection leak.
 *
 * @example
 * const worker = registry.register({
 *   queueName: 'email',
 *   handler: async (job) => sendEmail(job.data),
 *   options: { concurrency: 5 },
 * })
 */
@Injectable()
export class WorkerRegistry {
  private readonly logger = new Logger(WorkerRegistry.name)
  readonly #entries = new Map<string, WorkerEntry>()

  constructor(
    @Inject(ConnectionResolver) private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly options: ResolvedQueueOptions,
  ) {}

  /**
   * Register an in-process worker with a handler function. The BullMQ `Worker`
   * constructor is synchronous — no Redis handshake is performed at registration
   * time. The duplicated connection is disconnected immediately if construction
   * fails, preventing a Redis connection leak.
   *
   * @param config - Queue name, handler, and optional worker options.
   * @returns The created BullMQ `Worker` instance.
   * @throws {QueueException} `DUPLICATE_PROCESSOR` when a worker for
   *   `queueName` already exists.
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when options are
   *   invalid or the BullMQ `Worker` constructor throws.
   */
  register<TData = unknown, TResult = unknown>(
    config: ProgrammaticWorkerConfig<TData, TResult>,
  ): Worker<TData, TResult> {
    const { queueName, handler, options } = config
    this.guardDuplicate(queueName)
    this.validateOptions(options)

    const conn = duplicateConnection(this.connection.getClient())
    const bullOpts = this.buildBullOptions(options, conn)

    let worker: Worker<TData, TResult>
    try {
      worker = new Worker<TData, TResult>(
        queueName,
        toProcessor(handler, options?.jobTimeoutMs, () => isAbandoned(worker)),
        bullOpts,
      )
    } catch (cause) {
      // Disconnect the duplicated connection to prevent a Redis resource leak.
      conn.disconnect()
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          queueName,
          cause: describeError(cause),
        },
      )
    }

    attachDefaultErrorListener(worker, this.logger, 'Worker', queueName)
    this.#entries.set(queueName, { worker, connection: conn })
    return worker
  }

  /**
   * Register a sandboxed (file-based, out-of-process) worker. The processor
   * file must be an absolute path or a `file:` URL pointing to a compiled
   * `.js`/`.cjs`/`.mjs` artifact. NestJS DI is **not** available inside the
   * processor. The BullMQ `Worker` constructor is synchronous.
   *
   * @param config - Queue name, processor file path/URL, and optional options.
   * @returns The created BullMQ `Worker` instance.
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when `processorFile`
   *   is a relative path, has a disallowed extension, or uses a non-`file:` URL protocol.
   * @throws {QueueException} `DUPLICATE_PROCESSOR` when a worker for
   *   `queueName` already exists.
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when options are
   *   invalid or the BullMQ `Worker` constructor throws.
   */
  registerSandboxed(config: SandboxedWorkerConfig): Worker {
    const { queueName, processorFile, options } = config
    if (options?.jobTimeoutMs !== undefined) {
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        { reason: 'jobTimeoutMs is not available for sandboxed workers' },
      )
    }
    this.validateProcessorFile(processorFile)
    this.guardDuplicate(queueName)
    this.validateOptions(options)

    const conn = duplicateConnection(this.connection.getClient())
    const bullOpts = this.buildBullOptions(options, conn)
    if (options?.useWorkerThreads !== undefined) {
      bullOpts.useWorkerThreads = options.useWorkerThreads
    }

    let worker: Worker
    try {
      worker = new Worker(queueName, processorFile, bullOpts)
    } catch (cause) {
      // Disconnect the duplicated connection to prevent a Redis resource leak.
      conn.disconnect()
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          queueName,
          cause: describeError(cause),
        },
      )
    }

    attachDefaultErrorListener(worker, this.logger, 'Worker', queueName)
    this.#entries.set(queueName, { worker, connection: conn })
    return worker
  }

  /**
   * Stop and remove the worker for the given queue, releasing the duplicated
   * connection the library opened for it. If no worker exists for `queueName`
   * this is a no-op.
   *
   * @param queueName - The queue whose worker should be removed.
   */
  async unregister(queueName: string): Promise<void> {
    const entry = this.#entries.get(queueName)
    if (!entry) return
    try {
      await entry.worker.close()
    } finally {
      // A close that throws must still release the connection and drop the entry: the worker is
      // gone either way, and keeping the entry would leak the socket and block re-registration.
      await this.closeConnection(entry.connection)
      this.#entries.delete(queueName)
    }
  }

  /**
   * Returns the queue names of all currently registered workers.
   *
   * @returns An immutable array of queue names.
   */
  list(): readonly string[] {
    return Array.from(this.#entries.keys())
  }

  /**
   * Returns a read-only view of the registered workers keyed by queue name.
   * Intended for the shutdown orchestrator only.
   *
   * @returns A read-only map of queue name to worker.
   */
  getAll(): ReadonlyMap<string, Worker> {
    return new Map(
      Array.from(this.#entries, ([name, entry]): [string, Worker] => [name, entry.worker]),
    )
  }

  /**
   * Returns a read-only view of the duplicated connections the library opened
   * for its workers, keyed by queue name. Intended for the shutdown orchestrator
   * so it can close exactly the connections the library created (Mode A never
   * exposes the consumer's shared client here).
   *
   * @returns A read-only map of queue name to duplicated connection.
   */
  getConnections(): ReadonlyMap<string, Redis> {
    return new Map(
      Array.from(this.#entries, ([name, entry]): [string, Redis] => [name, entry.connection]),
    )
  }

  /**
   * Gracefully quit a duplicated connection, falling back to a hard disconnect
   * if the quit handshake fails so a socket is never leaked.
   *
   * @param connection - The duplicated connection to release.
   */
  private async closeConnection(connection: Redis): Promise<void> {
    try {
      await connection.quit()
    } catch {
      connection.disconnect()
    }
  }

  /**
   * Guard against registering two workers for the same queue.
   *
   * @param queueName - Queue name to check.
   * @throws {QueueException} `DUPLICATE_PROCESSOR` if the queue is already registered.
   */
  private guardDuplicate(queueName: string): void {
    if (this.#entries.has(queueName)) {
      throw new QueueException(
        QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR,
        HttpStatus.INTERNAL_SERVER_ERROR,
        { queueName },
      )
    }
  }

  /**
   * Validate tunable options before constructing a Worker.
   * Enforces whole-number `concurrency` in `[1, MAX_WORKER_CONCURRENCY]`, whole-number
   * `limiter.max`/`limiter.duration` `>= 1`, and `lockDuration`/`stalledInterval` within
   * 1000..2^31 - 1.
   *
   * @param opts - The caller-supplied options (may be undefined).
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when values are out of range.
   */
  private validateOptions(opts?: WorkerOptions): void {
    const problem = workerOptionProblem(opts)
    if (problem !== undefined) {
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        problem,
      )
    }
    this.validateJobTimeout(opts)
  }

  /**
   * Validate `jobTimeoutMs`, which must be a timer delay Node honours: above 2^31 - 1 ms it would
   * fire after 1 ms and fail every job at once.
   *
   * @param opts - The caller-supplied options (may be undefined).
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when the value is out of range.
   */
  private validateJobTimeout(opts?: WorkerOptions): void {
    if (opts?.jobTimeoutMs !== undefined && !isTimerDelayMs(opts.jobTimeoutMs)) {
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          reason: 'jobTimeoutMs must be a whole number from 1 to 2147483647',
          actual: opts.jobTimeoutMs,
        },
      )
    }
  }

  /**
   * Validate that `processorFile` is a safe, reachable artifact path. Accepts
   * absolute paths with `.js`/`.cjs`/`.mjs` extensions and `file:` URLs. Rejects
   * relative paths, non-JS extensions, and non-`file:` URL protocols to prevent
   * path-traversal and arbitrary-file-execution attacks.
   *
   * @param processorFile - The path or URL supplied by the caller.
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when validation fails.
   */
  private validateProcessorFile(processorFile: string | URL): void {
    if (processorFile instanceof URL) {
      if (processorFile.protocol !== 'file:') {
        throw new QueueException(
          QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
          HttpStatus.INTERNAL_SERVER_ERROR,
          {
            reason: 'processorFile URL must use the file: protocol',
          },
        )
      }
      // A file: URL pathname is always absolute; still enforce the extension allowlist
      // so a file: URL cannot bypass the arbitrary-file-execution guard string paths get.
      this.assertProcessorExtension(processorFile.pathname)
      return
    }
    if (!isAbsolute(processorFile)) {
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          reason: 'processorFile must be an absolute path',
        },
      )
    }
    this.assertProcessorExtension(processorFile)
  }

  /**
   * Reject a processor path whose extension is not an executable JS module,
   * the last line of defense against loading an arbitrary file as a worker.
   *
   * @param filePath - The filesystem path (or file: URL pathname) to check.
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` for a disallowed extension.
   */
  private assertProcessorExtension(filePath: string): void {
    const allowedExtensions = new Set<string>(['.js', '.cjs', '.mjs'])
    if (!allowedExtensions.has(extname(filePath))) {
      throw new QueueException(
        QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          reason: 'processorFile must have a .js, .cjs, or .mjs extension',
        },
      )
    }
  }

  /**
   * Build a BullMQ `WorkerOptions` object from the library's `WorkerOptions`
   * shape. Only forwards optional fields that are explicitly set to preserve
   * `exactOptionalPropertyTypes` correctness. Accepts the pre-created duplicated
   * connection so callers can close it on construction failure.
   *
   * @param opts - Library-level worker options.
   * @param conn - Pre-created duplicated Redis connection.
   * @returns A BullMQ-compatible options object.
   */
  private buildBullOptions(opts: WorkerOptions | undefined, conn: Redis): BullWorkerOptions {
    const result: BullWorkerOptions = {
      connection: conn,
      concurrency: opts?.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
      autorun: opts?.autorun ?? true,
      // Match the producer Queue's key prefix so the worker polls the same
      // keyspace; without this a non-default prefix leaves jobs unconsumed.
      prefix: this.options.prefix,
    }
    if (opts?.limiter !== undefined) result.limiter = opts.limiter
    if (opts?.lockDuration !== undefined) result.lockDuration = opts.lockDuration
    if (opts?.stalledInterval !== undefined) result.stalledInterval = opts.stalledInterval
    // Propagate the configured telemetry instance so spans cross from enqueue()
    // into the worker; the key stays absent when telemetry is not configured.
    if (this.options.telemetry !== undefined) result.telemetry = this.options.telemetry
    return result
  }
}

/** What a job fails with when its handler outlives `jobTimeoutMs`; BullMQ retries it like any error. */
class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`queue.job_timeout: the handler did not settle within ${String(timeoutMs)}ms`)
    this.name = 'JobTimeoutError'
  }
}

/**
 * Adapt a library handler to BullMQ's processor signature. BullMQ calls its processor with
 * `(job, token, signal)`, and creates that per-job signal only for a processor that declares three
 * parameters, which both processors returned here do; the handler gets `(job, signal)`. With a
 * timeout, the signal handed over also aborts at the deadline, which is when the job fails and the
 * slot frees; the handler's own promise is not cancelled. The relay listener on BullMQ's signal is
 * removed as soon as the job settles.
 */
function adaptHandler<TData, TResult>(
  handler: (job: Job<TData, TResult>, signal?: AbortSignal) => Promise<TResult>,
  timeoutMs: number | undefined,
): (job: Job<TData, TResult>, token?: string, signal?: AbortSignal) => Promise<TResult> {
  if (timeoutMs === undefined) return (job, _token, signal) => handler(job, signal)
  return (job, _token, signal) => {
    const own = new AbortController()
    const relay = (): void => {
      // Stryker disable next-line OptionalChaining: equivalent — `relay` runs only when the signal exists, by the check and the listener below
      own.abort(signal?.reason)
    }
    if (signal?.aborted === true) relay()
    signal?.addEventListener('abort', relay)
    // Calling the handler inside a promise turns a throw before it returns one into a rejection,
    // so the cleanup below runs for it too.
    return withDeadline(
      Promise.resolve().then(() => handler(job, own.signal)),
      timeoutMs,
      () => {
        const error = new JobTimeoutError(timeoutMs)
        own.abort(error)
        return error
      },
    ).finally(() => {
      signal?.removeEventListener('abort', relay)
    })
  }
}

/**
 * The processor BullMQ is given: the adapted handler, whose outcome is dropped once the worker has
 * been abandoned by the shutdown. A dropped outcome leaves the returned promise pending for good,
 * so BullMQ never resumes the worker that the shutdown already stopped; the job's lock is gone and
 * it is retried elsewhere, so nothing is lost that was not already. It still declares three
 * parameters, which is what makes BullMQ create the per-job signal.
 */
function toProcessor<TData, TResult>(
  handler: (job: Job<TData, TResult>, signal?: AbortSignal) => Promise<TResult>,
  timeoutMs: number | undefined,
  abandoned: () => boolean,
): (job: Job<TData, TResult>, token?: string, signal?: AbortSignal) => Promise<TResult> {
  const run = adaptHandler(handler, timeoutMs)
  return (job, token, signal) =>
    run(job, token, signal).then(
      (value) => (abandoned() ? new Promise<never>(() => undefined) : value),
      (error: unknown) => {
        if (abandoned()) return new Promise<never>(() => undefined)
        throw error
      },
    )
}
