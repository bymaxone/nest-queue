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
import { Inject, Injectable } from '@nestjs/common'
import { Worker } from 'bullmq'
import type { Job, WorkerOptions as BullWorkerOptions } from 'bullmq'
import type { Redis } from 'ioredis'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'
import type { WorkerOptions } from '../interfaces/worker-options.interface'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { DEFAULT_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY } from '../constants/default-options'

/**
 * Configuration for registering an in-process (NestJS-DI-backed) worker.
 *
 * @template TData - Shape of the job data payload.
 * @template TResult - Shape of the job result.
 */
export interface ProgrammaticWorkerConfig<TData = unknown, TResult = unknown> {
  /** BullMQ queue the worker should consume. */
  queueName: string
  /** Async function that processes a single job. Must be idempotent. */
  handler: (job: Job<TData, TResult>) => Promise<TResult>
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
  private readonly entries = new Map<string, WorkerEntry>()

  constructor(
    private readonly connection: ConnectionResolver,
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
      worker = new Worker<TData, TResult>(queueName, handler, bullOpts)
    } catch (cause) {
      // Disconnect the duplicated connection to prevent a Redis resource leak.
      conn.disconnect()
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
        queueName,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }

    this.entries.set(queueName, { worker, connection: conn })
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
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
        queueName,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }

    this.entries.set(queueName, { worker, connection: conn })
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
    const entry = this.entries.get(queueName)
    if (!entry) return
    await entry.worker.close()
    await this.closeConnection(entry.connection)
    this.entries.delete(queueName)
  }

  /**
   * Returns the queue names of all currently registered workers.
   *
   * @returns An immutable array of queue names.
   */
  list(): readonly string[] {
    return Array.from(this.entries.keys())
  }

  /**
   * Returns a read-only view of the registered workers keyed by queue name.
   * Intended for the shutdown orchestrator only.
   *
   * @returns A read-only map of queue name to worker.
   */
  getAll(): ReadonlyMap<string, Worker> {
    return new Map(
      Array.from(this.entries, ([name, entry]): [string, Worker] => [name, entry.worker]),
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
      Array.from(this.entries, ([name, entry]): [string, Redis] => [name, entry.connection]),
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
    if (this.entries.has(queueName)) {
      throw new QueueException(QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR, 500, { queueName })
    }
  }

  /**
   * Validate tunable options before constructing a Worker.
   * Enforces `concurrency` in `[1, MAX_WORKER_CONCURRENCY]` and
   * `limiter.max`/`limiter.duration` `>= 1`.
   *
   * @param opts - The caller-supplied options (may be undefined).
   * @throws {QueueException} `WORKER_REGISTRATION_FAILED` when values are out of range.
   */
  private validateOptions(opts?: WorkerOptions): void {
    if (opts?.concurrency !== undefined) {
      if (opts.concurrency < 1) {
        throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
          reason: 'concurrency must be >= 1',
          actual: opts.concurrency,
        })
      }
      if (opts.concurrency > MAX_WORKER_CONCURRENCY) {
        throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
          reason: `concurrency must be <= ${MAX_WORKER_CONCURRENCY.toString()}`,
          actual: opts.concurrency,
        })
      }
    }
    if (opts?.limiter !== undefined) {
      if (opts.limiter.max < 1) {
        throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
          reason: 'limiter.max must be >= 1',
          actual: opts.limiter.max,
        })
      }
      if (opts.limiter.duration < 1) {
        throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
          reason: 'limiter.duration must be >= 1',
          actual: opts.limiter.duration,
        })
      }
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
        throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
          reason: 'processorFile URL must use the file: protocol',
        })
      }
      // A file: URL pathname is always absolute; still enforce the extension allowlist
      // so a file: URL cannot bypass the arbitrary-file-execution guard string paths get.
      this.assertProcessorExtension(processorFile.pathname)
      return
    }
    if (!isAbsolute(processorFile)) {
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
        reason: 'processorFile must be an absolute path',
      })
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
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, {
        reason: 'processorFile must have a .js, .cjs, or .mjs extension',
      })
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
