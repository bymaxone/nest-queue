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

/**
 * A promise built with the global `Promise` binding, which a host can replace after load. Every
 * promise the library builds comes from the intrinsic constructor instead, so a replaced binding
 * decides nothing. Unlike the statics above, each site is listed on its own, with its reason.
 */
const NEW_PROMISE =
  /\bnew\s+Promise\b|\b(?:globalThis|global)\s*\.\s*Promise\b|(?:=|,|\()\s*Promise\s*(?:[,;)]|$)/

/** A site of `new Promise` that is allowed to stay: the file, the line as written, and why. */
interface NewPromiseExemption {
  readonly file: string
  readonly line: string
  readonly reason: string
}

const NEW_PROMISE_EXEMPT: readonly NewPromiseExemption[] = []

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
    count: 6,
    reason:
      'Each `catch` absorbs the failure of one close or quit during shutdown. The joins that decide how many workers were stopped, and the pause-then-close of a worker, are owned awaits.',
  },
  {
    file: 'server/observability/queue-observer.ts',
    count: 2,
    reason:
      "Absorbs the rejection of a host's `jobFinished` hook so it reaches no one; the event is told after the job ended and nothing reads the value.",
  },
  {
    file: 'server/services/connection-resolver.service.ts',
    count: 1,
    reason:
      'The absorbed rejection of a sentinel connect; nothing reads its value or feeds a verdict from it.',
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

/** Every line of code that builds a promise with the global binding, as `file: line`. */
function newPromiseSites(): string[] {
  return sources(SRC).flatMap((file) =>
    codeOf(file)
      .split('\n')
      .filter((line) => NEW_PROMISE.test(line))
      .map((line) => `${relative(SRC, file)}: ${line.trim()}`),
  )
}

describe('the promise operations of the library', () => {
  it('build no promise with the global binding, except the sites listed one by one', () => {
    const listed = NEW_PROMISE_EXEMPT.map((entry) => `${entry.file}: ${entry.line}`)

    expect(newPromiseSites()).toEqual(listed)
    for (const entry of NEW_PROMISE_EXEMPT) expect(entry.reason.length).toBeGreaterThan(30)
  })

  it('recognise a promise built with the global binding, however it is spaced', () => {
    for (const code of [
      'new Promise(f)',
      'new  Promise<void>(f)',
      'await new Promise(f)',
      'const P = globalThis.Promise',
      'const P = Promise',
      'use(Promise)',
    ]) {
      expect(NEW_PROMISE.test(code)).toBe(true)
    }
    for (const code of ['new NativePromise<void>(f)', 'const p: Promise<void> = q']) {
      expect(NEW_PROMISE.test(code)).toBe(false)
    }
  })

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
