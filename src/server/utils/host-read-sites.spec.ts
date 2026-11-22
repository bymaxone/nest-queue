/**
 * @fileoverview Holds every read of a host's object to a guard. A host's getter or Proxy trap can
 * throw, so a read by name that sits outside a guard lets the host's own error escape instead of the
 * library's refusal. This spec fails when a source file reads by name without being listed here with
 * the guard it uses, so a new site has to name its guard before it can pass.
 * @layer test
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..', '..')

/** The files that read by name, each with the guard that its reads sit inside. */
const GUARDED_SITES: Readonly<Record<string, string>> = {
  'server/bymax-queue.module.ts': 'guarded(',
  'server/config/snapshot-options.ts': 'guarded(',
  'server/observability/queue-observer.ts': 'catch',
  'server/services/queue.service.ts': 'guarded(',
  'server/utils/read-bulk-jobs.ts': 'guarded(',
  'server/utils/snapshot-worker-options.ts': 'guarded(',
}

/** The files that define the reads themselves. */
const DEFINITIONS = new Set(['server/config/read-by-name.ts'])

/** Every source file of the library that is not a spec. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** The code (not comment) lines of `file`. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')
}

describe('the reads of a host object', () => {
  const readers = sources(SRC)
    .map((file) => ({ name: relative(SRC, file), code: codeOf(file) }))
    .filter(({ name, code }) => !DEFINITIONS.has(name) && /\b(readByName|readKeysOf)\(/.test(code))

  it('are made only in files that name their guard', () => {
    expect(readers.map(({ name }) => name).sort()).toEqual(Object.keys(GUARDED_SITES).sort())
  })

  it.each(Object.entries(GUARDED_SITES))('%s uses its guard (%s)', (file, guard) => {
    const code = readers.find(({ name }) => name === file)?.code ?? ''

    expect(code).toContain(guard)
  })
})
