/**
 * @fileoverview Instantaneous queue metrics snapshot type.
 * @layer shared/types
 */

import type { JobStatus } from './job-status.types'

/**
 * Instantaneous snapshot of a queue's job counts grouped by status.
 *
 * @example
 * const metrics: QueueMetrics = {
 *   queue: 'email',
 *   counts: { waiting: 3, active: 1, completed: 120, failed: 2, delayed: 0, paused: 0 },
 *   collectedAt: '2026-06-26T12:00:00.000Z',
 * }
 */
export interface QueueMetrics {
  /** Queue name the snapshot was taken from. */
  queue: string
  /** Number of jobs in each of the six BullMQ statuses. */
  counts: Record<JobStatus, number>
  /** ISO 8601 UTC timestamp when the snapshot was collected. */
  collectedAt: string
}
