/**
 * @fileoverview Unit tests for adding flow trees one at a time with a bounded number in flight:
 * what is reported for every tree, which code a failure carries, and what a deadline that fires
 * mid-run leaves unknown. The add function is a stub, so only the bookkeeping is under test.
 * @layer server/utils
 */

import type { FlowJob, JobNode } from 'bullmq'
import { HttpStatus } from '@nestjs/common'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { storageFullException, timeoutException, unavailableException } from './command-timeout'
import { runFlowBulk } from './add-flow-trees'

/** A flow whose only identity is its position. */
function flows(count: number): FlowJob[] {
  return Array.from({ length: count }, (_, i) => ({ name: `f${String(i)}`, queueName: 'q' }))
}

/** The node a successful add of `flow` would return. */
function nodeOf(flow: FlowJob): JobNode {
  return { job: { id: flow.name } } as unknown as JobNode
}

/** A promise settled from outside, for stubs that must stay in flight. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The code, status and details of what a run rejected with. */
async function failureOf(work: Promise<unknown>): Promise<{
  code: string
  status: number
  details: Record<string, unknown>
  err: QueueException
}> {
  try {
    await work
  } catch (e) {
    const err = e as QueueException
    const { error } = err.getResponse() as {
      error: { code: string; details: Record<string, unknown> }
    }
    return { code: error.code, status: err.getStatus(), details: error.details, err }
  }
  throw new Error('the run did not reject')
}

describe('runFlowBulk', () => {
  it('resolves with every node in input order, and never has more than the limit in flight', async () => {
    let inFlight = 0
    let peak = 0
    const run = runFlowBulk(
      flows(120),
      async (flow) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => setImmediate(resolve))
        inFlight -= 1
        return nodeOf(flow)
      },
      'addFlowBulk',
      50,
    )

    const nodes = await run.done

    expect(nodes.map((n) => n.job.id)).toEqual(flows(120).map((f) => f.name))
    expect(peak).toBe(50)
    expect(run.outcome()).toEqual({
      landed: [...Array(120).keys()],
      failed: [],
      notStarted: [],
      unknown: [],
    })
  })

  it('resolves an empty batch to an empty list without calling add', async () => {
    const add = jest.fn()

    await expect(runFlowBulk([], add, 'addFlowBulk', 50).done).resolves.toEqual([])
    expect(add).not.toHaveBeenCalled()
  })

  it('starts no new tree after the first failure, and reports every index exactly once', async () => {
    const started: number[] = []
    const run = runFlowBulk(
      flows(10),
      (flow) => {
        const index = Number(flow.name.slice(1))
        started.push(index)
        return index === 3 ? Promise.reject(new Error('boom')) : Promise.resolve(nodeOf(flow))
      },
      'addFlowBulk',
      2,
    )

    const { code, status, details } = await failureOf(run.done)

    expect(code).toBe(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED)
    expect(status).toBe(500)
    expect(details).toMatchObject({ operation: 'addFlowBulk', failed: [3], unknown: [] })
    const landed = details.landed as number[]
    const notStarted = details.notStarted as number[]
    expect([...landed, 3, ...notStarted].sort((a, b) => a - b)).toEqual([...Array(10).keys()])
    // Nothing that was not started was ever handed to add.
    expect(started.sort((a, b) => a - b)).toEqual([...landed, 3].sort((a, b) => a - b))
    expect(notStarted.length).toBeGreaterThan(0)
  })

  it('lets the trees already in flight settle and reports them as landed or failed', async () => {
    const gates = [deferred<JobNode>(), deferred<JobNode>(), deferred<JobNode>()]
    const run = runFlowBulk(
      flows(6),
      (flow) => gates[Number(flow.name.slice(1))]?.promise ?? Promise.resolve(nodeOf(flow)),
      'addFlowBulk',
      3,
    )
    const settled = failureOf(run.done)

    gates[1]?.reject(new Error('boom'))
    gates[0]?.resolve(nodeOf({ name: 'f0', queueName: 'q' }))
    gates[2]?.reject(new Error('also'))
    const { details } = await settled

    expect(details).toMatchObject({
      landed: [0],
      failed: [1, 2],
      notStarted: [3, 4, 5],
      unknown: [],
    })
  })

  it('keeps the code and status of a failure that already has them, and the first cause', async () => {
    const full = storageFullException('addFlow', new Error('OOM command not allowed'))
    const run = runFlowBulk(flows(3), () => Promise.reject(full), 'addFlowBulk', 1)

    const { code, status, details, err } = await failureOf(run.done)

    expect(code).toBe(QUEUE_ERROR_CODES.STORAGE_FULL)
    expect(status).toBe(503)
    expect(details).toMatchObject({
      operation: 'addFlowBulk',
      reason: 'out_of_memory',
      landed: [],
      failed: [0],
      notStarted: [1, 2],
      unknown: [],
    })
    expect(err.cause).toBe(full)
    expect(JSON.stringify(err.getResponse())).not.toMatch(/OOM command/)
  })

  it('reports the trees still in flight as unknown, never failed, once stopped', async () => {
    const gates = [deferred<JobNode>(), deferred<JobNode>()]
    const add = jest.fn(
      (flow: FlowJob) =>
        gates[Number(flow.name.slice(1))]?.promise ?? Promise.resolve(nodeOf(flow)),
    )
    const run = runFlowBulk(flows(5), add, 'addFlowBulk', 2)
    run.done.catch(() => undefined)

    run.stop()
    gates[0]?.resolve(nodeOf({ name: 'f0', queueName: 'q' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(run.outcome()).toEqual({ landed: [0], failed: [], notStarted: [2, 3, 4], unknown: [1] })
    expect(add).toHaveBeenCalledTimes(2)
    gates[1]?.reject(new Error('late'))
  })
  it('reports a tree whose command timed out as unknown, since Redis may still apply it', async () => {
    const timedOut = timeoutException('addFlow', 5000, new Error('Command timed out'))
    const run = runFlowBulk(
      flows(3),
      (flow) => (flow.name === 'f1' ? Promise.reject(timedOut) : Promise.resolve(nodeOf(flow))),
      'addFlowBulk',
      3,
    )

    const { code, details } = await failureOf(run.done)

    expect(code).toBe(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT)
    expect(details).toMatchObject({ landed: [0, 2], failed: [], notStarted: [], unknown: [1] })
  })

  it('reports a tree refused because the connection was down as failed, since nothing was sent', async () => {
    const offline = unavailableException('addFlow', new Error("Stream isn't writeable"))
    const run = runFlowBulk(
      flows(2),
      (flow) => (flow.name === 'f0' ? Promise.reject(offline) : Promise.resolve(nodeOf(flow))),
      'addFlowBulk',
      2,
    )

    const { code, details } = await failureOf(run.done)

    expect(code).toBe(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT)
    expect(details).toMatchObject({ landed: [1], failed: [0], notStarted: [], unknown: [] })
  })
  it.each([
    [
      'a timeout code with no details',
      new QueueException(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, HttpStatus.SERVICE_UNAVAILABLE),
    ],
    [
      'another code that carries a timeoutMs',
      new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.BAD_REQUEST, {
        timeoutMs: 1,
      }),
    ],
    ['a full Redis', storageFullException('addFlow', new Error('OOM command not allowed'))],
    ['a plain error with a timeoutMs property', Object.assign(new Error('x'), { timeoutMs: 1 })],
  ])('reports a tree that failed with %s as failed, not unknown', async (_kind, error) => {
    const run = runFlowBulk(flows(1), () => Promise.reject(error), 'addFlowBulk', 1)

    await run.done.catch(() => undefined)

    expect(run.outcome()).toEqual({ landed: [], failed: [0], notStarted: [], unknown: [] })
  })

  it('lists the unknown trees in index order, whether they are in flight or timed out', async () => {
    const timedOut = timeoutException('addFlow', 5000)
    const never = new Promise<JobNode>(() => undefined)
    const run = runFlowBulk(
      flows(3),
      (flow) => (flow.name === 'f2' ? never : Promise.reject(timedOut)),
      'addFlowBulk',
      3,
    )

    // The tree that never answers keeps the batch open, so let the two rejections settle instead.
    await new Promise<void>((resolve) => setImmediate(resolve))
    run.stop()

    expect(run.outcome()).toEqual({ landed: [], failed: [], notStarted: [], unknown: [0, 1, 2] })
  })

  it('puts every tree in exactly one list, and hands to add exactly the trees that are not notStarted', async () => {
    // The invariant over many shapes: batch size, limit, which tree fails and how it fails.
    const failures: [string, () => unknown][] = [
      ['a refusal', () => new Error('refused')],
      ['a timeout', () => timeoutException('addFlow', 5000)],
      ['a connection that was down', () => unavailableException('addFlow', new Error('down'))],
    ]
    for (const size of [0, 1, 2, 5, 9]) {
      for (const limit of [1, 2, 3, 50]) {
        for (const failAt of [-1, 0, 1, size - 1]) {
          for (const [kind, make] of failures) {
            const handed: number[] = []
            const run = runFlowBulk(
              flows(size),
              async (flow) => {
                const index = Number(flow.name.slice(1))
                handed.push(index)
                if (index % 2 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
                if (index === failAt) throw make()
                return nodeOf(flow)
              },
              'addFlowBulk',
              limit,
            )

            await run.done.catch(() => undefined)

            const { landed, failed, notStarted, unknown } = run.outcome()
            const where = `size ${String(size)}, limit ${String(limit)}, ${kind} at ${String(failAt)}`
            const all = [...landed, ...failed, ...notStarted, ...unknown].sort((a, b) => a - b)
            expect({ where, all }).toEqual({ where, all: [...Array(size).keys()] })
            expect({ where, handed: [...handed].sort((a, b) => a - b) }).toEqual({
              where,
              handed: [...landed, ...failed, ...unknown].sort((a, b) => a - b),
            })
            // A tree that reported a timeout is unknown, never failed.
            expect({ where, bad: kind === 'a timeout' ? failed : [] }).toEqual({ where, bad: [] })
          }
        }
      }
    }
  })
})
