/**
 * @fileoverview Runs the observer registry in a process of its own and counts the unhandled
 * rejections that process reports. Inside Jest `process.on('unhandledRejection')` never fires, so a
 * unit spec cannot tell a handled rejection from one that ends a Node process; this one can.
 * @layer test
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const ENTRY = join(__dirname, 'queue-observer.ts')

/** What the child does: three observers that misbehave, each run through the registry. */
const SCRIPT = `
const { QueueObserverRegistry } = require(process.argv[2])
const { Logger } = require('@nestjs/common')
Logger.overrideLogger(false)
let unhandled = 0
process.on('unhandledRejection', () => { unhandled += 1 })
const settle = () => new Promise((resolve) => setImmediate(resolve))
async function main() {
  const out = {}
  const finished = new QueueObserverRegistry()
  finished.register({ jobFinished: async () => { throw new Error('async observer') } })
  finished.jobFinished({ queue: 'q', outcome: 'completed', durationSeconds: 1 })
  await settle()
  const own = new Error('the processor failed')
  const unawaited = new QueueObserverRegistry()
  unawaited.register({ traceProcess: (_info, _carrier, run) => { void run(); return Promise.resolve('early') } })
  out.unawaited = await unawaited
    .traceProcess({ queue: 'q' }, {}, () => new Promise((_resolve, reject) => setImmediate(reject, own)))
    .then(() => 'resolved', (error) => (error === own ? 'own error' : 'other error'))
  const busy = new QueueObserverRegistry()
  busy.register({ traceEnqueue: async (_info, _carrier, run) => { void run(); await settle(); return 'busy' } })
  out.busy = await busy
    .traceEnqueue({ queue: 'q' }, () => Promise.reject(own))
    .then(() => 'resolved', (error) => (error === own ? 'own error' : 'other error'))
  await settle()
  out.unhandled = unhandled
  process.stdout.write(JSON.stringify(out))
}
main()
`

describe('QueueObserverRegistry in a process of its own', () => {
  let directory: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'queue-observer-'))
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reports no unhandled rejection and keeps the error of the operation, whatever the observers do', () => {
    const bundle = join(directory, 'registry.cjs')
    const built = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'esbuild'),
      [
        ENTRY,
        `--outfile=${bundle}`,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--external:@nestjs/common',
        '--external:reflect-metadata',
        '--log-level=silent',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(built.status).toBe(0)
    const script = join(directory, 'run.cjs')
    writeFileSync(script, SCRIPT)

    const run = spawnSync(process.execPath, [script, bundle], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
    })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      unawaited: 'own error',
      busy: 'own error',
      unhandled: 0,
    })
  })
})
