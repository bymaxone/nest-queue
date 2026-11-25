/**
 * @fileoverview Unit tests that each field of a flow node the library copies by name is read when
 * the host defines it as a getter on a class prototype, as a class instance does. Each name has a
 * row of its own, so a name dropped from the list the copy reads fails exactly one row.
 * @layer server/utils
 */

import type { FlowJob } from 'bullmq'
import { assertFlowTree } from './assert-job-inputs'

/** A node with no own field, whose `name` is a getter on its class prototype. */
function nodeWith(name: string, value: unknown): FlowJob {
  class Node {}
  Object.defineProperty(Node.prototype, name, { get: () => value, configurable: true })
  return new Node() as unknown as FlowJob
}

describe('the fields of a flow node that are getters on a class prototype', () => {
  it.each([
    ['name', 'job'],
    ['queueName', 'q'],
    ['data', { a: 1 }],
    ['prefix', 'p'],
    ['opts', { attempts: 2 }],
    ['children', []],
  ])('reads %s', (name, value) => {
    const copy = assertFlowTree(nodeWith(name, value), 'flow') as unknown as Record<string, unknown>

    expect(copy[name]).toEqual(value)
  })
})
