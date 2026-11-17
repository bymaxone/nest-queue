/**
 * @fileoverview What a call checks on the options and ids of its jobs before BullMQ is asked
 * anything. BullMQ's flow producer resolves with the node of a child it could not store (a child
 * with `delay: Infinity` is dropped while its parent is added and runs without it), so every node of
 * a tree is checked here, with the same rules as the module's default job options.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import type { FlowJob, JobsOptions } from 'bullmq'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import { jobOptionsProblem } from './job-defaults-problem'
import { assertJobIdAllowed } from './reserved-job-ids'

/**
 * Refuse a job whose options hold a value BullMQ would drop, fail on, or read as "no limit", and a
 * job id or parent id that is one of the queue's own keys, naming the option and never echoing a
 * value that is not a finite number.
 *
 * @param options - The options of one job, as the caller gave them.
 * @param path - What to call them in a refusal, such as `options` or `jobs[3].options`.
 * @throws {QueueException} `INVALID_OPTIONS` (400) for a bad option, `INVALID_JOB_ID` (400) for a
 *   reserved `jobId` or `parent.id`.
 */
export function assertJobInputs(options: JobsOptions | undefined, path: string): void {
  const problem = jobOptionsProblem(options, path)
  if (problem !== undefined) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.BAD_REQUEST, {
      reason: problem,
    })
  }
  assertJobIdAllowed(options?.jobId)
  assertJobIdAllowed(options?.parent?.id, 'parent.id')
}

/** A node still to check, with the path that names it. */
interface PendingNode {
  readonly node: FlowJob
  readonly path: string
}

/**
 * Apply {@link assertJobInputs} to a flow tree: the root and every descendant, however deep, each
 * named by its path (`flow.children[0].children[1].opts`). The walk is iterative, so a deep tree
 * cannot overflow the stack.
 *
 * @param flow - The root of a flow tree.
 * @param path - What to call the root in a refusal, such as `flow` or `flows[2]`.
 * @throws {QueueException} As {@link assertJobInputs}, for any node of the tree.
 */
export function assertFlowTree(flow: FlowJob, path: string): void {
  const pending: PendingNode[] = [{ node: flow, path }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    assertJobInputs(next.node.opts, `${next.path}.opts`)
    const children = next.node.children ?? []
    children.forEach((child, index) => {
      pending.push({ node: child, path: `${next.path}.children[${String(index)}]` })
    })
  }
}
