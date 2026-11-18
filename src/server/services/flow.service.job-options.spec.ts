/**
 * @fileoverview Unit tests for the job options `FlowService` refuses before the producer is called:
 * BullMQ's flow producer resolves with the node of a child it could not store, so a bad option on a
 * child or a grandchild, or on the second tree of a bulk, is refused here, naming the node, with
 * nothing sent for any tree. BullMQ's `FlowProducer` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { FlowJob, JobsOptions } from 'bullmq'
import { FlowService } from './flow.service'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { ConnectionResolver } from './connection-resolver.service'

const producers: { add: jest.Mock; addBulk: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  FlowProducer: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue({ job: { id: 'root' } }),
      addBulk: jest.fn().mockResolvedValue([]),
      close: jest.fn().mockResolvedValue(undefined),
    })
    producers.push(instance)
    return instance
  }),
}))

/** A flow service and its mocked producer. */
function makeFlow(): { service: FlowService; producer: (typeof producers)[number] } {
  const connection = {
    getClient: jest.fn().mockReturnValue({ options: { commandTimeout: 5000 } }),
  } as unknown as ConnectionResolver
  const service = new FlowService(connection, true, 'bull', undefined, 3000)
  const producer = producers.at(-1)
  if (producer === undefined) throw new Error('no producer was created')
  return { service, producer }
}

/** Run `work` and return what it rejected with. */
async function rejection(work: () => Promise<unknown>): Promise<QueueException> {
  try {
    await work()
  } catch (err) {
    return err as QueueException
  }
  throw new Error('the call did not reject')
}

beforeEach(() => {
  producers.length = 0
})

/** A flow with a child and a grandchild, the given options on the grandchild. */
function deep(opts: JobsOptions): FlowJob {
  return {
    name: 'r',
    queueName: 'q',
    children: [{ name: 'c', queueName: 'q', children: [{ name: 'g', queueName: 'q', opts }] }],
  }
}

describe('FlowService — job options BullMQ would not honour', () => {
  it.each([Infinity, NaN, -1])(
    'add refuses a child with a delay of %j and sends nothing',
    async (delay) => {
      const { service, producer } = makeFlow()

      const err = await rejection(() => service.add(deep({ delay })))

      expect(err.getStatus()).toBe(400)
      const { error } = err.getResponse() as {
        error: { code: string; details: { reason: string } }
      }
      expect(error.code).toBe(QUEUE_ERROR_CODES.INVALID_OPTIONS)
      expect(error.details.reason).toContain('flow.children[0].children[0].opts.delay')
      expect(producer.add).not.toHaveBeenCalled()
    },
  )

  it('addBulk refuses the batch when the second tree has a bad option, and no tree is sent', async () => {
    const { service, producer } = makeFlow()

    const err = await rejection(() =>
      service.addBulk([deep({ delay: 10 }), deep({ attempts: NaN })]),
    )

    const { error } = err.getResponse() as { error: { details: { reason: string } } }
    expect(error.details.reason).toContain('flows[1].children[0].children[0].opts.attempts')
    expect(producer.add).not.toHaveBeenCalled()
  })

  it('still adds a tree whose options are sound', async () => {
    const { service, producer } = makeFlow()

    await service.add(deep({ delay: 10, attempts: 2 }))

    expect(producer.add).toHaveBeenCalledTimes(1)
  })
})

describe('FlowService — the tree that was checked is the tree that is sent', () => {
  /** A tree whose grandchild has `attempts` that answer 3 the first time and -1 after. */
  function flipping(): FlowJob {
    let reads = 0
    return deep({
      get attempts(): number {
        reads += 1
        return reads === 1 ? 3 : -1
      },
    })
  }
  const grandchildOpts = (tree: unknown): JobsOptions | undefined =>
    (tree as FlowJob).children?.[0]?.children?.[0]?.opts

  it('add sends a copy of the tree', async () => {
    const { service, producer } = makeFlow()
    const given = flipping()

    await service.add(given)

    const sent = (producer.add.mock.calls as unknown[][])[0]?.[0] as FlowJob
    expect(sent).not.toBe(given)
    expect(grandchildOpts(sent)?.attempts).toBe(3)
    expect(grandchildOpts(sent)?.attempts).toBe(3)
  })

  it('addBulk sends a copy of every tree', async () => {
    const { service, producer } = makeFlow()

    await service.addBulk([flipping(), flipping()])

    expect(producer.add).toHaveBeenCalledTimes(2)
    for (const call of producer.add.mock.calls as unknown[][]) {
      expect(grandchildOpts(call[0])?.attempts).toBe(3)
    }
  })

  it.each(['x', { 0: {} }])(
    'add refuses children that are %j before any call',
    async (children) => {
      const { service, producer } = makeFlow()

      const err = await rejection(() =>
        service.add({ name: 'r', queueName: 'q', children } as unknown as FlowJob),
      )

      expect(err.getStatus()).toBe(400)
      expect(producer.add).not.toHaveBeenCalled()
    },
  )
})
