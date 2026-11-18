/**
 * @fileoverview Moves the W3C trace context between an enqueue and the worker that processes the job.
 * BullMQ keeps `opts.telemetry.metadata` with the job, apart from its data, as a string; the carrier
 * is stored there as JSON and read back with the same strict shape, so a value some other writer put
 * in that field is ignored instead of handed to a propagator.
 * @layer server/observability
 */

import type { FlowJob, JobsOptions } from 'bullmq'
import type { TraceCarrier } from './queue-observer'

/** The headers of the W3C trace context, the only keys the carrier holds. */
const CARRIER_KEYS: readonly string[] = ['traceparent', 'tracestate']

/** The longest a header may be: `tracestate` is limited to 512 characters by the specification. */
const MAX_HEADER_LENGTH = 512

/** Whether the options already carry telemetry metadata, which BullMQ's own telemetry or the caller put there. */
function hasMetadata(options: JobsOptions | undefined): boolean {
  return options?.telemetry?.metadata !== undefined
}

/** A copy of the options that carries the headers as the telemetry metadata. */
function stamped(options: JobsOptions | undefined, carrier: Readonly<TraceCarrier>): JobsOptions {
  return { ...options, telemetry: { ...options?.telemetry, metadata: JSON.stringify(carrier) } }
}

/**
 * The options of a job with the trace headers stored in `telemetry.metadata`. A job that already
 * carries metadata keeps it.
 *
 * @param options - The options of the job, as checked.
 * @param carrier - The headers the observers wrote.
 * @returns `options` when there is nothing to add, otherwise a copy that carries the headers.
 */
export function withTraceMetadata(
  options: JobsOptions | undefined,
  carrier: Readonly<TraceCarrier>,
): JobsOptions | undefined {
  if (Object.keys(carrier).length === 0 || hasMetadata(options)) return options
  return stamped(options, carrier)
}

/**
 * The trace headers stored with a job. Anything that is not a JSON object of the two W3C headers as
 * strings of a bounded length is ignored, as is a header some other writer stored.
 *
 * @param metadata - `job.opts.telemetry.metadata`, as BullMQ gives it.
 * @returns The headers, empty when the job carries none that are usable.
 */
export function readTraceMetadata(metadata: unknown): TraceCarrier {
  if (typeof metadata !== 'string') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const carrier: TraceCarrier = {}
  for (const key of CARRIER_KEYS) {
    const value = (parsed as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length <= MAX_HEADER_LENGTH) carrier[key] = value
  }
  return carrier
}

/**
 * Store the trace headers with every node of a flow tree that has not got metadata of its own. The
 * tree is the copy the call checked, which it owns, so the nodes are changed in place; a node that
 * several parents share is visited once.
 *
 * @param flow - The checked copy of a flow tree.
 * @param carrier - The headers the observers wrote.
 */
export function stampFlow(flow: FlowJob, carrier: Readonly<TraceCarrier>): void {
  if (Object.keys(carrier).length === 0) return
  const seen = new Set<FlowJob>()
  const pending: FlowJob[] = [flow]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node)) continue
    seen.add(node)
    const opts = node.opts
    if (!hasMetadata(opts)) node.opts = stamped(opts, carrier)
    pending.push(...(node.children ?? []))
  }
}
