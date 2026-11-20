/**
 * @fileoverview Runs `writeLog` in a process of its own against host loggers that misbehave, and
 * counts the unhandled rejections that process reports. Jest cannot observe them, so a unit spec
 * cannot tell a logger whose rejection was absorbed from one that ends a Node process.
 * @layer test
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLog } from './log-event'

const ROOT = join(__dirname, '..', '..', '..')
const ENTRY = join(__dirname, 'log-event.ts')

/** What the child does: three loggers that fail in three ways, each written to at every level. */
const SCRIPT = `
const { writeLog } = require(process.argv[2])
let unhandled = 0
process.on('unhandledRejection', () => { unhandled += 1 })
const message = { event: 'QUEUE_CLIENT_ERROR', message: 'text' }
const failing = {
  rejects: () => Promise.reject(new Error('async transport')),
  throws: () => { throw new Error('sync transport') },
  thenable: () => ({ get then() { throw new Error('then getter') } }),
}
const thrown = []
for (const [name, fail] of Object.entries(failing)) {
  const logger = { log: fail, warn: fail, error: fail }
  for (const level of ['log', 'warn', 'error']) {
    try { writeLog(logger, level, message) } catch (error) { thrown.push(name + ':' + level) }
  }
}
setImmediate(() => setImmediate(() => process.stdout.write(JSON.stringify({ thrown, unhandled }))))
`

describe('writeLog in a process of its own', () => {
  let directory: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'log-event-'))
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('lets nothing escape from a host logger that throws, rejects or returns a throwing thenable', () => {
    // The same call in this process, so a mutation run knows this spec exercises `writeLog`.
    writeLog({ log: () => undefined, warn: () => undefined, error: () => undefined }, 'warn', {
      event: 'QUEUE_CLIENT_ERROR',
      message: 'text',
    })
    const bundle = join(directory, 'log-event.cjs')
    const built = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'tsup'),
      [ENTRY, '--no-config', '--format', 'cjs', '--out-dir', directory, '--silent'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(built.status).toBe(0)
    const script = join(directory, 'run.cjs')
    writeFileSync(script, SCRIPT)

    const run = spawnSync(process.execPath, [script, bundle], { cwd: ROOT, encoding: 'utf8' })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ thrown: [], unhandled: 0 })
  })
})
