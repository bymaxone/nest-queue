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
import { readKeys, snapshotJobOptions } from '../config/snapshot-options'
import { jobOptionsProblem, received } from './job-defaults-problem'
import { assertJobIdAllowed } from './reserved-job-ids'

/** Refuse with `INVALID_OPTIONS` (400), carrying the reason and nothing the caller sent. */
function invalid(reason: string): never {
  throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.BAD_REQUEST, { reason })
}

/** Check one job's already-read options: the values and the ids. */
function checkJobInputs(options: JobsOptions | undefined, path: string): void {
  const problem = jobOptionsProblem(options, path)
  if (problem !== undefined) invalid(problem)
  assertJobIdAllowed(options?.jobId)
  assertJobIdAllowed(options?.parent?.id, 'parent.id')
}

/**
 * Read the options of one job once and refuse a value BullMQ would drop, fail on, or read as "no
 * limit", and a job id or parent id that is one of the queue's own keys, naming the option and never
 * echoing a value that is not a finite number.
 *
 * @param options - The options of one job, as the caller gave them.
 * @param path - What to call them in a refusal, such as `options` or `jobs[3].options`.
 * @returns The copy that was checked. Send this, not `options`: a getter can answer differently on
 *   a second read.
 * @throws {QueueException} `INVALID_OPTIONS` (400) for a bad option, `INVALID_JOB_ID` (400) for a
 *   reserved `jobId` or `parent.id`.
 */
export function assertJobInputs(
  options: JobsOptions | undefined,
  path: string,
): JobsOptions | undefined {
  const copy = snapshotJobOptions(options)
  checkJobInputs(copy, path)
  return copy
}

/** The keys of a flow node BullMQ reads. */
const FLOW_NODE_KEYS = ['name', 'queueName', 'data', 'prefix', 'opts', 'children'] as const

/** A node still to check, with the path that names it, the node that holds it, and where its copy goes. */
interface PendingNode {
  readonly node: unknown
  readonly path: string
  readonly up: PendingNode | undefined
  readonly place: (copy: FlowJob) => void
}

/** Whether `node` is one of the nodes above `pending`, which would make the tree loop. */
function isAbove(pending: PendingNode, node: unknown): boolean {
  for (let above = pending.up; above !== undefined; above = above.up) {
    if (above.node === node) return true
  }
  return false
}

/**
 * Read a flow tree once and apply {@link assertJobInputs} to the root and every descendant, however
 * deep, each named by its path (`flow.children[0].children[1].opts`). A node that is not an object,
 * `children` that is not an array, and a node that is its own ancestor are refused: BullMQ would
 * walk a loop without end. The walk is iterative, so a deep tree cannot overflow the stack.
 *
 * @param flow - The root of a flow tree.
 * @param path - What to call the root in a refusal, such as `flow` or `flows[2]`.
 * @returns The copy of the tree that was checked. Send this, not `flow`.
 * @throws {QueueException} As {@link assertJobInputs}, for any node of the tree, and
 *   `INVALID_OPTIONS` (400) for a malformed tree.
 */
export function assertFlowTree(flow: FlowJob, path: string): FlowJob {
  let root: FlowJob | undefined
  const pending: PendingNode[] = [
    {
      node: flow,
      path,
      up: undefined,
      place: (copy) => {
        root = copy
      },
    },
  ]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.node !== 'object' || next.node === null || Array.isArray(next.node)) {
      invalid(`${next.path} must be an object, received ${received(next.node)}`)
    }
    if (isAbove(next, next.node)) invalid(`${next.path} repeats a node above it, a loop`)
    const copy = readKeys(next.node as FlowJob, FLOW_NODE_KEYS)
    const options = snapshotJobOptions(copy.opts)
    checkJobInputs(options, `${next.path}.opts`)
    if (options !== undefined) copy.opts = options
    next.place(copy)
    const children: unknown = copy.children
    if (children === undefined || children === null) continue
    if (!Array.isArray(children)) {
      invalid(`${next.path}.children must be an array, received ${received(children)}`)
    }
    const placed: FlowJob[] = []
    copy.children = placed
    for (let index = 0; index < children.length; index += 1) {
      pending.push({
        node: children[index] as unknown,
        path: `${next.path}.children[${String(index)}]`,
        up: next,
        place: (child) => {
          placed[index] = child
        },
      })
    }
  }
  return root as unknown as FlowJob
}
