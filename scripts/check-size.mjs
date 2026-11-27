#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'

/**
 * Brotli-compressed bundle budgets in bytes, measured on the bundles after
 * `scripts/strip-bundle-comments.mjs`. The server entry carries the full NestJS module surface; the
 * shared entry is types and constants only, and the observability entry is the optional metrics, readiness and tracing adapters, which import the main entry and bundle none of it. The server budget is the measured artifact (13,165 B with
 * the per-job timeout, the jitter default, the bounded getJobs, the command-timeout code, the shared
 * ready-wait, the per-call deadline, the worker option bounds, the flow deadline, the disconnect guard and the startup
 * outage classifier, the bounded quit, the short disconnect timeout, the refusal of a reserved job id, the out-of-memory classifier and the per-tree flow bulk its timed-out trees and the validation of the default job options and the same validation of every node of a job or a flow and the one read of the module options with its unset keys dropped, the check of a malformed flow and the copy of what was checked, and the observer registry with the trace carrier, the attempt outcome and the log events as objects, and the guard that keeps a failing observer off the job: the thenable handling of a hook's result, the operation that still runs once, and the frozen copy of the event for each observer, and the one path every log line takes so that a host logger that throws is absorbed, and the guarded read and copy of every option a host hands over: the connection, the queue options, the worker options, the schedule and the bulk list, and the shared bounds-checked read of a fixed list, and the bounded wait that settles through an object with no prototype with the readiness ping on the connection, and the own constructor on every promise the library builds, the intrinsic constructor in place of every global one, and the guard after the last replaceable call of each decision return, and the intrinsic constructor claimed before each await that decides a result, and the private verdict the observer follows with beside the mirror the host is handed, and the owned relay and join of a job's outcome and of the shutdown: the refusal of an intrinsic promise constructor that a host replaced before load, told by its source in a fresh realm, and the refusal of a native promise that holds a constructor of its own, and the owned await of every close, drain, quit and move of a job with the guard after the last host call of each return, and the one builder of the descriptors the library defines with no prototype, and the baseline of only the functions the language defines on Reflect, and the prototype-chain check of a processor provider, and the maxStalledCount worker option and the dropped outcome of a stopped sandboxed worker and the warning for one that cannot be wrapped, and the rate-limited report of the jobs the guard sends back to the delayed set, and the bounded depth read and the failed-job log, and the cut of the logged job name and id with the drop of a late depth read: 23,177 B measured on 2026-11-27) plus a margin of 30 B. It is set from what was built and
 * raised only after the next measurement, never ahead of it. The shared bundle
 * (417 B) keeps about 5% headroom. Each CommonJS bundle is budgeted at its measured brotli size plus 30 B,
 * measured on 2026-11-27 on the same build: 23,251 B for the server entry, 1,693 B for observability and
 * 429 B for shared. A `require` consumer gets the CommonJS file, so it is the one a regression in that
 * file would reach.
 */
const BUDGETS = {
  'dist/server/index.mjs': 23_207,
  'dist/observability/index.mjs': 1_912,
  'dist/shared/index.mjs': 440,
  'dist/server/index.cjs': 23_281,
  'dist/observability/index.cjs': 1_723,
  'dist/shared/index.cjs': 459,
}

let failed = false

for (const [file, budget] of Object.entries(BUDGETS)) {
  let raw
  try {
    raw = readFileSync(file)
  } catch {
    console.error(`✖ ${file} — missing (run "pnpm build" first)`)
    failed = true
    continue
  }

  const size = brotliCompressSync(raw).length
  const status = size <= budget ? '✔' : '✖'
  const verdict = size <= budget ? 'within budget' : 'OVER BUDGET'
  console.log(`${status} ${file} — ${size} B brotli / ${budget} B budget (${verdict})`)
  if (size > budget) failed = true
}

if (failed) {
  console.error('Bundle size budget exceeded.')
  process.exit(1)
}

console.log('All bundles within budget.')
