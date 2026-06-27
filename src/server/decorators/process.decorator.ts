/**
 * @fileoverview `@Process` method decorator — registers a method as the handler
 * for a specific job name (or as the catch-all when no name is given). Metadata
 * is accumulated in an array so multiple `@Process` annotations on the same
 * class coexist without overwriting each other.
 * @layer server/decorators
 */

import 'reflect-metadata'
import type { ProcessHandlerMetadata } from '../interfaces/processor-metadata.interface'
import { PROCESS_HANDLERS_METADATA_KEY } from './metadata-keys.constants'

/**
 * Marks a method as a job processor. If `jobName` is supplied the method is
 * only invoked for jobs whose `name` matches; if omitted the method acts as a
 * catch-all for all other job names on the same queue.
 *
 * Multiple `@Process` decorators on the same class are supported — each adds
 * an entry to the accumulated metadata array.
 *
 * Delivery is at-least-once: a handler may run more than once for the same job
 * (worker crash, lock expiry, or a shutdown force-close). Handlers MUST be
 * idempotent — use an idempotency key on writes, prefer upserts over inserts, or
 * keep an "already-processed" marker keyed by `job.id`.
 *
 * @param jobName - Optional job-name filter. Omit for a catch-all handler.
 *
 * @example
 * `@Process`('send-email')
 * async handleSend(job: Job<EmailPayload>) { ... }
 *
 * `@Process`()
 * async handleOthers(job: Job<EmailPayload>) { ... }
 */
export function Process(jobName?: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    // getOwnMetadata prevents walking the prototype chain and mutating an ancestor's array.
    const existing = (Reflect.getOwnMetadata(PROCESS_HANDLERS_METADATA_KEY, target.constructor) ??
      []) as ProcessHandlerMetadata[]
    const entry: ProcessHandlerMetadata =
      jobName !== undefined
        ? { jobName, methodKey: propertyKey }
        : { methodKey: propertyKey }
    Reflect.defineMetadata(PROCESS_HANDLERS_METADATA_KEY, [...existing, entry], target.constructor)
  }
}
