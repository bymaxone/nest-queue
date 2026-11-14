/**
 * @fileoverview Consolidated default values applied to module options.
 * @layer server/constants
 */

import type { JobsOptions } from 'bullmq'

/** Default worker concurrency — a non-serial starting point, tuned per workload. */
export const DEFAULT_WORKER_CONCURRENCY = 2 as const

/**
 * Maximum allowed concurrency per Worker. Values above this ceiling exhaust the
 * event loop, heap, and lock-renewal timers before providing meaningful throughput
 * gains. Single-digit hundreds are typical for I/O-bound workloads (BullMQ docs).
 */
export const MAX_WORKER_CONCURRENCY = 1_000 as const

/**
 * Default options applied to every job enqueued through the service. The
 * `removeOnFail.count` cap bounds Redis memory growth under failure storms. The backoff jitter
 * spreads each retry over the upper half of its delay, so jobs that failed together (a Redis
 * outage, a downstream timeout) do not all retry in the same instant.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
} as const satisfies JobsOptions

/** Default Mode B timeout (ms) to wait for Redis `ready` before throwing. */
export const DEFAULT_CONNECTION_READY_TIMEOUT_MS = 10_000 as const

/**
 * Default deadline (ms) for one Redis command on a connection the library opened. Well below the
 * ~73 s ioredis spends retrying a command before it gives up, so a frozen Redis fails a producer
 * call in seconds rather than holding the request for over a minute.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000 as const

/**
 * Default deadline (ms) for one `enqueue` or `enqueueBulk` call, whatever the connection mode. It
 * covers a shared client whose retries are unbounded, which the command timeout cannot reach.
 */
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 10_000 as const

/** Largest number of jobs one `getJobs` call may read. */
export const MAX_JOBS_PAGE_SIZE = 1_000 as const

/** Default TTL (ms) for the metrics cache. */
export const DEFAULT_METRICS_CACHE_TTL_MS = 5_000 as const

/** Default window (ms) for in-flight jobs to drain before the worker is stopped on shutdown. */
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000 as const
