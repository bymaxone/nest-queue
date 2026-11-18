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

describe('assertFlowTree — a tree that is not well formed', () => {
  /** The reason a refusal gives, or `undefined` when the tree was accepted. */
  function reasonOf(flow: unknown): string | undefined {
    const refused = refusal(() => {
      assertFlowTree(flow as FlowJob, 'flow')
    })
    if (refused === undefined) return undefined
    expect(refused.code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
    expect(refused.status).toBe(HttpStatus.BAD_REQUEST)
    return (refused.details as { reason: string }).reason
  }
  const node = (extra: object = {}): FlowJob => ({ name: 'n', queueName: 'q', ...extra })

  it.each([
    ['null', null, 'null'],
    ['a string', SENTINEL, 'a string'],
    ['an array', [node()], 'an array'],
    ['a number', 7, '7'],
  ])('refuses a tree that is %s, naming it and the type', (_label, flow, got) => {
    expect(reasonOf(flow)).toBe(`flow must be an object, received ${got}`)
  })

  it.each([
    ['a string', SENTINEL, 'a string'],
    ['an object', { 0: node() }, 'an object'],
    ['a number', 3, '3'],
  ])('refuses children that are %s', (_label, children, got) => {
    expect(reasonOf(node({ children }))).toBe(`flow.children must be an array, received ${got}`)
  })

  it('refuses a child that is null, a string or an array, by its path', () => {
    expect(reasonOf(node({ children: [node(), null] }))).toBe(
      'flow.children[1] must be an object, received null',
    )
    expect(reasonOf(node({ children: [node({ children: [SENTINEL] })] }))).toBe(
      'flow.children[0].children[0] must be an object, received a string',
    )
    expect(reasonOf(node({ children: [[]] }))).toBe(
      'flow.children[0] must be an object, received an array',
    )
  })

  it.each([undefined, null, []])('accepts children that are %j', (children) => {
    expect(reasonOf(node({ children }))).toBeUndefined()
  })

  it('refuses a node that is its own ancestor, however far up, and a node that holds itself', () => {
    const root = node({ children: [] })
    const middle = node({ children: [root] })
    ;(root.children as FlowJob[]).push(middle)
    const self = node()
    self.children = [self]

    expect(reasonOf(root)).toBe('flow.children[0].children[0] repeats a node above it, a loop')
    expect(reasonOf(self)).toBe('flow.children[0] repeats a node above it, a loop')
  })

  it('accepts a node that appears twice without being its own ancestor', () => {
    const shared = node({ opts: { attempts: 2 } })

    expect(reasonOf(node({ children: [shared, shared] }))).toBeUndefined()
  })

  it('returns a copy of the tree, and leaves the one it was given as it was', () => {
    const grandchild = node({ opts: { attempts: 2 } })
    const flow = node({ children: [node({ children: [grandchild] })] })

    const copy = assertFlowTree(flow, 'flow')

    expect(copy).toEqual(flow)
    expect(copy).not.toBe(flow)
    expect(copy.children?.[0]).not.toBe(flow.children?.[0])
    expect(copy.children?.[0]?.children?.[0]?.opts).not.toBe(grandchild.opts)
  })

  it('reads each value of the tree once, so the copy is what was checked', () => {
    let reads = 0
    const opts = {
      get attempts(): number {
        reads += 1
        return reads === 1 ? 2 : -1
      },
    }
    const copy = assertFlowTree(node({ children: [node({ opts })] }), 'flow')

    expect(reads).toBe(1)
    expect(copy.children?.[0]?.opts?.attempts).toBe(2)
  })

  it('reads a children list once', () => {
    let reads = 0
    const flow = node()
    Object.defineProperty(flow, 'children', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? [node()] : [null]
      },
    })

    expect(assertFlowTree(flow, 'flow').children).toHaveLength(1)
    expect(reads).toBe(1)
  })
})

describe('assertJobInputs — the options are read once', () => {
  it('returns the copy that was checked, with the values of getters, own or inherited', () => {
    class Options {
      constructor(private readonly count: number) {}
      get attempts(): number {
        return this.count
      }
    }
    const copy = assertJobInputs(new Options(4), 'options') as { attempts: number }

    expect(copy.attempts).toBe(4)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
  })

  it('reads a getter one time, and reads the objects the options hold one time', () => {
    const reads = { attempts: 0, delay: 0, age: 0, id: 0 }
    const options = {
      get attempts(): number {
        reads.attempts += 1
        return reads.attempts === 1 ? 3 : -1
      },
      backoff: {
        type: 'fixed',
        get delay(): number {
          reads.delay += 1
          return reads.delay === 1 ? 10 : -1
        },
      },
      removeOnFail: {
        get age(): number {
          reads.age += 1
          return reads.age === 1 ? 5 : -1
        },
      },
      parent: {
        queue: 'q',
        get id(): string {
          reads.id += 1
          return reads.id === 1 ? 'p' : 'active'
        },
      },
    }

    const copy = assertJobInputs(options, 'options')

    expect(reads).toEqual({ attempts: 1, delay: 1, age: 1, id: 1 })
    expect(copy).toEqual({
      attempts: 3,
      backoff: { type: 'fixed', delay: 10 },
      removeOnFail: { age: 5 },
      parent: { queue: 'q', id: 'p' },
    })
  })

  it('keeps a key the caller set to undefined or null as it was given, and adds none it did not set', () => {
    const given: Record<string, unknown> = { delay: undefined, jobId: 'a' }
    const copy = assertJobInputs(given, 'options')

    expect(copy).toStrictEqual({ delay: undefined, jobId: 'a' })
    expect(Object.keys(assertJobInputs({}, 'options') ?? {})).toEqual([])
  })

  it.each([undefined, null])('passes %s through, as BullMQ takes it', (options) => {
    expect(assertJobInputs(options as undefined, 'options')).toBe(options)
  })

  it('keeps an own __proto__ key as a plain key, and never as the prototype of the copy', () => {
    const options = JSON.parse('{"__proto__":{"attempts":9},"jobId":"a"}') as JobsOptions

    const copy = assertJobInputs(options, 'options')!

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(copy.attempts).toBeUndefined()
    expect(Object.keys(copy).sort()).toEqual(['__proto__', 'jobId'])
  })
})

describe('assertJobInputs — objects that hold their values as inherited getters', () => {
  /** An object that answers `values` through getters on its prototype, as a class instance does. */
  function instanceOf(values: Record<string, unknown>): object {
    class Holder {}
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(Holder.prototype, key, { get: () => value, enumerable: false })
    }
    return new Holder()
  }
  const asOptions = (value: unknown): JobsOptions => value as JobsOptions
  const read = (options: object): Record<string, unknown> =>
    assertJobInputs(asOptions(options), 'options') as Record<string, unknown>

  it('reads the job id and the parent of an options class instance', () => {
    const copy = read(instanceOf({ jobId: 'a', parent: { id: 'p', queue: 'q' } }))

    expect(copy.jobId).toBe('a')
    expect(copy.parent).toEqual({ id: 'p', queue: 'q' })
  })

  it('reads each key of a backoff, a retention and a parent that is a class instance', () => {
    const copy = read({
      backoff: instanceOf({ type: 'exponential', delay: 10, jitter: 0.5 }),
      removeOnComplete: instanceOf({ age: 5, count: 6 }),
      removeOnFail: instanceOf({ age: 7, count: 8 }),
      parent: instanceOf({ id: 'p', queue: 'q' }),
    })

    expect(copy).toEqual({
      backoff: { type: 'exponential', delay: 10, jitter: 0.5 },
      removeOnComplete: { age: 5, count: 6 },
      removeOnFail: { age: 7, count: 8 },
      parent: { id: 'p', queue: 'q' },
    })
  })

  it('refuses a bad value that a getter holds in a nested object', () => {
    expect(
      refusal(() =>
        assertJobInputs(asOptions({ removeOnFail: instanceOf({ count: -1 }) }), 'options'),
      ),
    ).toMatchObject({ code: QUEUE_ERROR_CODES.INVALID_OPTIONS })
  })

  it('hands back a copy that can be changed and whose keys can be removed', () => {
    const copy = assertJobInputs({ attempts: 2, delay: 5 }, 'options') as Record<string, unknown>

    copy.attempts = 9
    delete copy.delay

    expect(copy).toEqual({ attempts: 9 })
  })

  it('copies an empty children list as an empty list', () => {
    expect(assertFlowTree({ name: 'n', queueName: 'q', children: [] }, 'flow').children).toEqual([])
  })

  it('gives a tree node without options no options key', () => {
    const copy = assertFlowTree({ name: 'n', queueName: 'q' }, 'flow')

    expect('opts' in copy).toBe(false)
  })
})
