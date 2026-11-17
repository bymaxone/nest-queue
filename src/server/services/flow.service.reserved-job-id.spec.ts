/**
 * @fileoverview Unit tests for how `FlowService` treats a job id that is one of the queue's own
 * Redis key names: the root and every descendant of a tree are checked before the producer is
 * called. BullMQ's `FlowProducer` is mocked, so what is pinned is that nothing reaches it.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { FlowJob } from 'bullmq'
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

/** A flow whose root, child and grandchild carry the given ids. */
function tree(root: string, child: string, grandchild: string): FlowJob {
  return {
    name: 'root',
    queueName: 'q',
    data: {},
    opts: { jobId: root },
    children: [
      {
        name: 'child',
        queueName: 'q',
        data: {},
        opts: { jobId: child },
        children: [{ name: 'leaf', queueName: 'q', data: {}, opts: { jobId: grandchild } }],
      },
    ],
  }
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

describe('FlowService — a job id that is one of the queue keys', () => {
  it.each([
    ['the root', tree('active', 'b', 'c')],
    ['a child', tree('a', 'failed', 'c')],
    ['a grandchild', tree('a', 'b', 'id')],
  ])(
    'add refuses a tree whose %s has such an id, before the producer is called',
    async (_where, flow) => {
      const { service, producer } = makeFlow()

      const err = await rejection(() => service.add(flow))

      expect(err.getStatus()).toBe(400)
      const { error } = err.getResponse() as { error: { code: string; details: unknown } }
      expect(error).toMatchObject({
        code: QUEUE_ERROR_CODES.INVALID_JOB_ID,
        details: { field: 'jobId' },
      })
      expect(producer.add).not.toHaveBeenCalled()
    },
  )

  it('addBulk refuses the whole batch when one tree has such an id, and calls nothing', async () => {
    const { service, producer } = makeFlow()

    const err = await rejection(() =>
      service.addBulk([tree('a', 'b', 'c'), tree('a', 'b', 'wait')]),
    )

    expect(err.getStatus()).toBe(400)
    expect(producer.add).not.toHaveBeenCalled()
  })

  it('still adds a tree whose ids are ordinary', async () => {
    const { service, producer } = makeFlow()

    await service.add(tree('a', 'b', 'c'))
    await service.addBulk([tree('d', 'e', 'f')])

    // One call for the single add and one for the tree of the bulk.
    expect(producer.add).toHaveBeenCalledTimes(2)
  })
  it.each(['add', 'addBulk'] as const)(
    'answers FLOW_DISABLED (503) from %s, whatever the ids, when flows are not enabled',
    async (method) => {
      // The disabled guard comes first, so the answer never depends on what was submitted.
      const connection = {
        getClient: jest.fn().mockReturnValue({ options: {} }),
      } as unknown as ConnectionResolver
      const service = new FlowService(connection, false, 'bull')
      const flow = tree('active', 'failed', 'id')

      const err = await rejection(() =>
        method === 'add' ? service.add(flow) : service.addBulk([flow]),
      )

      expect(err.getStatus()).toBe(503)
      const { error } = err.getResponse() as { error: { code: string } }
      expect(error.code).toBe(QUEUE_ERROR_CODES.FLOW_DISABLED)
    },
  )
})
