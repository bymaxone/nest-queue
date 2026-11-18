/**
 * @fileoverview Unit tests for the checks a call runs on its job options and ids before BullMQ is
 * asked anything: every node of a flow tree, `enqueue` and the jobs of a bulk. BullMQ's flow producer
 * resolves with the node of a child it could not store, so a bad option on a child must be refused
 * here, naming the node, with nothing sent. A table runs the bad values through each option of each
 * place.
 * @layer server/utils
 */

import { HttpStatus } from '@nestjs/common'
import type { FlowJob, JobsOptions } from 'bullmq'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { assertFlowTree, assertJobInputs } from './assert-job-inputs'

const SENTINEL = 'SENTINEL-4c1e-do-not-echo'

/** What a call rejected with, as status, code and details, or `undefined` when it accepted. */
function refusal(work: () => void): { status: number; code: string; details: unknown } | undefined {
  try {
    work()
  } catch (err) {
    const exception = err as QueueException
    const { error } = exception.getResponse() as { error: { code: string; details: unknown } }
    return { status: exception.getStatus(), code: error.code, details: error.details }
  }
  return undefined
}

/** The bad values of a numeric option, with how a refusal describes each. */
const BAD: [string, unknown, string][] = [
  ['Infinity', Infinity, 'a number that is not finite'],
  ['NaN', NaN, 'a number that is not finite'],
  ['-1', -1, '-1'],
  ['1.5', 1.5, '1.5'],
  ['a sentinel string', SENTINEL, 'a string'],
]

/** Each numeric option, as the path under `opts` it is named by and how to set it. */
const OPTIONS: [string, (value: unknown) => JobsOptions][] = [
  ['delay', (value) => ({ delay: value }) as JobsOptions],
  ['attempts', (value) => ({ attempts: value }) as JobsOptions],
  ['priority', (value) => ({ priority: value }) as JobsOptions],
  ['backoff.delay', (value) => ({ backoff: { type: 'fixed', delay: value } }) as JobsOptions],
  ['removeOnFail.count', (value) => ({ removeOnFail: { count: value } }) as JobsOptions],
  ['removeOnComplete.age', (value) => ({ removeOnComplete: { age: value } }) as JobsOptions],
]

describe('assertJobInputs', () => {
  describe.each(OPTIONS)('options.%s', (path, build) => {
    it.each(BAD)(
      'refuses %s with a 400 INVALID_OPTIONS that names the option',
      (_l, value, got) => {
        const r = refusal(() => {
          assertJobInputs(build(value), 'options')
        })

        expect(r?.status).toBe(HttpStatus.BAD_REQUEST)
        expect(r?.code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
        const reason = (r?.details as { reason: string }).reason
        expect(reason).toContain(`options.${path}`)
        expect(reason).toContain(`received ${got}`)
        expect(reason).not.toContain(SENTINEL)
      },
    )

    it('accepts a whole number', () => {
      expect(
        refusal(() => {
          assertJobInputs(build(path === 'priority' ? 3 : 1000), 'options')
        }),
      ).toBeUndefined()
    })
  })

  it('accepts no options, a job id, and options it does not know', () => {
    expect(
      refusal(() => {
        assertJobInputs(undefined, 'options')
      }),
    ).toBeUndefined()
    expect(
      refusal(() => {
        assertJobInputs({ jobId: 'job-1', lifo: true }, 'options')
      }),
    ).toBeUndefined()
  })

  it('describes the refusal as invalid options, not as invalid module options', () => {
    let message: unknown
    try {
      assertJobInputs({ delay: Infinity }, 'options')
    } catch (err) {
      message = ((err as QueueException).getResponse() as { error: { message: string } }).error
        .message
    }

    expect(message).toBe('Invalid options')
  })

  it('names the path it is given', () => {
    const r = refusal(() => {
      assertJobInputs({ delay: Infinity }, 'jobs[3].options')
    })

    expect((r?.details as { reason: string }).reason).toContain('jobs[3].options.delay')
  })

  it('refuses a reserved job id and a reserved parent id without echoing either', () => {
    const id = refusal(() => {
      assertJobInputs({ jobId: 'active' }, 'options')
    })
    const parent = refusal(() => {
      assertJobInputs({ parent: { id: 'failed', queue: 'bull:q' } }, 'options')
    })

    expect(id).toMatchObject({
      code: QUEUE_ERROR_CODES.INVALID_JOB_ID,
      details: { field: 'jobId' },
    })
    expect(parent).toMatchObject({
      code: QUEUE_ERROR_CODES.INVALID_JOB_ID,
      details: { field: 'parent.id' },
    })
    expect(JSON.stringify([id, parent])).not.toMatch(/active|failed/)
  })
})

/** A three-level flow whose node at `where` carries `opts`. */
function tree(where: 'root' | 'child' | 'grandchild', opts: JobsOptions): FlowJob {
  const grandchild: FlowJob = {
    name: 'g',
    queueName: 'q',
    ...(where === 'grandchild' ? { opts } : {}),
  }
  const child: FlowJob = {
    name: 'c',
    queueName: 'q',
    ...(where === 'child' ? { opts } : {}),
    children: [{ name: 'sibling', queueName: 'q' }, grandchild],
  }
  return { name: 'r', queueName: 'q', ...(where === 'root' ? { opts } : {}), children: [child] }
}

describe('assertFlowTree', () => {
  it.each([
    ['root', 'flow.opts'],
    ['child', 'flow.children[0].opts'],
    ['grandchild', 'flow.children[0].children[1].opts'],
  ] as const)('refuses a bad option on the %s and names its path', (where, path) => {
    for (const [, value] of BAD) {
      const r = refusal(() => {
        assertFlowTree(tree(where, { delay: value } as JobsOptions), 'flow')
      })

      expect(r?.status).toBe(400)
      expect((r?.details as { reason: string }).reason).toContain(`${path}.delay`)
    }
  })

  it('refuses a reserved id or parent id on any node, however deep', () => {
    expect(
      refusal(() => {
        assertFlowTree(tree('grandchild', { jobId: 'wait' }), 'flow')
      })?.code,
    ).toBe(QUEUE_ERROR_CODES.INVALID_JOB_ID)
    expect(
      refusal(() => {
        assertFlowTree(tree('child', { parent: { id: 'id', queue: 'q' } }), 'flow')
      })?.code,
    ).toBe(QUEUE_ERROR_CODES.INVALID_JOB_ID)
  })

  it('accepts a tree whose options are sound', () => {
    expect(
      refusal(() => {
        assertFlowTree(tree('child', { delay: 10, attempts: 2 }), 'flow')
      }),
    ).toBeUndefined()
  })
})
