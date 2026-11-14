/**
 * @fileoverview Pins which HTTP status each error code may carry, in the source and in the README.
 * The status follows the cause at the throw site: 503 when a backing service or an opt-in feature
 * is unavailable, 400 when a value an application passes per call is wrong, 500 for a wiring or
 * configuration fault in the host. A code can carry more than one status when its causes differ.
 * @layer server/errors
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

const {
  INTERNAL_SERVER_ERROR: SERVER,
  BAD_REQUEST: BAD,
  SERVICE_UNAVAILABLE: UNAVAILABLE,
} = HttpStatus

/** Every status a code is allowed to carry; a new code or a new status is a deliberate edit here. */
const ALLOWED: Readonly<Record<string, readonly number[]>> = {
  CONNECTION_INVALID: [SERVER],
  CONNECTION_REQUIRES_NULL_RETRIES: [SERVER],
  CONNECTION_TIMEOUT: [UNAVAILABLE],
  INVALID_REPEAT_OPTIONS: [BAD],
  DUPLICATE_PROCESSOR: [SERVER],
  FLOW_DISABLED: [UNAVAILABLE],
  METRICS_DISABLED: [UNAVAILABLE],
  BULK_ENQUEUE_FAILED: [BAD, SERVER],
  WORKER_REGISTRATION_FAILED: [SERVER],
  INVALID_OPTIONS: [SERVER, BAD],
}

/** Sites whose code or status is a variable, each pinned by a behaviour test instead of this scan. */
const DYNAMIC_SITES: Readonly<Record<string, number>> = {
  'services/connection-resolver.service.ts': 1,
}

const root = resolve(__dirname, '..')

/** Every non-spec source file under `src/server`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

/** The source text without its comments, whose examples also read `new QueueException(`. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The `[code, status]` of every `new QueueException(` call in a source text, by call. */
function sites(text: string): { code: string; status: string }[] {
  return [...text.matchAll(/new QueueException\(\s*([^,)]+?)\s*(?:,\s*([^,)]+?)\s*)?[,)]/g)].map(
    (m) => ({ code: m[1] ?? '', status: m[2] ?? 'HttpStatus.INTERNAL_SERVER_ERROR' }),
  )
}

describe('error status contract — the source', () => {
  const found = sources(root).flatMap((file) =>
    sites(withoutComments(readFileSync(file, 'utf8'))).map((site) => ({
      ...site,
      file: file.slice(root.length + 1),
    })),
  )

  it('finds the throw sites it is meant to scan', () => {
    expect(found.length).toBeGreaterThan(20)
  })

  it('lets every literal throw site carry only a status its code is allowed', () => {
    const literal = found.filter(
      (s) => s.code.startsWith('QUEUE_ERROR_CODES.') && s.status.startsWith('HttpStatus.'),
    )
    const refused = literal.filter((s) => {
      const code = s.code.slice('QUEUE_ERROR_CODES.'.length)
      const status = HttpStatus[s.status.slice('HttpStatus.'.length) as keyof typeof HttpStatus]
      return !(ALLOWED[code] ?? []).includes(status)
    })

    expect(refused.map((s) => `${s.file}: ${s.code} with ${s.status}`)).toEqual([])
  })

  it('keeps every site that is not literal on the list pinned by a behaviour test', () => {
    const dynamic = found.filter(
      (s) => !(s.code.startsWith('QUEUE_ERROR_CODES.') && s.status.startsWith('HttpStatus.')),
    )
    const byFile: Record<string, number> = {}
    for (const s of dynamic) byFile[s.file] = (byFile[s.file] ?? 0) + 1

    expect(byFile).toEqual(DYNAMIC_SITES)
  })

  it('covers every code the library throws', () => {
    const thrown = new Set(
      found.flatMap((s) =>
        s.code.startsWith('QUEUE_ERROR_CODES.') ? [s.code.slice('QUEUE_ERROR_CODES.'.length)] : [],
      ),
    )
    const known = new Set(Object.keys(ALLOWED))

    expect([...thrown].filter((c) => !known.has(c))).toEqual([])
    for (const code of known) expect(Object.keys(QUEUE_ERROR_CODES)).toContain(code)
  })
})

describe('error status contract — the README table', () => {
  const readme = readFileSync(resolve(root, '../../README.md'), 'utf8')
  const rows = readme
    .split('\n')
    .filter((line) => /^\| `queue\.[a-z_]+`\s*\|\s*[0-9]/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()))

  it.each(Object.entries(ALLOWED))('documents every status %s may carry', (key, statuses) => {
    const value = QUEUE_ERROR_CODES[key as keyof typeof QUEUE_ERROR_CODES]
    const row = rows.find((cells) => cells[1] === `\`${value}\``)

    expect(row).toBeDefined()
    expect([...new Set((row?.[2] ?? '').match(/\d{3}/g)?.map(Number))].sort()).toEqual(
      [...statuses].sort(),
    )
  })
})
