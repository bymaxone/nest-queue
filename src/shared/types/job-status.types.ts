/**
 * @fileoverview Job status union shared across runtimes.
 * @layer shared/types
 */

/**
 * Snapshot statuses BullMQ exposes via `Queue.getJobCounts()`.
 * Kept in sync with BullMQ's internal status set.
 *
 * @example
 * const status: JobStatus = 'waiting'
 */
export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'
