/**
 * @fileoverview Holds every log line of the library to one path. A host may replace Nest's logger
 * with one that throws or returns a rejecting promise, so a line written straight to `logger.warn`
 * could end a process from inside a listener of an `error` event; `writeLog` absorbs both, and this
 * spec fails when a source file writes to a logger any other way.
 * @layer test
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..', '..')

/** Every source file of the library that is not a spec. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** The lines of code (not comments) that call a log method on a logger. */
function directLogCalls(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line) => /\blogger\.(log|warn|error|debug|verbose|fatal)\(/i.test(line))
}

describe('the log lines of the library', () => {
  it('are written through writeLog, never straight to a logger', () => {
    const offenders = sources(SRC)
      .filter((file) => relative(SRC, file) !== join('server', 'utils', 'log-event.ts'))
      .flatMap((file) =>
        directLogCalls(file).map((line) => `${relative(SRC, file)}: ${line.trim()}`),
      )

    expect(offenders).toEqual([])
  })
})
