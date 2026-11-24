/**
 * @fileoverview Adds flow trees one at a time with a bounded number in flight, and says exactly what
 * happened to every tree. BullMQ's `FlowProducer.addBulk` reads each tree's result as `[err, id]`
 * and skips a failed one without throwing, so a bulk that Redis refused resolves with ids of jobs
 * that were never stored. `FlowProducer.add` rejects correctly, which this builds on.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import type { FlowJob, JobNode } from 'bullmq'
import { assertPrototypeClean } from '../connection/prototype-guard'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import { joinAll, own } from './bounded-wait'
import { errorSummary, timeoutException } from './command-timeout'

/** What became of every tree of a batch, as indexes into the batch; the four lists partition it. */
export interface FlowBulkOutcome {
  /** Trees whose add resolved. */
  landed: number[]
  /** Trees whose add rejected, because Redis refused them or the connection was down; one may have left child jobs behind. */
  failed: number[]
  /** Trees never handed to BullMQ; nothing of them was written, so they are safe to resend. */
  notStarted: number[]
  /** Trees in flight when the outcome was read, or whose command timed out; they may still land. */
  unknown: number[]
}

/** A running batch: its result, a snapshot of its progress, and a way to stop starting trees. */
export interface FlowBulkRun {
  /** Resolves with every node in input order, or rejects once every started tree has settled. */
  readonly done: Promise<JobNode[]>
  /** The partition of the batch at this moment. */
  outcome(): FlowBulkOutcome
  /** Start no tree after this call; trees already in flight are not cancelled. */
  stop(): void
}

/** Codes a failed tree already carries that the batch reports as its own. */
const KEEP_CODES: ReadonlySet<string> = new Set([
  QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
  QUEUE_ERROR_CODES.STORAGE_FULL,
])

type TreeState = 'pending' | 'running' | 'landed' | 'failed' | 'timedOut'

/** The error a batch rejects with: the first failure's code and status when it has a kept code. */
function batchFailure(operation: string, first: unknown, outcome: FlowBulkOutcome): QueueException {
  const carried = first instanceof QueueException ? envelopeOf(first) : undefined
  const keep = carried !== undefined && KEEP_CODES.has(carried.code)
  // Both codes a batch keeps are 503s, the status the table in the status contract pins for them.
  const exception = keep
    ? new QueueException(carried.code, HttpStatus.SERVICE_UNAVAILABLE, {
        ...carried.details,
        operation,
        ...outcome,
      })
    : new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, HttpStatus.INTERNAL_SERVER_ERROR, {
        operation,
        ...outcome,
      })
  exception.cause = first instanceof QueueException ? first : errorSummary(first)
  return exception
}

/** The code and details a `QueueException` carries in its envelope. */
function envelopeOf(err: QueueException): {
  code: string
  details: Record<string, unknown> | null
} {
  const { error } = err.getResponse() as {
    error: { code: string; details: Record<string, unknown> | null }
  }
  return error
}

/**
 * Whether a tree's failure is a command timeout: Redis may apply the command after the caller was
 * told, so the tree is `unknown`, not `failed`. A call refused because the connection was down
 * sent nothing and carries no deadline, so it stays `failed`.
 */
function answeredLate(error: unknown): boolean {
  if (!(error instanceof QueueException)) return false
  const { code, details } = envelopeOf(error)
  return code === QUEUE_ERROR_CODES.CONNECTION_TIMEOUT && details !== null && 'timeoutMs' in details
}

/** The partition of a batch from the state of each tree. */
function outcomeOf(state: readonly TreeState[]): FlowBulkOutcome {
  const indexes = (wanted: TreeState): number[] =>
    state.flatMap((s, i) => (s === wanted ? [i] : []))
  return {
    landed: indexes('landed'),
    failed: indexes('failed'),
    notStarted: indexes('pending'),
    unknown: [...indexes('running'), ...indexes('timedOut')].sort((a, b) => a - b),
  }
}

/**
 * Join the workers of a bulk add through `joinAll`, not `Promise.all`: a replaced static would settle
 * the join at once and report a batch that had not run. A worker never rejects, since it records its
 * failure in the closure state; the guard runs after the last await, and `finish` reads that state.
 */
async function joinWorkers(
  workers: readonly Promise<void>[],
  finish: () => JobNode[],
): Promise<JobNode[]> {
  await joinAll(workers)
  assertPrototypeClean()
  return finish()
}

/**
 * Add `flows` with `add`, at most `limit` at a time. After the first failure no further tree is
 * started; the ones in flight settle, and the batch then rejects.
 *
 * @param flows - The trees to add.
 * @param add - Adds one tree and rejects when it did not land.
 * @param operation - The public call, named in the failure.
 * @param limit - The most trees in flight at once.
 * @returns The running batch.
 */
export function runFlowBulk(
  flows: readonly FlowJob[],
  add: (flow: FlowJob) => Promise<JobNode>,
  operation: string,
  limit: number,
): FlowBulkRun {
  const state: TreeState[] = flows.map(() => 'pending')
  // Stryker disable next-line ArrayDeclaration: equivalent — the length is only a size hint; every index is assigned before the array is returned
  const nodes = new Array<JobNode>(flows.length)
  let next = 0
  let stopped = false
  let firstFailure: { error: unknown } | undefined
  const outcome = (): FlowBulkOutcome => outcomeOf(state)

  const worker = async (): Promise<void> => {
    for (
      let flow = flows[next];
      !stopped && firstFailure === undefined && flow;
      flow = flows[next]
    ) {
      const index = next
      next += 1
      state[index] = 'running'
      try {
        nodes[index] = await own(add(flow))
        state[index] = 'landed'
      } catch (error) {
        state[index] = answeredLate(error) ? 'timedOut' : 'failed'
        firstFailure ??= { error }
      }
    }
  }

  const done = joinWorkers(Array.from({ length: Math.min(limit, flows.length) }, worker), () => {
    if (firstFailure !== undefined) {
      throw batchFailure(operation, firstFailure.error, outcome())
    }
    return nodes
  })

  return {
    done,
    outcome,
    stop: () => {
      stopped = true
    },
  }
}

/**
 * The error a batch reports when its deadline passes while trees are in flight: `CONNECTION_TIMEOUT`
 * with the partition of the batch at that moment. The trees in flight are `unknown`, because they may
 * still land after the caller was told; a retry must carry a stable `jobId` for them.
 *
 * @param operation - The public call that timed out.
 * @param timeoutMs - The deadline that passed.
 * @param run - The running batch, read at the deadline.
 */
export function batchTimeout(
  operation: string,
  timeoutMs: number,
  run: FlowBulkRun,
): QueueException {
  run.stop()
  const base = timeoutException(operation, timeoutMs)
  const { details } = envelopeOf(base)
  const exception = new QueueException(
    QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
    HttpStatus.SERVICE_UNAVAILABLE,
    { ...details, ...run.outcome() },
  )
  return exception
}
