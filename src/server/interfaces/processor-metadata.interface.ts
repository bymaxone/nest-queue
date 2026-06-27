/**
 * @fileoverview Reflection metadata shapes attached by the processor decorators.
 * @layer server/interfaces
 */

import type { WorkerOptions } from './worker-options.interface'

/** Metadata attached by the processor decorator and read on worker discovery. */
export interface ProcessorMetadata {
  /** Queue the annotated class processes. */
  queueName: string
  /** Worker tuning options for the queue. */
  workerOptions: WorkerOptions
}

/** Metadata attached by the process-handler decorator on a handler method. */
export interface ProcessHandlerMetadata {
  /** Specific job-name filter; `undefined` means catch-all. */
  jobName?: string
  /** Method key on the host class used by the registry to resolve dispatch. */
  methodKey: string | symbol
}

/** Metadata attached by the queue-event listener decorator on a listener method. */
export interface QueueEventListenerMetadata {
  /** Queue event the method listens for. */
  eventName: string
  /** Method key on the host class. */
  methodKey: string | symbol
}
