#!/usr/bin/env node
/**
 * Dogfood smoke test — validates the published package shape before tagging.
 *
 * Validates:
 *   1. Build artifacts exist for both subpaths (ESM, CJS, .d.ts, .d.cts)
 *   2. ESM import resolves the expected named exports (server + shared)
 *   3. CJS require resolves the expected named exports (server + shared)
 *   4. Tarball contents (npm pack --dry-run) contain only dist/ + meta files
 *   5. A minimal consumer (file: link in an OS temp dir) resolves both subpaths
 *      through the published `exports` map, in ESM *and* CJS
 *   6. Behavioral smoke against the built artifact: forRoot wires a DynamicModule
 *      and the fail-fast validation path still throws
 *
 * Exit codes: 0 pass · 1 assertion failed · 2 build artifacts missing.
 *
 * Usage: pnpm build && node scripts/dogfood-smoke-test.mjs
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Created lazily inside the consumer section so an earlier `process.exit(2)`
// leaks no temp dir.
let consumerDir

const SUBPATHS = ['server', 'shared']
// `.d.cts` is not decoration: it is the declaration file the `exports` map hands
// to a CommonJS consumer. Without it, `require()` resolves to the ESM `.d.ts` and
// TypeScript reports the package as masquerading as ESM.
const ARTIFACT_EXTENSIONS = ['mjs', 'cjs', 'd.ts', 'd.cts']

const EXPECTED_SERVER_EXPORTS = [
  'BymaxQueueModule',
  'BYMAX_QUEUE_OPTIONS',
  'BYMAX_QUEUE_REDIS_CLIENT',
  'BYMAX_QUEUE_CONNECTION_MODE',
  'BYMAX_QUEUE_RESOLVED_OPTIONS',
  'QueueService',
  'FlowService',
  'MetricsService',
  'ConnectionResolver',
  'WorkerRegistry',
  'QueueEventsRegistry',
  'Processor',
  'Process',
  'OnWorkerEvent',
  'OnQueueEvent',
  'QueueException',
  'QUEUE_ERROR_CODES',
  'QUEUE_ERROR_MESSAGES',
  'JOB_STATUS',
  'DEFAULT_WORKER_CONCURRENCY',
  'MAX_WORKER_CONCURRENCY',
  'DEFAULT_JOB_OPTIONS',
  'DEFAULT_METRICS_CACHE_TTL_MS',
  'DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS',
]

const EXPECTED_SHARED_EXPORTS = ['JOB_STATUS', 'QUEUE_ERROR_CODES']

const ALLOWED_TARBALL_PATHS = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/']

let failures = 0
const fail = (msg) => {
  console.error(`  FAIL: ${msg}`)
  failures++
}
const pass = (msg) => console.log(`  PASS: ${msg}`)
const section = (title) => console.log(`\n-- ${title}`)

// -- 1. Build artifact presence ----------------------------------------------
section('1. Build artifacts')
for (const subpath of SUBPATHS) {
  for (const ext of ARTIFACT_EXTENSIONS) {
    const file = `dist/${subpath}/index.${ext}`
    if (!existsSync(resolve(ROOT, file))) {
      console.error(`Missing build artifact: ${file} — run \`pnpm build\` first.`)
      process.exit(2)
    }
    pass(file)
  }
}

// -- 2. ESM named exports ----------------------------------------------------
section('2. ESM named exports — server')
const serverEsm = await import(resolve(ROOT, 'dist/server/index.mjs'))
for (const name of EXPECTED_SERVER_EXPORTS) {
  name in serverEsm ? pass(`export ${name}`) : fail(`Missing export: ${name}`)
}

section('3. ESM named exports — shared')
const sharedEsm = await import(resolve(ROOT, 'dist/shared/index.mjs'))
for (const name of EXPECTED_SHARED_EXPORTS) {
  name in sharedEsm ? pass(`export ${name}`) : fail(`Missing export: ${name}`)
}

// -- 4. CJS exports ----------------------------------------------------------
section('4. CJS exports')
const req = createRequire(import.meta.url)
const serverCjs = req(resolve(ROOT, 'dist/server/index.cjs'))
for (const name of EXPECTED_SERVER_EXPORTS) {
  name in serverCjs ? pass(`cjs server ${name}`) : fail(`Missing CJS export: ${name}`)
}
const sharedCjs = req(resolve(ROOT, 'dist/shared/index.cjs'))
for (const name of EXPECTED_SHARED_EXPORTS) {
  name in sharedCjs ? pass(`cjs shared ${name}`) : fail(`Missing CJS export (shared): ${name}`)
}

// -- 5. Tarball contents -----------------------------------------------------
section('5. Tarball contents (npm pack --dry-run)')
try {
  const packOut = execSync('npm pack --dry-run 2>&1', { cwd: ROOT, encoding: 'utf8' })
  const SIZE_RE = /\s+[\d.]+\s*(?:[Mm][Bb]|[Kk][Bb]?|[Bb])\s+\S+/
  const SIZE_STRIP_RE = /.*npm notice\s+[\d.]+\s*(?:[Mm][Bb]|[Kk][Bb]?|[Bb])\s+/
  const contentLines = packOut
    .split('\n')
    .filter((l) => l.includes('npm notice') && SIZE_RE.test(l))
    .map((l) => l.replace(SIZE_STRIP_RE, '').trim())
    .filter((l) => Boolean(l) && !l.startsWith('npm notice') && !/^sha\d+:/i.test(l))
  const unexpected = contentLines.filter(
    (f) =>
      !ALLOWED_TARBALL_PATHS.some(
        (entry) => f === entry || (entry.endsWith('/') && f.startsWith(entry)),
      ),
  )
  if (unexpected.length === 0) {
    pass(`Tarball contains only dist/ + meta files (${contentLines.length} entries)`)
  } else {
    for (const f of unexpected) fail(`Unexpected file in tarball: ${f}`)
  }
  // LICENSE is listed in `files`, but npm silently omits an entry that does not
  // exist on disk — the package would ship MIT-licensed with no license text.
  contentLines.includes('LICENSE')
    ? pass('LICENSE is present in the tarball')
    : fail('LICENSE is missing from the tarball')
} catch (err) {
  fail(`npm pack --dry-run failed: ${err instanceof Error ? err.message : String(err)}`)
}

// -- 5b. Zero-runtime-dependency contract ------------------------------------
// The empty `dependencies` object is the contract, not decoration: it is what the
// README, CLAUDE.md and the Dependabot config all assert about this package. It is
// also fragile — `pnpm add` rewrites the manifest and drops an empty object without
// a word, so the key disappears on an ordinary dependency bump and nothing else in
// the pipeline notices. Assert the key EXISTS and is empty; a missing key and an
// empty one are different claims, and only one of them is the contract.
section('5b. Zero-runtime-dependency contract')
const manifest = req(resolve(ROOT, 'package.json'))
if (!Object.hasOwn(manifest, 'dependencies')) {
  fail('package.json has no `dependencies` key — the zero-dependency contract is unstated')
} else if (Object.keys(manifest.dependencies).length > 0) {
  fail(
    `package.json declares runtime dependencies: ${Object.keys(manifest.dependencies).join(', ')}`,
  )
} else {
  pass('package.json declares an explicit empty `dependencies`')
}

// -- 6. Consumer file: link smoke --------------------------------------------
section('6. Consumer file: link smoke (resolution check, ESM + CJS)')
try {
  consumerDir = mkdtempSync(join(tmpdir(), 'dogfood-consumer-'))
  writeFileSync(
    resolve(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dogfood-consumer',
        version: '0.0.1',
        type: 'module',
        // Every required peer is declared explicitly rather than left to pnpm's
        // auto-install-peers: the point of this check is that a consumer who
        // followed the README's install line can resolve the package.
        dependencies: {
          '@bymax-one/nest-queue': `file:${ROOT}`,
          '@nestjs/common': '^11.0.0',
          '@nestjs/core': '^11.0.0',
          bullmq: '^5.16.0',
          ioredis: '^5.0.0',
          'reflect-metadata': '^0.2.0',
          rxjs: '^7.8.0',
        },
      },
      null,
      2,
    ),
  )
  const installResult = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: consumerDir,
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (installResult.status !== 0) {
    fail(`pnpm install in consumer failed: ${installResult.stderr}`)
  } else {
    pass('pnpm install with file: link succeeded')

    const esmProbe = [
      "import 'reflect-metadata';",
      "const m = await import('@bymax-one/nest-queue');",
      "if (!('BymaxQueueModule' in m)) process.exit(3);",
      "const s = await import('@bymax-one/nest-queue/shared');",
      "if (!('JOB_STATUS' in s)) process.exit(4);",
    ].join('')
    const esmResult = spawnSync('node', ['--input-type=module', '-e', esmProbe], {
      cwd: consumerDir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    esmResult.status === 0
      ? pass('ESM: both subpaths resolve via the exports map from consumer cwd')
      : fail(`ESM consumer import failed (code ${esmResult.status}): ${esmResult.stderr}`)

    // The CJS half is the one the `exports` map gets wrong most easily: `require`
    // must land on the `.cjs` bundle, not on the ESM one.
    const cjsProbe = [
      "require('reflect-metadata');",
      "const m = require('@bymax-one/nest-queue');",
      "if (!('BymaxQueueModule' in m)) process.exit(3);",
      "const s = require('@bymax-one/nest-queue/shared');",
      "if (!('JOB_STATUS' in s)) process.exit(4);",
    ].join('')
    const cjsResult = spawnSync('node', ['--input-type=commonjs', '-e', cjsProbe], {
      cwd: consumerDir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    cjsResult.status === 0
      ? pass('CJS: both subpaths resolve via the exports map with require()')
      : fail(`CJS consumer require failed (code ${cjsResult.status}): ${cjsResult.stderr}`)
  }
} catch (err) {
  fail(`Consumer scaffolding failed: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  if (consumerDir) {
    try {
      rmSync(consumerDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
}

// -- 7. Behavioral smoke — forRoot pipeline ----------------------------------
// Exercises the published artifact, not the source: a minimal `forRoot(...)` runs
// the full validate -> resolve -> conditional-registration pipeline and must
// return a DynamicModule descriptor. No Redis is contacted — the connection is
// opened by an async provider at module init, not by `forRoot`.
section('7. Behavioral smoke (forRoot + fail-fast validation)')
try {
  const { BymaxQueueModule, QueueException, QUEUE_ERROR_CODES } = serverEsm
  const dynamicModule = BymaxQueueModule.forRoot({
    connection: { url: 'redis://localhost:6379' },
  })
  const wired =
    dynamicModule.module === BymaxQueueModule &&
    Array.isArray(dynamicModule.providers) &&
    dynamicModule.providers.length > 0 &&
    Array.isArray(dynamicModule.exports)
  wired
    ? pass('forRoot({ connection }) returns a wired DynamicModule')
    : fail('forRoot did not return a wired DynamicModule descriptor')

  // The fail-fast guard must survive bundling and tree-shaking: a build that
  // dropped it would accept a connectionless config and fail much later, at the
  // first enqueue, with an unrelated error.
  let threw = null
  try {
    BymaxQueueModule.forRoot({})
  } catch (err) {
    threw = err
  }
  // The stable code lives in the response envelope (`{ error: { code, ... } }`),
  // which is the shape consumers branch on — assert it, not the message.
  const thrownCode = threw instanceof QueueException ? threw.getResponse()?.error?.code : undefined
  thrownCode === QUEUE_ERROR_CODES.INVALID_OPTIONS
    ? pass('forRoot({}) throws QueueException(INVALID_OPTIONS)')
    : fail(`Expected QueueException(INVALID_OPTIONS) from forRoot({}), got: ${String(threw)}`)
} catch (err) {
  fail(`Behavioral smoke threw: ${err instanceof Error ? err.message : String(err)}`)
}

console.log('')
if (failures === 0) {
  console.log('All dogfood smoke assertions passed.')
  process.exit(0)
} else {
  console.error(`${failures} assertion(s) failed.`)
  process.exit(1)
}
