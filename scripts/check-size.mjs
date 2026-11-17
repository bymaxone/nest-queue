#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'

/**
 * Brotli-compressed bundle budgets in bytes, measured on the bundles after
 * `scripts/strip-bundle-comments.mjs`. The server entry carries the full NestJS module surface; the
 * shared entry is types and constants only. The server budget is the measured artifact (12,658 B with
 * the per-job timeout, the jitter default, the bounded getJobs, the command-timeout code, the shared
 * ready-wait, the per-call deadline, the worker option bounds, the flow deadline, the disconnect guard and the startup
 * outage classifier, the bounded quit, the short disconnect timeout, the refusal of a reserved job id, the out-of-memory classifier and the per-tree flow bulk its timed-out trees and the validation of the default job options) plus a margin of 32 B. It is set from what was built and
 * raised only after the next measurement, never ahead of it. The shared bundle
 * (417 B) keeps about 5% headroom.
 */
const BUDGETS = {
  'dist/server/index.mjs': 12_690,
  'dist/shared/index.mjs': 440,
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
