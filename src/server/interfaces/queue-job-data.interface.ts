/**
 * @fileoverview Job descriptor used by the bulk-enqueue API.
 * @layer server/interfaces
 */

import type { BulkJobOptions } from 'bullmq'

/**
 * A single job descriptor used by `enqueueBulk`.
 *
 * @example
 * const job: BulkJob<{ to: string }> = { name: 'send', data: { to: 'a@b.com' } }
 */
export interface BulkJob<TData = unknown> {
  /** Job name used by handlers to dispatch. */
  name: string
  /** Typed job payload. */
  data: TData
  /** Per-job BullMQ options (priority, delay, jobId, deduplication, ...). */
  options?: BulkJobOptions
}
