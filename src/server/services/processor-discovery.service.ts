/**
 * @fileoverview `ProcessorDiscoveryService` — scans all NestJS providers at
 * module initialization time, finds classes annotated with `@Processor`, and
 * wires each one into BullMQ: registers a `Worker` via `WorkerRegistry`, binds
 * `@OnWorkerEvent` listeners directly to the Worker (no extra connection), and
 * binds `@OnQueueEvent` listeners to a lazily-created `QueueEvents` (one extra
 * connection per queue, opened only when needed).
 * @layer server/services
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import type { Job } from 'bullmq'
import { WorkerRegistry } from './worker-registry.service'
import { QueueEventsRegistry } from './queue-events-registry.service'
import {
  PROCESSOR_METADATA_KEY,
  PROCESS_HANDLERS_METADATA_KEY,
  WORKER_EVENT_LISTENERS_METADATA_KEY,
  QUEUE_EVENT_LISTENERS_METADATA_KEY,
} from '../decorators/metadata-keys.constants'
import type {
  ProcessorMetadata,
  ProcessHandlerMetadata,
  QueueEventListenerMetadata,
} from '../interfaces/processor-metadata.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { DEFAULT_WORKER_CONCURRENCY } from '../constants/default-options'

/**
 * Minimal event-emitter interface used to attach listeners to BullMQ `Worker`
 * and `QueueEvents` objects without triggering their typed overloads.
 */
interface GenericEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Helper shape used to access `.constructor` without triggering unsafe-member-access. */
interface WithConstructor {
  constructor: object
}

/**
 * Scans all registered NestJS providers at bootstrap, discovers classes
 * annotated with `@Processor`, and wires each into BullMQ:
 *
 * 1. Resolves `@Process` handlers and builds a dispatcher (named → catch-all
 *    → error).
 * 2. Registers a `Worker` for the queue via `WorkerRegistry.register`.
 * 3. Binds every `@OnWorkerEvent` listener to the `Worker` directly — handler
 *    receives the full `Job` with no extra Redis connection.
 * 4. If the class has any `@OnQueueEvent` listeners, calls
 *    `QueueEventsRegistry.getOrCreate` (opening exactly one connection per
 *    queue) and binds each listener to the resulting `QueueEvents` — handler
 *    receives a serialized payload (`jobId` + string fields), NOT the full Job.
 */
@Injectable()
export class ProcessorDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(ProcessorDiscoveryService.name)
  private readonly registeredQueues = new Set<string>()

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(WorkerRegistry) private readonly workers: WorkerRegistry,
    @Inject(QueueEventsRegistry) private readonly events: QueueEventsRegistry,
  ) {}

  /**
   * Entry point called by NestJS after the module is fully initialized.
   * Discovers all `@Processor`-annotated providers and wires them.
   */
  onModuleInit(): void {
    const providers = this.discovery.getProviders()

    for (const wrapper of providers) {
      const instance: unknown = wrapper.instance
      if (!instance || typeof instance !== 'object') continue

      const ctor = (instance as WithConstructor).constructor

      const processorMeta = Reflect.getOwnMetadata(PROCESSOR_METADATA_KEY, ctor) as
        | ProcessorMetadata
        | undefined
      if (!processorMeta) continue

      this.wireProcessor(instance as Record<string | symbol, unknown>, processorMeta)
    }
  }

  /**
   * Build a dispatcher function that routes `job.name` to the correct handler.
   * Named handlers take priority; a catch-all (`@Process()`) handles everything
   * else. Throws if no matching handler is found at job-processing time.
   *
   * @param instance - The provider instance whose methods serve as handlers.
   * @param handlers - Accumulated `@Process` metadata entries for the class.
   * @returns A dispatcher `(job: Job) => Promise<unknown>`.
   */
  buildDispatcher(
    instance: Record<string | symbol, unknown>,
    handlers: ProcessHandlerMetadata[],
  ): (job: Job) => Promise<unknown> {
    const namedHandlers = new Map<string, (job: Job) => Promise<unknown>>()
    let catchAll: ((job: Job) => Promise<unknown>) | undefined

    for (const { jobName, methodKey } of handlers) {
      const method = instance[methodKey]
      if (typeof method !== 'function') continue
      const fn = (method as (job: Job) => Promise<unknown>).bind(instance)
      if (jobName !== undefined) {
        namedHandlers.set(jobName, fn)
      } else {
        catchAll = fn
      }
    }

    return (job: Job): Promise<unknown> => {
      const specific = namedHandlers.get(job.name)
      if (specific) return specific(job)
      if (catchAll) return catchAll(job)
      return Promise.reject(
        new Error(
          `No handler registered for job name "${job.name}" on queue — ` +
            'add a matching @Process("name") or a catch-all @Process() method.',
        ),
      )
    }
  }

  /**
   * Wire a single discovered processor class: validate uniqueness, register a
   * Worker, bind worker-local and queue-global event listeners.
   *
   * @param instance - The resolved provider instance.
   * @param processorMeta - Metadata written by `@Processor`.
   */
  private wireProcessor(
    instance: Record<string | symbol, unknown>,
    processorMeta: ProcessorMetadata,
  ): void {
    const { queueName, workerOptions, _warnedNoConcurrency } = processorMeta
    const ctor = (instance as WithConstructor).constructor

    if (this.registeredQueues.has(queueName)) {
      throw new QueueException(QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR, 500, { queueName })
    }
    this.registeredQueues.add(queueName)

    if (_warnedNoConcurrency) {
      this.logger.warn(
        `Queue "${queueName}": concurrency was not specified — ` +
          `defaulting to concurrency=${String(DEFAULT_WORKER_CONCURRENCY)}. ` +
          'Set an explicit concurrency for production workloads.',
      )
    }

    const handlers = (Reflect.getOwnMetadata(PROCESS_HANDLERS_METADATA_KEY, ctor) ??
      []) as ProcessHandlerMetadata[]
    const dispatcher = this.buildDispatcher(instance, handlers)

    const worker = this.workers.register({
      queueName,
      handler: dispatcher,
      options: workerOptions,
    })

    const workerListeners = (Reflect.getOwnMetadata(WORKER_EVENT_LISTENERS_METADATA_KEY, ctor) ??
      []) as QueueEventListenerMetadata[]
    const workerEmitter = worker as unknown as GenericEmitter
    for (const { eventName, methodKey } of workerListeners) {
      const method = instance[methodKey]
      if (typeof method === 'function') {
        workerEmitter.on(eventName, (method as (...args: unknown[]) => unknown).bind(instance))
      }
    }

    const queueListeners = (Reflect.getOwnMetadata(QUEUE_EVENT_LISTENERS_METADATA_KEY, ctor) ??
      []) as QueueEventListenerMetadata[]
    if (queueListeners.length > 0) {
      const qe = this.events.getOrCreate(queueName)
      const qeEmitter = qe as unknown as GenericEmitter
      for (const { eventName, methodKey } of queueListeners) {
        const method = instance[methodKey]
        if (typeof method === 'function') {
          qeEmitter.on(eventName, (method as (...args: unknown[]) => unknown).bind(instance))
        }
      }
    }
  }
}
