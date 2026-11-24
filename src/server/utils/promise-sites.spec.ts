/**
 * @fileoverview Holds every use of a `Promise` static, or of a promise's `then`, `catch` or `finally`,
 * in the library to a list with a reason for each file. A host or a dependency can replace any of
 * them after load, and a verdict that reads one is decided by whoever did. The verdict paths are
 * built on `startWait` instead (an intrinsic constructor, an `await`, no static). A source file
 * that gains or loses one of these fails here until its entry is read and corrected, and an entry
 * whose file no longer has the site fails too.
 * @layer test
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..', '..')

/** Every way the library could reach a replaceable promise operation. */
const SITE =
  /\bPromise\s*\.\s*(?:race|all|allSettled|any|resolve|reject|try|withResolvers)\b|\bPromise\s*\[|\}\s*=\s*Promise\b|\.\s*(?:then|catch|finally)\s*\(|\bthen\s*\.\s*call\s*\(/g

/** What a site is allowed to be: a count in a file, and why none of them decides a verdict. */
interface Exemption {
  readonly file: string
  readonly count: number
  readonly reason: string
}

const EXEMPT: readonly Exemption[] = [
  {
    file: 'observability/queue-metrics.contributor.ts',
    count: 1,
    reason:
      'Absorbs a failed metrics read into an empty list; the list is reported, not decided on.',
  },
  {
    file: 'server/lifecycle/queue-lifecycle.service.ts',
    count: 11,
    reason:
      'Shutdown fan-out and error absorption (close, pause, drain, quit). Each close is bounded by the deadline helpers and no step reads a verdict from them.',
  },
  {
    file: 'server/observability/queue-observer.ts',
    count: 3,
    reason:
      'Absorbs the rejection of a host observer hook so it reaches no one; nothing reads the value.',
  },
  {
    file: 'server/services/connection-resolver.service.ts',
    count: 2,
    reason:
      'An already-resolved promise for a connected client, and the absorbed rejection of a sentinel connect; neither feeds a verdict.',
  },
  {
    file: 'server/services/flow.service.ts',
    count: 1,
    reason: 'Absorbs a failed close of the flow producer during teardown.',
  },
  {
    file: 'server/services/metrics.service.ts',
    count: 1,
    reason:
      'Joins per-queue metric reads into one list of numbers; no verdict is read from the join.',
  },
  {
    file: 'server/services/processor-discovery.service.ts',
    count: 3,
    reason:
      'Adapts a host handler into a promise and reports its failure; the handler runs the host work.',
  },
  {
    file: 'server/services/queue.service.ts',
    count: 2,
    reason:
      'Chains the readiness of a queue and absorbs a failed close; neither is a guard verdict.',
  },
  {
    file: 'server/services/worker-registry.service.ts',
    count: 5,
    reason:
      'Runs a host job handler inside a promise and relays its result to BullMQ; the handler is the host work, bounded by withDeadline.',
  },
  {
    file: 'server/utils/add-flow-trees.ts',
    count: 2,
    reason:
      'Joins the workers of a bulk add. The landed, failed and not-started sets are read from the closure state each worker writes, not from the join.',
  },
]

/** Every source file of the library that is not a spec. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** The code of a file with its comments taken out, so a sentence cannot count as a site. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/** The number of sites in each file that has any. */
function counts(): Map<string, number> {
  const found = new Map<string, number>()
  for (const file of sources(SRC)) {
    const sites = codeOf(file).match(SITE)
    if (sites) found.set(relative(SRC, file), sites.length)
  }
  return found
}

describe('the promise operations of the library', () => {
  it('are each listed with a reason, and the count of every file is exactly as listed', () => {
    const found = counts()
    const listed = new Map(EXEMPT.map((entry) => [entry.file, entry.count]))

    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(listed))
  })

  it('give a reason for every entry that is longer than a word', () => {
    for (const entry of EXEMPT) expect(entry.reason.length).toBeGreaterThan(30)
  })

  it('recognise every way to reach a replaceable promise operation', () => {
    const reached = [
      'Promise.race(a)',
      'Promise . all(a)',
      'Promise.allSettled(a)',
      'Promise.any(a)',
      'Promise.resolve()',
      'Promise.reject(e)',
      'Promise.try(f)',
      'Promise.withResolvers()',
      "Promise['race'](a)",
      'const { race } = Promise',
      'work.then(f)',
      'work.then (f)',
      'work.catch(f)',
      'work.finally(f)',
      'then.call(work, f)',
    ]
    for (const code of reached) expect(code.match(SITE)).not.toBeNull()
    expect('const p: Promise<string> = await work'.match(SITE)).toBeNull()
  })
})
