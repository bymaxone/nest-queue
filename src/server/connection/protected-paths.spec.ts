/**
 * @fileoverview A scan of the sources of the protected paths: every global they call a static on, or
 * construct, is either a built-in the prototype guard keeps a load baseline of or is exempt with a
 * reason; and every method name they call that only a built-in the guard does not baseline has (so
 * that no baselined built-in could be the one called) is exempt with a reason. A text scan cannot tell
 * `String#includes` from `Array#includes`, which is why the baseline covers the whole of each
 * built-in prototype; what the scan holds is that no other built-in sneaks into these paths unseen.
 * @layer server/connection
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPrototypeClean } from './prototype-guard'

const ROOT = join(__dirname, '..')

/** The sources of the protected paths, relative to `src/server`. */
const PATHS: readonly string[] = [
  'config/snapshot-options.ts',
  'config/read-by-name.ts',
  'config/guarded-read.ts',
  'utils/assert-job-inputs.ts',
  'utils/read-bulk-jobs.ts',
  'utils/snapshot-worker-options.ts',
  'utils/shadow-job-options.ts',
  'services/processor-discovery.service.ts',
  'services/worker-registry.service.ts',
  'services/queue.service.ts',
  'services/flow.service.ts',
  'bymax-queue.module.ts',
]

/** The globals the guard keeps a load baseline of, with their prototypes. */
const BASELINED_GLOBALS: readonly string[] = [
  'Object',
  'Reflect',
  'Array',
  'Number',
  'String',
  'Function',
  'Symbol',
  'JSON',
  'Set',
  'Map',
  'RegExp',
  'WeakMap',
  'WeakSet',
  'Boolean',
  'BigInt',
]

/** The globals the paths use that the baseline leaves out, each with the reason it is safe to. */
const EXEMPT_GLOBALS: Readonly<Record<string, string>> = {
  Promise: 'exempt on purpose: a library may patch it for scheduling, and the paths only await',
  Date: 'exempt on purpose: a library may patch the clock; its value is never a key or an option',
  Error: 'builds an error object; nothing reads an option off it',
  AbortController:
    'makes the per-job signal handed to the handler; it reads no option and carries no key',
}

/** Method names only a non-baselined built-in has, each with the reason it is safe to call. */
const EXEMPT_METHODS: Readonly<Record<string, string>> = {
  then: 'Promise: exempt with Promise',
  catch: 'Promise: exempt with Promise',
  finally: 'Promise: exempt with Promise',
  now: 'Date.now: exempt with Date',
  toISOString: 'Date: exempt with Date',
  resolve: 'Promise.resolve: exempt with Promise',
  reject: 'Promise.reject: exempt with Promise',
  abort: 'AbortController: exempt with AbortController',
  addEventListener: 'AbortSignal: exempt with AbortController',
  removeEventListener: 'AbortSignal: exempt with AbortController',
}

/** The built-ins outside the baseline whose prototypes the method check compares against. */
const OTHER_BUILTINS: readonly string[] = [
  'Promise',
  'Date',
  'Error',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'URL',
  'URLSearchParams',
  'Buffer',
  'Uint8Array',
  'ArrayBuffer',
  'BigInt',
  'Boolean',
  'AbortController',
  'AbortSignal',
  'TextEncoder',
  'TextDecoder',
  'EventTarget',
  'DataView',
]

/** What a scan of one source found. */
interface Findings {
  readonly globals: ReadonlySet<string>
  readonly methods: ReadonlySet<string>
}

/** Remove comments, string literals and template text, keeping the code and `${}` expressions. */
function strip(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source.charAt(index)
    const next = source.charAt(index + 1)
    if (char === '/' && next === '/') {
      while (index < source.length && source.charAt(index) !== '\n') index += 1
    } else if (char === '/' && next === '*') {
      index = source.indexOf('*/', index + 2)
      index = index === -1 ? source.length : index + 2
    } else if (char === "'" || char === '"') {
      index = skipQuoted(source, index)
      out += '""'
    } else if (char === '`') {
      index = skipTemplate(source, index + 1)
      out += '""'
    } else {
      out += char
      index += 1
    }
  }
  return out
}

/** The index after the quoted string that opens at `start`. */
function skipQuoted(source: string, start: number): number {
  const quote = source.charAt(start)
  let index = start + 1
  while (index < source.length && source.charAt(index) !== quote) {
    index += source.charAt(index) === '\\' ? 2 : 1
  }
  return index + 1
}

/** The index after the template that opens just before `start`; its `${}` parts are dropped whole. */
function skipTemplate(source: string, start: number): number {
  let index = start
  while (index < source.length && source.charAt(index) !== '`') {
    if (source.charAt(index) === '\\') index += 2
    else if (source.charAt(index) === '$' && source.charAt(index + 1) === '{') {
      index = skipBraces(source, index + 2)
    } else index += 1
  }
  return index + 1
}

/** The index after the `}` that closes an expression whose `{` is just before `start`. */
function skipBraces(source: string, start: number): number {
  let depth = 1
  let index = start
  while (index < source.length && depth > 0) {
    const char = source.charAt(index)
    if (char === '`') index = skipTemplate(source, index + 1)
    else if (char === "'" || char === '"') index = skipQuoted(source, index)
    else {
      if (char === '{') depth += 1
      if (char === '}') depth -= 1
      index += 1
    }
  }
  return index
}

/** The names a source brings in or declares itself, which are not globals. */
function ownNames(code: string): Set<string> {
  const names = new Set<string>()
  const imports = /import\s+(?:type\s+)?([^;]*?)\s+from\s*""/g
  for (const match of code.matchAll(imports)) {
    for (const word of (match[1] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) names.add(word[0])
  }
  const declared =
    /\b(?:class|const|let|var|function|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g
  for (const match of code.matchAll(declared)) names.add(match[1] ?? '')
  return names
}

/** The globals a source calls a static on or constructs, and every method name it calls. */
function scan(source: string): Findings {
  const code = strip(source)
  const own = ownNames(code)
  const globals = new Set<string>()
  const statics = /(?<![.\w$])([A-Z][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g
  const constructed = /\bnew\s+([A-Z][\w$]*)/g
  const called = /(?<![.\w$])(Boolean|BigInt|Symbol|String|Number|Object|Array)\s*\(/g
  for (const pattern of [statics, constructed, called]) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1] ?? ''
      if (!own.has(name) && name in globalThis) globals.add(name)
    }
  }
  const methods = new Set<string>()
  for (const match of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) methods.add(match[1] ?? '')
  return { globals, methods }
}

/** The own property names of an object, as strings. */
function namesOf(value: unknown): string[] {
  return value === undefined || value === null ? [] : Object.getOwnPropertyNames(value)
}

/** The method names some baselined built-in (constructor or prototype) has. */
function baselinedMethods(): Set<string> {
  const names = new Set<string>()
  for (const global of BASELINED_GLOBALS) {
    const constructor = (globalThis as unknown as Record<string, { prototype?: object }>)[global]
    for (const name of [...namesOf(constructor), ...namesOf(constructor?.prototype)]) {
      names.add(name)
    }
  }
  return names
}

/** The method names only a built-in outside the baseline has, with the built-in that has it. */
function otherOnlyMethods(): Map<string, string> {
  const baselined = baselinedMethods()
  const only = new Map<string, string>()
  for (const global of OTHER_BUILTINS) {
    const constructor = (globalThis as unknown as Record<string, { prototype?: object }>)[global]
    for (const name of [...namesOf(constructor), ...namesOf(constructor?.prototype)]) {
      if (!baselined.has(name) && !only.has(name)) only.set(name, global)
    }
  }
  return only
}

/** What a scan found that is neither baselined nor exempt, as readable lines. */
function unexplained(found: Findings): string[] {
  const lines: string[] = []
  for (const name of found.globals) {
    if (!BASELINED_GLOBALS.includes(name) && !(name in EXEMPT_GLOBALS)) {
      lines.push(`global ${name} is neither baselined nor exempt`)
    }
  }
  const only = otherOnlyMethods()
  for (const method of found.methods) {
    const owner = only.get(method)
    if (owner !== undefined && !(method in EXEMPT_METHODS)) {
      lines.push(`.${method}( is only on ${owner} and is not exempt`)
    }
  }
  return lines
}

describe('the sources of the protected paths', () => {
  it.each(PATHS)('%s calls only baselined or exempt built-ins', (path) => {
    const found = scan(readFileSync(join(ROOT, path), 'utf8'))

    expect(unexplained(found)).toEqual([])
  })

  it('keeps every exemption in use, so the table cannot outlive the code it excuses', () => {
    const all = PATHS.map((path) => scan(readFileSync(join(ROOT, path), 'utf8')))
    const globals = new Set(all.flatMap((found) => [...found.globals]))
    const methods = new Set(all.flatMap((found) => [...found.methods]))

    expect(Object.keys(EXEMPT_GLOBALS).filter((name) => !globals.has(name))).toEqual([])
    expect(Object.keys(EXEMPT_METHODS).filter((name) => !methods.has(name))).toEqual([])
  })

  it('has a reason for every exemption', () => {
    for (const reason of [...Object.values(EXEMPT_GLOBALS), ...Object.values(EXEMPT_METHODS)]) {
      expect(reason.length).toBeGreaterThan(10)
    }
  })
})

/** Whether a source iterates implicitly: a `for...of`, a spread, or a destructuring of an array. */
function iterates(source: string): boolean {
  return (
    /\bfor\s*\([^)]*\bof\b/.test(source) ||
    /\.\.\.[\w([]/.test(source) ||
    /\[[\w\s,]+\]\s*=/.test(source)
  )
}

describe('implicit iteration in the protected paths', () => {
  const ITERATORS: readonly [string, object][] = [
    ['the Array iterator', Object.getPrototypeOf([][Symbol.iterator]()) as object],
    ['the Set iterator', Object.getPrototypeOf(new Set()[Symbol.iterator]()) as object],
    ['the Map iterator', Object.getPrototypeOf(new Map()[Symbol.iterator]()) as object],
    ['the String iterator', Object.getPrototypeOf(''[Symbol.iterator]()) as object],
  ]

  it('is present, so the iterator prototypes belong in the baseline', () => {
    const sources = PATHS.map((path) => readFileSync(join(ROOT, path), 'utf8'))

    expect(sources.some((source) => iterates(strip(source)))).toBe(true)
  })

  it.each(ITERATORS)('is refused while %s has a replaced next', (_label, prototype) => {
    const original = Object.getOwnPropertyDescriptor(prototype, 'next')!
    let thrown: unknown
    try {
      Object.defineProperty(prototype, 'next', { ...original, value: () => ({ done: true }) })
      assertPrototypeClean()
    } catch (error) {
      thrown = error
    } finally {
      Object.defineProperty(prototype, 'next', original)
    }

    expect(thrown).toBeDefined()
  })

  it('the scan sees a for-of, a spread and an array destructuring', () => {
    expect(iterates('for (const x of list) {}')).toBe(true)
    expect(iterates('const all = [...list]')).toBe(true)
    expect(iterates('const [a, b] = pair')).toBe(true)
    expect(iterates('const n = list.length')).toBe(false)
  })
})

/** The top-level arguments of the call whose `(` is at `open`, each trimmed. */
function argumentsOf(code: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let index = open; index < code.length; index += 1) {
    const char = code.charAt(index)
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    if (depth === 0) {
      args.push(code.slice(start, index).trim())
      break
    }
    if (depth === 1 && char === ',') {
      args.push(code.slice(start, index).trim())
      start = index + 1
    }
  }
  return args
}

/**
 * How many times a source hands `defineProperty` a descriptor that is not a bare name. The built-in
 * reads `get` and `set` off a descriptor through its prototype chain, so a literal throws, or defines an
 * accessor, while either name is planted on `Object.prototype`; a parenthesized literal, a call that
 * returns one and a spread are all that, and only a name can be built with no prototype.
 */
function descriptorLiterals(source: string): number {
  const code = strip(source)
  let count = 0
  for (const match of code.matchAll(/defineProperty\s*\(/g)) {
    const descriptor = argumentsOf(code, match.index + match[0].length - 1)[2] ?? ''
    if (!/^[A-Za-z_$][\w$]*$/.test(descriptor)) count += 1
  }
  return count
}

/**
 * The descriptor literals each protected source may keep, with why. Every one runs while the guard has
 * passed, or on a host's own object; where it does not, the descriptor has no prototype.
 */
const EXEMPT_DESCRIPTORS: Record<string, { count: number; reason: string }> = {
  'config/read-by-name.ts': {
    count: 2,
    reason: 'copies host options at setup, after the guard has passed; a planted get fails closed',
  },
  'config/snapshot-options.ts': {
    count: 1,
    reason: 'copies host options at setup, after the guard has passed; a planted get fails closed',
  },
  'config/guarded-read.ts': {
    count: 1,
    reason: 'attaches the cause to a refusal that is thrown anyway; a planted get replaces it',
  },
}

describe('descriptors in the protected paths', () => {
  it.each(PATHS)('%s writes no descriptor literal it has not excused', (path) => {
    const found = descriptorLiterals(readFileSync(join(ROOT, path), 'utf8'))

    expect(found).toBe(EXEMPT_DESCRIPTORS[path]?.count ?? 0)
  })

  it('has a reason for every excused descriptor', () => {
    for (const { reason } of Object.values(EXEMPT_DESCRIPTORS)) {
      expect(reason.length).toBeGreaterThan(10)
    }
  })

  it('the scan sees a literal and ignores a named descriptor', () => {
    expect(descriptorLiterals('Object.defineProperty(target, key, { value: 1 })')).toBe(1)
    expect(descriptorLiterals('defineProperty(options, key, {\n value: undefined,\n})')).toBe(1)
    expect(descriptorLiterals('defineProperty(options, key, SHADOW_DESCRIPTOR)')).toBe(0)
    expect(descriptorLiterals("// defineProperty(a, 'b', { value: 1 })")).toBe(0)
    expect(descriptorLiterals('defineProperty(options, key, ({ value: undefined }))')).toBe(1)
    expect(descriptorLiterals('defineProperty(options, pick(key, 1), { value: 1 })')).toBe(1)
    expect(descriptorLiterals('defineProperty(options, key, { ...base, value: 1 })')).toBe(1)
    expect(descriptorLiterals('defineProperty(options, key, make(key))')).toBe(1)
  })
})

describe('the scan can fail', () => {
  it('finds a static call on a global the baseline lacks', () => {
    const found = scan('export const top = (a: number, b: number): number => Math.max(a, b)')

    expect(unexplained(found)).toEqual(['global Math is neither baselined nor exempt'])
  })

  it('finds a method only a non-baselined built-in has', () => {
    const found = scan('export const when = (stamp: unknown): unknown => stamp.getTime()')

    expect(unexplained(found)).toEqual(['.getTime( is only on Date and is not exempt'])
  })

  it('finds a constructed global that is neither baselined nor exempt', () => {
    expect(unexplained(scan('const url = new URL(text)'))).toEqual([
      'global URL is neither baselined nor exempt',
    ])
  })

  it('ignores a name the file imports or declares, and anything in a comment or a string', () => {
    const source = [
      "import { Math } from './math'",
      '// Buffer.from(x)',
      "const text = 'Date.now() and .getTimezoneOffset('",
      'const sum = Math.max(1, 2)',
      'const t = `${Object.keys(x)} Buffer.alloc(1)`',
    ].join('\n')

    expect(unexplained(scan(source))).toEqual([])
  })
})
