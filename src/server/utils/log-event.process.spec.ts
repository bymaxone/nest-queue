/**
 * @fileoverview Runs `writeLog` in a process of its own, through Nest's own `Logger` with a host
 * logger that throws installed by `Logger.overrideLogger`, which is the path every log line of the
 * library takes. A plain logger object would leave Nest's wrapper out of the measurement.
 * @layer test
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLog } from './log-event'

const ROOT = join(__dirname, '..', '..', '..')
const ENTRY = join(__dirname, 'log-event.ts')

/** What the child does: Nest's own Logger, with a host logger that throws installed on it. */
const SCRIPT = `
const { writeLog } = require(process.argv[2])
const { Logger } = require('@nestjs/common')
let unhandled = 0
process.on('unhandledRejection', () => { unhandled += 1 })
const fail = () => { throw new Error('host transport') }
Logger.overrideLogger({ log: fail, warn: fail, error: fail })
const logger = new Logger('probe')
const message = { event: 'QUEUE_CLIENT_ERROR', message: 'text' }
const thrown = []
for (const level of ['log', 'warn', 'error']) {
  try { writeLog(logger, level, message) } catch (error) { thrown.push(level) }
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

  it('lets nothing escape from a host logger that throws, set on the Nest Logger the library writes through', () => {
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

    const run = spawnSync(process.execPath, [script, bundle], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
    })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ thrown: [], unhandled: 0 })
  })
})
