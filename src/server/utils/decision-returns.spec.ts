/**
 * @fileoverview Unit tests that the paths which decide a result do not read a replaceable promise
 * operation after the guard has looked: the return of `withDeadline` and of `withCommandTimeoutCode`
 * is guarded after the last replaceable call, and the join of a bulk add does not go through the
 * `Promise.all` static.
 * @layer test
 */

import type { FlowJob, JobNode } from 'bullmq'
import { NativePromise } from '../connection/prototype-guard'
import { QueueException } from '../errors/queue-exception'
import { runFlowBulk } from './add-flow-trees'
import { withCommandTimeoutCode } from './command-timeout'
import { withDeadline } from './with-deadline'

/** A `then` on `Object.prototype` that erases itself when read and answers with a forged value. */
function plantForgedThen(): void {
  Object.defineProperty(Object.prototype, 'then', {
    configurable: true,
    get() {
      delete (Object.prototype as { then?: unknown }).then
      return (resolve: (value: unknown) => void) => {
        resolve({ id: 'FORGED' })
      }
    },
  })
}

/** What a settled call came to, recorded without returning an object through a promise. */
interface Seen {
  value?: unknown
  error?: unknown
}

/** Run `call` to settlement, recording the outcome in a holder and clearing the plant first. */
async function settle(call: Promise<unknown>): Promise<Seen> {
  const seen: Seen = {}
  try {
    seen.value = await call
  } catch (error) {
    seen.error = error
  } finally {
    clearPlant()
  }
  return seen
}

/** Remove the plant if nothing read it. */
function clearPlant(): void {
  delete (Object.prototype as { then?: unknown }).then
}

describe('withDeadline', () => {
  it('refuses a then planted while it releases its timer, instead of resolving with the forgery', async () => {
    const realClear = globalThis.clearTimeout
    const work = NativePromise.resolve({ id: 'real-job' })
    globalThis.clearTimeout = (timer: Parameters<typeof clearTimeout>[0]) => {
      globalThis.clearTimeout = realClear
      plantForgedThen()
      realClear(timer)
    }
    try {
      const seen = await settle(withDeadline(work, 1000, () => new Error('deadline')))

      expect(seen.value).toBeUndefined()
      expect(seen.error).toBeInstanceOf(QueueException)
    } finally {
      globalThis.clearTimeout = realClear
      clearPlant()
    }
  })
})

describe('withCommandTimeoutCode', () => {
  it('refuses a then planted while the command settles, instead of resolving with the forgery', async () => {
    let resolveWork: (value: { id: string }) => void = () => undefined
    const work = new NativePromise<{ id: string }>((resolve) => {
      resolveWork = resolve
    })
    const run = withCommandTimeoutCode('op', () => 1, work)
    resolveWork({ id: 'real-job' })
    plantForgedThen()
    try {
      const seen = await settle(run)

      expect(seen.value).toBeUndefined()
      expect(seen.error).toBeInstanceOf(QueueException)
    } finally {
      clearPlant()
    }
  })
})

describe('runFlowBulk', () => {
  it('waits for the trees when Promise.all is replaced by one that settles at once', async () => {
    const realAll = Promise.all
    let release: () => void = () => undefined
    const gate = new NativePromise<void>((resolve) => {
      release = resolve
    })
    const tree = (flow: FlowJob): JobNode => ({ job: { id: flow.name } }) as unknown as JobNode
    Promise.all = () => NativePromise.resolve([])
    try {
      const run = runFlowBulk(
        [{ name: 'a', queueName: 'q' }],
        async (flow) => {
          await gate
          return tree(flow)
        },
        'addFlowBulk',
        1,
      )
      release()
      const nodes = await run.done

      expect(nodes.map((n) => n.job.id)).toEqual(['a'])
    } finally {
      Promise.all = realAll
    }
  })
})
