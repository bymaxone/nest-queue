/**
 * @fileoverview Fail-fast validation of user-supplied module options.
 * @layer server/config
 */

import { HttpStatus } from '@nestjs/common'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/** Throw a well-formed INVALID_OPTIONS exception carrying the failing reason. */
function invalid(reason: string): never {
  throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.INTERNAL_SERVER_ERROR, {
    reason,
  })
}

/**
 * Whether ioredis can parse `url`. It reads a `redis://` or `rediss://` URL as it is and prefixes
 * every other string with a scheme (`redis:` for `//host`, `redis://` otherwise) before handing it
 * to the WHATWG parser, which rejects what it cannot read and makes the client constructor throw
 * `Invalid URL`. A unix socket path never reaches the parser there, and with the prefix it always
 * parses here, so it needs no case of its own.
 */
function isParseableUrl(url: string): boolean {
  if (/^rediss?:\/\//i.test(url)) return URL.canParse(url)
  return URL.canParse(url.startsWith('//') ? `redis:${url}` : `redis://${url}`)
}

/**
 * Validate user-provided options at module bootstrap. Fails fast with an
 * actionable reason and never silently corrects a value.
 *
 * @param opts - The raw module options passed to `forRoot`.
 * @throws QueueException with code `INVALID_OPTIONS` on any violation.
 */
export function validateOptions(opts: BymaxQueueModuleOptions): void {
  const cfg = (opts as { connection?: unknown }).connection
  if (cfg === null || typeof cfg !== 'object') {
    invalid('connection is required')
  }

  const hasClient = 'client' in cfg
  const hasUrl = 'url' in cfg
  const hasOptions = 'options' in cfg

  if (!hasClient && !hasUrl && !hasOptions) {
    invalid('connection must specify client | url | options')
  }
  if (hasClient && (hasUrl || hasOptions)) {
    invalid('connection.client is mutually exclusive with url/options')
  }

  // ioredis reads an unusable url (absent, empty, `null`, an object) as "no url" and connects to
  // localhost:6379, and a number as a port, so the mistake would surface as a connection to the
  // wrong server rather than as an error.
  if (hasUrl) {
    const url: unknown = cfg.url
    if (typeof url !== 'string' || url.trim() === '') {
      invalid('connection.url must be a non-empty string')
    }
    if (!isParseableUrl(url)) {
      invalid('connection.url is not a valid Redis URL')
    }
  }

  const drainTimeoutMs = opts.shutdown?.drainTimeoutMs
  // Stryker disable next-line ConditionalExpression: equivalent — dropping the presence check leaves `undefined <= 0`, which is false, so an absent value is still accepted and a present one still refused; the check states the intent
  if (drainTimeoutMs !== undefined && drainTimeoutMs <= 0) {
    invalid('shutdown.drainTimeoutMs must be > 0')
  }

  const cacheTtlMs = opts.metrics?.cacheTtlMs
  // Stryker disable next-line ConditionalExpression: equivalent — dropping the presence check leaves `undefined < 0`, which is false; same reasoning as the drain timeout above
  if (cacheTtlMs !== undefined && cacheTtlMs < 0) {
    invalid('metrics.cacheTtlMs must be >= 0')
  }
}
