/**
 * Pins the mutation-testing scope to the code that ships. The shipped source is the closure of the relative imports
 * of the package entries in `tsup.config.ts`; every file in it must either be matched by `mutate` in
 * `stryker.config.json` or be listed below with the reason it is not. A file that is neither, a listed file that no
 * longer exists, a listed file that `mutate` still matches, and a listed file whose kind no longer holds all fail,
 * so an exclusion cannot go stale or hide runtime code behind a name such as `index.ts`.
 *
 * Layer: repository tooling, tests.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import * as ts from 'typescript'

const ROOT = resolve(__dirname, '..')

/** Why shipped files are not mutated, and the property that justifies it, checked against the files. */
type ExclusionKind = 'barrel' | 'types' | 'constants'

interface Exclusion {
  readonly kind: ExclusionKind
  readonly reason: string
  readonly files: readonly string[]
}

/** Every shipped source file that `mutate` leaves out. */
const EXCLUSIONS: readonly Exclusion[] = [
  {
    kind: 'barrel',
    reason:
      'Re-exports only: there is no statement to mutate, and a barrel that gains logic fails this spec.',
    files: ['src/server/index.ts', 'src/shared/index.ts'],
  },
  {
    kind: 'types',
    reason:
      'Types only: it compiles to nothing, and a runtime declaration added to it fails this spec.',
    files: ['src/server/interfaces/*.interface.ts', 'src/shared/types/*.types.ts'],
  },
  {
    kind: 'constants',
    reason:
      'Constant data with no logic, judged one entry at a time by the const-table mutation check ' +
      '(`pnpm mutation:const-tables`), which Stryker cannot do for a literal table; logic added to one fails this spec.',
    files: ['src/server/bymax-queue.constants.ts', 'src/server/constants/*.ts'],
  },
]

/** The text of a file under the repository root. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** A glob (`**`, `*`, literal text) as a regular expression over repository-relative paths. */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i)
    if (rest.startsWith('**/')) {
      source += '(?:.*/)?'
      i += 2
    } else if (rest.startsWith('**')) {
      source += '.*'
      i += 1
    } else if (glob[i] === '*') {
      source += '[^/]*'
    } else {
      source += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** Whether the path is selected by the `mutate` list: patterns apply in order, `!` removes. */
function mutated(path: string, mutate: readonly string[]): boolean {
  let selected = false
  for (const entry of mutate) {
    const negated = entry.startsWith('!')
    if (globToRegExp(negated ? entry.slice(1) : entry).test(path)) selected = !negated
  }
  return selected
}

/** The package entry files named by `tsup.config.ts`. */
function entries(): string[] {
  return [...read('tsup.config.ts').matchAll(/entry:\s*\{\s*'[^']+':\s*'([^']+)'/g)].map(
    (match) => match[1]!,
  )
}

/** The relative module specifiers a source file imports or re-exports, as written. */
function relativeSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/?[^'"]*)['"]/g)].map(
    (match) => match[1]!,
  )
}

/** The file a relative specifier resolves to from `from`, or `undefined` when it is not TypeScript source. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  return [`${base}.ts`, `${base}/index.ts`].find((candidate) => existsSync(join(ROOT, candidate)))
}

/** The source closure of the package entries: every non-spec file they reach through relative imports. */
function shippedSource(): string[] {
  const seen = new Set<string>()
  const queue = entries()
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue
    seen.add(path)
    for (const specifier of relativeSpecifiers(read(path))) {
      const next = resolveSpecifier(path, specifier)
      if (next !== undefined) queue.push(next)
    }
  }
  return [...seen].sort()
}

/** Every shipped file a listed exclusion matches, with the exclusion that matched it. */
function excluded(shipped: readonly string[]): Map<string, Exclusion> {
  const found = new Map<string, Exclusion>()
  for (const exclusion of EXCLUSIONS) {
    for (const pattern of exclusion.files) {
      const matcher = globToRegExp(pattern)
      for (const path of shipped) if (matcher.test(path)) found.set(path, exclusion)
    }
  }
  return found
}

/** The statements the compiler emits for the source, without the module boilerplate every file gets. */
function emittedStatements(text: string): string[] {
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      removeComments: true,
    },
  })
  return outputText
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        line !== '"use strict";' &&
        line !== 'Object.defineProperty(exports, "__esModule", { value: true });' &&
        !line.startsWith('//'),
    )
}

/** The source with comments removed. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The syntax kinds that make a file logic rather than data. */
const LOGIC_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.NewExpression,
])

/** Arithmetic over number literals alone (`24 * 3600`): a constant written out, not a decision. */
function isLiteralArithmetic(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) return true
  if (ts.isParenthesizedExpression(node)) return isLiteralArithmetic(node.expression)
  return (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
      node.operatorToken.kind,
    ) &&
    isLiteralArithmetic(node.left) &&
    isLiteralArithmetic(node.right)
  )
}

/** The names of the logic constructs a source file contains: none for a file that is only constant data. */
function logicIn(text: string): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (LOGIC_KINDS.has(node.kind) && !isLiteralArithmetic(node)) {
      found.push(ts.SyntaxKind[node.kind])
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('file.ts', text, ts.ScriptTarget.ES2022, true))
  return found
}

const mutateList = (JSON.parse(read('stryker.config.json')) as { mutate: string[] }).mutate
const shipped = shippedSource()
const listed = excluded(shipped)

describe('mutation scope', () => {
  /** An empty closure would make every other check pass vacuously. */
  it('finds the shipped source from the package entries', () => {
    expect(entries()).toHaveLength(2)
    expect(shipped).toEqual(expect.arrayContaining(['src/server/index.ts', 'src/shared/index.ts']))
    expect(shipped.length).toBeGreaterThan(30)
  })

  /** A shipped file is mutated or its absence is explained; nothing is left out by accident. */
  it('mutates every shipped file that is not listed with a reason', () => {
    const unexplained = shipped.filter((path) => !mutated(path, mutateList) && !listed.has(path))
    expect(unexplained).toEqual([])
  })

  /** A listed file that `mutate` still selects would be both mutated and excused. */
  it('lists no file that mutate still selects', () => {
    expect([...listed.keys()].filter((path) => mutated(path, mutateList))).toEqual([])
  })

  /** A listed pattern that matches no shipped file is a reason about code that is gone. */
  it('lists no pattern that matches no shipped file', () => {
    for (const exclusion of EXCLUSIONS) {
      for (const pattern of exclusion.files) {
        expect({
          pattern,
          matches: shipped.filter((path) => globToRegExp(pattern).test(path)).length,
        }).not.toEqual({
          pattern,
          matches: 0,
        })
      }
      expect(exclusion.reason.length).toBeGreaterThan(20)
    }
  })

  /** A barrel holds re-exports only: any other statement is code the exclusion would hide. */
  it('keeps every listed barrel to re-exports', () => {
    const reexport =
      /(?:export|import)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+'[^']+'/g
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'barrel') continue
      expect({ path, rest: withoutComments(read(path)).replace(reexport, '').trim() }).toEqual({
        path,
        rest: '',
      })
    }
  })

  /** A types-only file compiles to nothing: the compiler, not a list of keywords, decides what is runtime. */
  it('keeps every listed types file free of runtime output', () => {
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'types') continue
      expect({ path, emitted: emittedStatements(read(path)) }).toEqual({ path, emitted: [] })
    }
  })

  /** The check sees what a keyword scan cannot: re-exports, default exports, namespaces and bare calls. */
  it('detects runtime output in a types file that a keyword scan misses', () => {
    expect(
      emittedStatements(
        "export type A = { a: 1 }\nexport interface B { b: A }\nimport type { C } from './c'",
      ),
    ).toEqual([])
    expect(emittedStatements("export { value } from './runtime'")).not.toEqual([])
    expect(emittedStatements('export default { a: 1 }')).not.toEqual([])
    expect(emittedStatements('export namespace N { export const x = 1 }')).not.toEqual([])
    expect(emittedStatements('Object.freeze({})')).not.toEqual([])
  })

  /** A constants file holds data only: any logic in it is code the exclusion would hide from the mutation run. */
  it('keeps every listed constants file free of logic', () => {
    for (const [path, exclusion] of listed) {
      if (exclusion.kind !== 'constants') continue
      expect({ path, logic: logicIn(read(path)) }).toEqual({ path, logic: [] })
    }
  })

  /** The constants exclusion is only honest while the const-table check that owns those files exists. */
  it('keeps the const-table mutation check that owns the listed constants', () => {
    expect(read('package.json')).toContain('"mutation:const-tables"')
    expect(existsSync(join(ROOT, 'scripts/mutate-const-tables.mjs'))).toBe(true)
  })

  /** The check sees logic a name-based scan cannot: a function, a branch or a constructor call. */
  it('detects logic in a constants file that a name scan misses', () => {
    expect(logicIn("export const A = { a: 'a' } as const\nexport const B = Symbol('b')")).toEqual(
      [],
    )
    expect(logicIn('export const A = () => 1')).not.toEqual([])
    expect(logicIn("export const A = process.env.X ? 'a' : 'b'")).not.toEqual([])
    expect(logicIn('export const A = new Map()')).not.toEqual([])
    expect(logicIn('export const A = 24 * 3600')).toEqual([])
    expect(logicIn('export const A = B * 3600')).not.toEqual([])
    expect(logicIn('export const A = 1 < 2')).not.toEqual([])
  })
})
