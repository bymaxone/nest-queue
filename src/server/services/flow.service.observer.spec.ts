/**
 * @fileoverview Unit tests for how `FlowService` hands a tree to the observers: each tree is added
 * inside their enqueue span, the headers they write are stored on every node, and BullMQ's own
 * telemetry keeps its own. BullMQ's `FlowProducer` is mocked.
 * @layer server/services
 */

import { EventEmitter } from 'node:events'
import type { FlowJob, Telemetry } from 'bullmq'
import { FlowService } from './flow.service'
import { QueueObserverRegistry } from '../observability/queue-observer'
import type { ConnectionResolver } from './connection-resolver.service'

const producers: { add: jest.Mock }[] = []

jest.mock('bullmq', () => ({
  QueueKeys: jest.requireActual<{ QueueKeys: unknown }>('bullmq').QueueKeys,
  FlowProducer: jest.fn().mockImplementation(() => {
    const instance = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue({ job: { id: 'root' } }),
      close: jest.fn().mockResolvedValue(undefined),
    })
    producers.push(instance)
    return instance
  }),
}))

const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const metadata = JSON.stringify({ traceparent })

/** A flow service over a stub connection. */
function makeFlow(
  observers?: QueueObserverRegistry,
  telemetry?: Telemetry,
): { service: FlowService; producer: (typeof producers)[number] } {
  const connection = {
    getClient: jest.fn().mockReturnValue({ options: { commandTimeout: 5000 } }),
  } as unknown as ConnectionResolver
  const service = new FlowService(connection, true, 'bull', telemetry, 3000, observers)
  const producer = producers.at(-1)
  if (producer === undefined) throw new Error('no producer was created')
  return { service, producer }
}

/** A registry whose one observer writes `traceparent` and records what it is told. */
function writing(): { observers: QueueObserverRegistry; infos: unknown[] } {
  const observers = new QueueObserverRegistry()
  const infos: unknown[] = []
  observers.register({
    traceEnqueue: (info, carrier, run) => {
      infos.push(info)
      carrier.traceparent = traceparent
      return run()
    },
  })
  return { observers, infos }
}

/** A tree with a child. */
const tree = (): FlowJob => ({
  name: 'parent',
  queueName: 'orders',
  children: [{ name: 'child', queueName: 'stock' }],
})

beforeEach(() => {
  producers.length = 0
})

describe('FlowService — trees under observers', () => {
  it('adds a tree inside the span and stores the headers on every node', async () => {
    const { observers, infos } = writing()
    const { service, producer } = makeFlow(observers)

    await service.add(tree())

    expect(infos).toEqual([{ queue: 'orders', job: 'parent' }])
    const sent = (producer.add.mock.calls as unknown[][])[0]?.[0] as FlowJob
    expect(sent.opts).toEqual({ telemetry: { metadata } })
    expect(sent.children?.[0]?.opts).toEqual({ telemetry: { metadata } })
  })

  it('opens one span per tree of a bulk', async () => {
    const { observers, infos } = writing()
    const { service, producer } = makeFlow(observers)

    await service.addBulk([tree(), tree()])

    expect(infos).toHaveLength(2)
    expect(producer.add).toHaveBeenCalledTimes(2)
  })

  it('leaves the metadata to BullMQ when its own telemetry is configured, and still opens the span', async () => {
    const { observers, infos } = writing()
    const { service, producer } = makeFlow(observers, {} as unknown as Telemetry)

    await service.add(tree())

    expect(infos).toHaveLength(1)
    const sent = (producer.add.mock.calls as unknown[][])[0]?.[0] as FlowJob
    expect(sent.opts).toBeUndefined()
  })

  it('adds the tree as checked when no header was written or there is no registry', async () => {
    const quiet = makeFlow(new QueueObserverRegistry())
    await quiet.service.add(tree())
    const plain = makeFlow()
    await plain.service.add(tree())

    for (const { producer } of [quiet, plain]) {
      const sent = (producer.add.mock.calls as unknown[][])[0]?.[0] as FlowJob
      expect(sent.opts).toBeUndefined()
    }
  })
})
