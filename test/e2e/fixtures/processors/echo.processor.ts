/**
 * @fileoverview Echo processor fixture. Returns a typed result and captures the
 * matching `completed` payload through a worker-global `@OnQueueEvent` listener
 * so the E2E suite can assert the round-trip of a typed return value.
 * @layer test/e2e/fixtures
 */

import { Injectable } from '@nestjs/common'
import { OnQueueEvent, Process, Processor } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

/** Input payload for the echo job. */
export interface EchoData {
  /** The value to echo back. */
  value: string
}

/** Typed result returned by the echo handler. */
export interface EchoResult {
  /** The echoed value. */
  echoed: string
}

/** A captured `completed` event from the queue-global listener. */
export interface CompletedCapture {
  /** The completed job id. */
  jobId: string
  /** The serialized return value as delivered by `QueueEvents`. */
  returnvalue: unknown
}

/** Processes the `echo` queue and records completions for assertions. */
@Injectable()
@Processor('echo')
export class EchoProcessor {
  /** Completions captured via the queue-global `completed` event. */
  readonly completed: CompletedCapture[] = []

  /**
   * Echo the input value back as the typed result.
   *
   * @param job - The echo job.
   * @returns The echoed result.
   */
  @Process()
  async handle(job: Job<EchoData, EchoResult>): Promise<EchoResult> {
    await Promise.resolve()
    return { echoed: job.data.value }
  }

  /**
   * Capture the queue-global `completed` event payload.
   *
   * @param args - The event payload (`jobId` + serialized `returnvalue`).
   */
  @OnQueueEvent('completed')
  onCompleted(args: { jobId: string; returnvalue: unknown }): void {
    this.completed.push({ jobId: args.jobId, returnvalue: args.returnvalue })
  }
}
