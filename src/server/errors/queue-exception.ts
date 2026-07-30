/**
 * @fileoverview Standardized, HTTP-shaped exception for queue operations.
 * @layer server/errors
 */

import { HttpException, HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_MESSAGES } from '../constants/error-codes'

/**
 * Standardized exception for queue operations. The response body always follows
 * the shape `{ error: { code, message, details } }`. The `code` is a stable,
 * transport-independent identifier; consumers catching this exception outside an
 * HTTP request should branch on `code`, not the HTTP status or the message text.
 * The code lives in the response envelope — read it via `getResponse()`.
 *
 * `details` must never carry secrets (connection strings, passwords, `job.data`)
 * — only scalar configuration values such as `{ actualValue, expectedValue }`.
 *
 * @example Throwing
 * throw new QueueException('queue.connection_timeout', 500, { timeoutMs: 10_000 })
 * @example Branching on the code in a consumer
 * catch (err) {
 *   if (err instanceof QueueException) {
 *     const { code } = (err.getResponse() as { error: { code: string } }).error
 *     if (code === QUEUE_ERROR_CODES.FLOW_DISABLED) enableFlows()
 *   }
 * }
 */
export class QueueException extends HttpException {
  constructor(
    code: string,
    statusCode: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, unknown>,
  ) {
    super(
      {
        error: {
          code,
          message: QUEUE_ERROR_MESSAGES[code] ?? 'Queue error',
          details: details ?? null,
        },
      },
      statusCode,
    )
  }
}
