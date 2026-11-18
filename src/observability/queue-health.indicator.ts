/**
 * @fileoverview The readiness check of the queue: whether the Redis connection it works through
 * answers a `PING`. It sends no job and reads none; a failure is reported as `down` with no error
 * text, since a connection error can name the server.
 * @layer observability
 */

import { BymaxHealthIndicator } from '@bymax-one/nest-core/health'
import type { HealthIndicatorResult, IHealthIndicator } from '@bymax-one/nest-core/health'
import { Inject, Injectable } from '@nestjs/common'
import { ConnectionResolver } from '@bymax-one/nest-queue'

/** The name the indicator reports in the readiness response. */
export const QUEUE_HEALTH_INDICATOR_NAME = 'queue'

/** How long the `PING` may take before the queue reports `down`. */
const PING_TIMEOUT_MS = 2000

/**
 * Pings the queue's Redis connection.
 *
 * @example
 * BymaxCoreModule.forRoot({ health: { autoDiscover: true } })
 */
@BymaxHealthIndicator()
@Injectable()
export class QueueHealthIndicator implements IHealthIndicator {
  readonly name = QUEUE_HEALTH_INDICATOR_NAME

  /** @param connection - The connection the queue works through. */
  constructor(@Inject(ConnectionResolver) private readonly connection: ConnectionResolver) {}

  /**
   * Ping Redis.
   *
   * @param signal - Aborted when the aggregator stops waiting.
   * @returns `up` when Redis answered in time, `down` otherwise, with the connection mode as detail.
   */
  async check(signal?: AbortSignal): Promise<HealthIndicatorResult> {
    const details = { mode: this.connection.getMode() }
    let release = (): void => undefined
    const stopped = new Promise<never>((_, reject) => {
      const stop = (): void => {
        reject(new Error())
      }
      const timer = setTimeout(stop, PING_TIMEOUT_MS)
      if (signal?.aborted === true) stop()
      signal?.addEventListener('abort', stop)
      release = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
      }
    })
    try {
      await Promise.race([this.connection.getClient().ping(), stopped])
      return { status: 'up', details }
    } catch {
      return { status: 'down', details }
    } finally {
      release()
    }
  }
}
