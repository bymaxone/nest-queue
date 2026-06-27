/**
 * @fileoverview `@Processor` class decorator — marks a provider as the handler
 * for a named BullMQ queue. Writes {@link ProcessorMetadata} to class-level
 * reflection metadata under {@link PROCESSOR_METADATA_KEY}.
 * @layer server/decorators
 */

import 'reflect-metadata'
import { DEFAULT_WORKER_CONCURRENCY } from '../constants/default-options'
import type { ProcessorMetadata } from '../interfaces/processor-metadata.interface'
import type { WorkerOptions } from '../interfaces/worker-options.interface'
import { PROCESSOR_METADATA_KEY } from './metadata-keys.constants'

/**
 * Marks a class as the processor for the given queue. The class must be
 * registered as a NestJS provider so that `ProcessorDiscoveryService` can
 * discover and wire it during module initialization.
 *
 * When `options.concurrency` is omitted the library falls back to
 * {@link DEFAULT_WORKER_CONCURRENCY} and emits a `Logger.warn` at discovery
 * time (not here — the decorator itself is side-effect-free).
 *
 * @param queueName - The BullMQ queue this class processes.
 * @param options - Optional worker tuning overrides.
 *
 * @example
 * `@Processor`('email', { concurrency: 5 })
 * class EmailProcessor {
 *   `@Process`()
 *   async handle(job: Job<EmailPayload>) { ... }
 * }
 */
export function Processor(queueName: string, options?: WorkerOptions): ClassDecorator {
  return (target: object): void => {
    const concurrencyOmitted = options?.concurrency === undefined
    const metadata: ProcessorMetadata = {
      queueName,
      workerOptions: {
        concurrency: DEFAULT_WORKER_CONCURRENCY,
        autorun: true,
        ...options,
      },
      ...(concurrencyOmitted ? { _warnedNoConcurrency: true } : {}),
    }
    Reflect.defineMetadata(PROCESSOR_METADATA_KEY, metadata, target)
  }
}
