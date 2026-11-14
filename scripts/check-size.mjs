#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'

/**
 * Brotli-compressed bundle budgets in bytes, measured on the bundles after
 * `scripts/strip-bundle-comments.mjs`. The server entry carries the full NestJS module surface; the
 * shared entry is types and constants only. The server budget is the measured artifact (9,938 B with the
 * per-job timeout, the jitter default, the bounded getJobs and the command-timeout code on every
 * call) plus a margin of 22 B. It is set from
 * what was built and raised only after the next measurement, never ahead of it. The shared bundle
 * (396 B) keeps about 11% headroom.
 */
const BUDGETS = {
  'dist/server/index.mjs': 9_960,
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
