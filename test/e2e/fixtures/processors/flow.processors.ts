/**
 * @fileoverview Three-level flow fixtures. A shared recorder captures the order
 * in which the leaf, child, and root jobs are processed so the E2E suite can
 * prove every descendant completes before its parent.
 * @layer test/e2e/fixtures
 */

import { Injectable } from '@nestjs/common'
import { Process, Processor } from '@bymax-one/nest-queue'

/** Records the processing order across the flow levels. */
@Injectable()
export class FlowRecorder {
  /** Queue-level names in the order they were processed. */
  readonly order: string[] = []
}

/** Processes the deepest flow level. */
@Injectable()
@Processor('flow-leaf')
export class FlowLeafProcessor {
  constructor(private readonly recorder: FlowRecorder) {}

  /** Record that the leaf was processed. */
  @Process()
  async handle(): Promise<void> {
    await Promise.resolve()
    this.recorder.order.push('leaf')
  }
}

/** Processes the middle flow level (processable only after the leaf completes). */
@Injectable()
@Processor('flow-child')
export class FlowChildProcessor {
  constructor(private readonly recorder: FlowRecorder) {}

  /** Record that the child was processed. */
  @Process()
  async handle(): Promise<void> {
    await Promise.resolve()
    this.recorder.order.push('child')
  }
}

/** Processes the flow root (processable only after the child completes). */
@Injectable()
@Processor('flow-root')
export class FlowRootProcessor {
  constructor(private readonly recorder: FlowRecorder) {}

  /** Record that the root was processed. */
  @Process()
  async handle(): Promise<void> {
    await Promise.resolve()
    this.recorder.order.push('root')
  }
}
