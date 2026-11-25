/**
 * @fileoverview Runs the bounded waits on a promise whose own constructor cannot be replaced in a
 * process of its own and counts the unhandled rejections that process reports. Inside Jest
 * `process.on('unhandledRejection')` never fires, so a unit spec cannot tell a heard rejection from
 * one that ends a Node process; this one can.
 * @layer test
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outcomeOf, own } from './bounded-wait'

const ROOT = join(__dirname, '..', '..', '..')
const ENTRY = join(__dirname, 'bounded-wait.ts')

/**
 * The mutant Stryker has switched on in this Jest process, as the environment variable the
 * instrumented code of a child process reads it from.
 */
function strykerMutant(): Record<string, string> {
  const active = (globalThis as { __stryker__?: { activeMutant?: string } }).__stryker__
    ?.activeMutant
  return active === undefined ? {} : { __STRYKER_ACTIVE_MUTANT__: active }
}

/**
 * What the child does: for each wait, a promise that rejects after 20 ms and keeps a `constructor`
 * of its own that cannot be replaced, handed to the wait, and the unhandled rejections counted once
 * the work has failed. A refusal thrown or rejected by the wait itself is read and ignored.
 */
const SCRIPT = `
const { own, startWait, outcomeOf, joinAll } = require(process.argv[2])
let unhandled = 0
process.on('unhandledRejection', () => { unhandled += 1 })
const failing = () => {
  const promise = new Promise((_, reject) => setTimeout(() => reject(new Error('work failed')), 20))
  Object.defineProperty(promise, 'constructor', { value: Object, configurable: false })
  return promise
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 80))
const rows = {
  own: () => own(failing()),
  startWait: () => startWait(failing(), 1000).release(),
  outcomeOf: () => outcomeOf(() => failing()),
  joinAll: () => joinAll([failing()]),
}
async function main() {
  const out = {}
  for (const [name, call] of Object.entries(rows)) {
    const before = unhandled
    try { const answer = call(); if (answer instanceof Promise) answer.catch(() => undefined) } catch (error) { /* refusal */ }
    await pause()
    out[name] = unhandled - before
  }
  process.stdout.write(JSON.stringify(out))
}
main()
`

describe('a promise whose own constructor cannot be replaced, in a process of its own', () => {
  let directory: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'bounded-wait-pinned-'))
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('leaves no rejection unheard when own, startWait, outcomeOf or joinAll refuse it', async () => {
    // The same waits in this process, which is what tells a mutation run that this spec exercises
    // them and has to run for their mutants.
    expect(() =>
      own(Object.defineProperty(Promise.resolve(), 'constructor', { value: Object })),
    ).toThrow()
    await expect(outcomeOf(() => Promise.resolve(1))).resolves.toEqual({ state: 'done', v: 1 })

    const bundle = join(directory, 'bounded-wait.cjs')
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
      env: { ...process.env, ...strykerMutant(), NODE_PATH: join(ROOT, 'node_modules') },
    })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ own: 0, startWait: 0, outcomeOf: 0, joinAll: 0 })
  })
})
