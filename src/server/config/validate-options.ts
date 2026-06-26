/**
 * @fileoverview Fail-fast validation of user-supplied module options.
 * @layer server/config
 */

import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/** Throw a well-formed INVALID_OPTIONS exception carrying the failing reason. */
function invalid(reason: string): never {
  throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason })
}

/**
 * Validate user-provided options at module bootstrap. Fails fast with an
 * actionable reason and never silently corrects a value.
 *
 * @param opts - The raw module options passed to `forRoot`.
 * @throws QueueException with code `INVALID_OPTIONS` on any violation.
 */
export function validateOptions(opts: BymaxQueueModuleOptions): void {
  const cfg = (opts as { connection?: Record<string, unknown> }).connection
  if (!cfg) invalid('connection is required')

  const hasClient = 'client' in cfg
  const hasUrl = 'url' in cfg
  const hasOptions = 'options' in cfg

  if (!hasClient && !hasUrl && !hasOptions) {
    invalid('connection must specify client | url | options')
  }
  if (hasClient && (hasUrl || hasOptions)) {
    invalid('connection.client is mutually exclusive with url/options')
  }

  const drainTimeoutMs = opts.shutdown?.drainTimeoutMs
  if (drainTimeoutMs !== undefined && drainTimeoutMs <= 0) {
    invalid('shutdown.drainTimeoutMs must be > 0')
  }

  const cacheTtlMs = opts.metrics?.cacheTtlMs
  if (cacheTtlMs !== undefined && cacheTtlMs < 0) {
    invalid('metrics.cacheTtlMs must be >= 0')
  }
}
