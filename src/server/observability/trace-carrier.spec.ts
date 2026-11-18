/**
 * @fileoverview Unit tests for how the trace headers travel with a job: stored in
 * `opts.telemetry.metadata` as JSON when an observer wrote some, never over metadata that is already
 * there, and read back only as the two W3C headers in a bounded length.
 * @layer server/observability
 */

import type { FlowJob } from 'bullmq'
import { readTraceMetadata, stampFlow, withTraceMetadata } from './trace-carrier'

const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

describe('withTraceMetadata', () => {
  it('returns the options as they are when the carrier is empty', () => {
    const options = { attempts: 2 }

    expect(withTraceMetadata(options, {})).toBe(options)
    expect(withTraceMetadata(undefined, {})).toBeUndefined()
  })

  it('stores the headers as JSON in the metadata of a copy, keeping the other options', () => {
    const options = { attempts: 2, telemetry: { omitContext: true } }

    const stamped = withTraceMetadata(options, { traceparent })

    expect(stamped).toEqual({
      attempts: 2,
      telemetry: { omitContext: true, metadata: JSON.stringify({ traceparent }) },
    })
    expect(options).toEqual({ attempts: 2, telemetry: { omitContext: true } })
  })

  it('creates the options of a job that gave none', () => {
    expect(withTraceMetadata(undefined, { traceparent })).toEqual({
      telemetry: { metadata: JSON.stringify({ traceparent }) },
    })
  })

  it('keeps metadata that is already there', () => {
    const options = { telemetry: { metadata: 'theirs' } }

    expect(withTraceMetadata(options, { traceparent })).toBe(options)
  })
})

describe('readTraceMetadata', () => {
  it('reads the two W3C headers back', () => {
    const metadata = JSON.stringify({ traceparent, tracestate: 'a=b' })

    expect(readTraceMetadata(metadata)).toEqual({ traceparent, tracestate: 'a=b' })
  })

  it.each([
    ['undefined', undefined],
    ['a number', 7],
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '"text"'],
    ['null', 'null'],
    ['an array', '[1]'],
    ['an object that merely prints as JSON', { toString: () => JSON.stringify({ traceparent }) }],
    ['an array of headers', JSON.stringify([{ traceparent }])],
    ['an object without the headers', '{"other":"x"}'],
  ])('reads nothing from %s', (_label, metadata) => {
    expect(readTraceMetadata(metadata)).toEqual({})
  })

  it('ignores a header that is not a string, one that is too long, and any other key', () => {
    const metadata = JSON.stringify({
      traceparent: 5,
      tracestate: 'x'.repeat(513),
      baggage: 'k=v',
    })

    expect(readTraceMetadata(metadata)).toEqual({})
  })

  it('accepts a header of exactly the longest length', () => {
    const tracestate = 'x'.repeat(512)

    expect(readTraceMetadata(JSON.stringify({ tracestate }))).toEqual({ tracestate })
  })
})

/** A tree typed as a plain `FlowJob`, so its optional fields are read as optional. */
function asFlow(flow: FlowJob): FlowJob {
  return flow
}

describe('stampFlow', () => {
  const carrier = { traceparent }
  const metadata = JSON.stringify(carrier)

  it('does nothing when the carrier is empty', () => {
    const flow: FlowJob = { name: 'r', queueName: 'q' }

    stampFlow(flow, {})

    expect(flow).toEqual({ name: 'r', queueName: 'q' })
  })

  it('stores the headers on every node that has no metadata, however deep', () => {
    const own: FlowJob = { name: 'c2', queueName: 'q', opts: { telemetry: { metadata: 'mine' } } }
    const flow = asFlow({
      name: 'r',
      queueName: 'q',
      children: [{ name: 'c1', queueName: 'q', children: [own] }, own],
    })

    stampFlow(flow, carrier)

    expect(flow.opts).toEqual({ telemetry: { metadata } })
    expect(flow.children?.[0]?.opts).toEqual({ telemetry: { metadata } })
    expect(own.opts).toEqual({ telemetry: { metadata: 'mine' } })
  })

  it('stamps a node with more children than a call can take as arguments', () => {
    const child: FlowJob = { name: 'c', queueName: 'q' }
    const flow: FlowJob = {
      name: 'r',
      queueName: 'q',
      children: Array.from({ length: 150_000 }, () => child),
    }

    expect(() => {
      stampFlow(flow, carrier)
    }).not.toThrow()
    expect(child.opts).toEqual({ telemetry: { metadata } })
  })

  it('visits a node that several parents share once', () => {
    const shared: FlowJob = { name: 's', queueName: 'q' }
    let reads = 0
    const flow: FlowJob = {
      name: 'r',
      queueName: 'q',
      children: [
        { name: 'a', queueName: 'q', children: [shared] },
        { name: 'b', queueName: 'q', children: [shared] },
      ],
    }
    Object.defineProperty(shared, 'opts', {
      configurable: true,
      get: () => {
        reads += 1
        return undefined
      },
      set: () => undefined,
    })

    stampFlow(flow, carrier)

    expect(reads).toBe(1)
  })
})
