/**
 * @fileoverview Consolidated default values applied to module options.
 * @layer server/constants
 */

import type { JobsOptions } from 'bullmq'

/** Default worker concurrency — a non-serial starting point, tuned per workload. */
export const DEFAULT_WORKER_CONCURRENCY = 2 as const

/**
 * Default options applied to every job enqueued through the service. The
 * `removeOnFail.count` cap bounds Redis memory growth under failure storms.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
} as const satisfies JobsOptions

/** Default Mode B timeout (ms) to wait for Redis `ready` before throwing. */
export const DEFAULT_CONNECTION_READY_TIMEOUT_MS = 10_000 as const

/** Default TTL (ms) for the metrics cache. */
export const DEFAULT_METRICS_CACHE_TTL_MS = 5_000 as const

/** Default window (ms) for in-flight jobs to drain before force-close on shutdown. */
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000 as const
