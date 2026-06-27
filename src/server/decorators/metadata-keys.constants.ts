/**
 * @fileoverview Symbol metadata keys used by the processor decorators. Using
 * Symbol literals guarantees they never collide with user-defined metadata keys
 * or with NestJS built-in keys.
 * @layer server/decorators
 */

/**
 * Metadata key for the `@Processor` class decorator — carries
 * {@link ProcessorMetadata}.
 */
export const PROCESSOR_METADATA_KEY = Symbol('bymax_queue:processor')

/**
 * Metadata key for `@Process` method decorators — carries a
 * `ProcessHandlerMetadata[]` array (one entry per decorated method).
 */
export const PROCESS_HANDLERS_METADATA_KEY = Symbol('bymax_queue:process_handlers')

/**
 * Metadata key for `@OnWorkerEvent` method decorators — carries a
 * `QueueEventListenerMetadata[]` array. These listeners are bound to the
 * Worker directly and receive the full BullMQ `Job` instance.
 */
export const WORKER_EVENT_LISTENERS_METADATA_KEY = Symbol('bymax_queue:worker_event_listeners')

/**
 * Metadata key for `@OnQueueEvent` method decorators — carries a
 * `QueueEventListenerMetadata[]` array. These listeners are backed by a
 * `QueueEvents` connection and receive a serialized payload (`jobId` +
 * stringified fields such as `returnvalue` / `failedReason`), NOT the full Job.
 */
export const QUEUE_EVENT_LISTENERS_METADATA_KEY = Symbol('bymax_queue:queue_event_listeners')
