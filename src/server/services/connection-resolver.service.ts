/**
 * @fileoverview Dual-mode Redis connection resolver. Resolves a BYO client
 * (Mode A) or opens a library-owned ioredis with a ready timeout (Mode B), and
 * enforces the per-role `maxRetriesPerRequest` policy.
 * @layer server/services
 */

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { Redis } from 'ioredis'
import { BYMAX_QUEUE_OPTIONS } from '../bymax-queue.constants'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueConnectionMode } from '../interfaces/queue-connection.interface'
import { assertBlockingConnection, isClientUsable } from '../utils/validate-connection'
import { duplicateConnection } from '../utils/duplicate-connection'
import { DEFAULT_CONNECTION_READY_TIMEOUT_MS } from '../constants/default-options'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Resolves the Queue-role Redis connection and tracks ownership so the lifecycle
 * knows whether to close it on shutdown.
 *
 * - Mode A (BYO): the received client is used as-is for the Queue/FlowProducer
 *   role and never closed; a duplicated probe verifies that the blocking-role
 *   override resolves to `maxRetriesPerRequest: null`.
 * - Mode B (owned): the library opens its own client (URL or options) and waits
 *   for `ready`, closing it on shutdown.
 */
@Injectable()
export class ConnectionResolver implements OnModuleDestroy {
  private client: Redis | undefined
  private mode: QueueConnectionMode | undefined

  constructor(
    @Inject(BYMAX_QUEUE_OPTIONS) private readonly options: BymaxQueueModuleOptions,
  ) {}

  /** Resolve and validate the connection. Call once during module bootstrap. */
  async init(): Promise<void> {
    const cfg = this.options.connection
    if ('client' in cfg) {
      this.initModeA(cfg.client)
      return
    }
    this.mode = 'mode-b-owned'
    this.client =
      'url' in cfg
        ? new Redis(cfg.url, { ...(cfg.options ?? {}), lazyConnect: false })
        : new Redis({ ...cfg.options, lazyConnect: false })
    await this.waitReady(this.options.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS)
  }

  /** The resolved Queue-role client. */
  getClient(): Redis {
    if (!this.client) {
      throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, { reason: 'not initialized' })
    }
    return this.client
  }

  /** The resolved connection mode. */
  getMode(): QueueConnectionMode {
    if (!this.mode) {
      throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, { reason: 'not initialized' })
    }
    return this.mode
  }

  /** Whether the library owns (and must close) the connection. */
  isOwned(): boolean {
    return this.mode === 'mode-b-owned'
  }

  /** Close the library-owned connection on shutdown; never touch a BYO client. */
  async onModuleDestroy(): Promise<void> {
    if (this.isOwned() && this.client) {
      const client = this.client
      await client.quit().catch(() => {
        client.disconnect()
      })
    }
  }

  /** Validate and adopt a bring-your-own client for the Queue role. */
  private initModeA(client: Redis): void {
    this.mode = 'mode-a-byo'
    this.client = client
    if (!isClientUsable(client)) {
      throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, { status: client.status })
    }
    const probe = duplicateConnection(client)
    try {
      assertBlockingConnection(probe)
    } finally {
      probe.disconnect()
    }
  }

  /** Resolve when the owned client reaches `ready`, or reject on timeout/error. */
  private async waitReady(timeoutMs: number): Promise<void> {
    const client = this.getClient()
    if (client.status === 'ready') return
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        client.off('ready', onReady)
        client.off('error', onError)
      }
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new QueueException(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, 500, { timeoutMs }))
      }, timeoutMs)
      client.once('ready', onReady)
      client.once('error', onError)
    })
  }
}
