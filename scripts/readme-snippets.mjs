/**
 * @fileoverview README snippet gate — compiles every TypeScript block in the README against
 * the built package, the way a consumer resolving through `exports` sees it.
 * @layer scripts
 *
 * Three properties keep a wrong option, method or field from passing:
 *
 * - Syntactic and semantic diagnostics are read together through the compiler API. The `tsc`
 *   command stops after the syntax errors, so one unparsable snippet would hide every semantic
 *   error in the others and in the type tests.
 * - Every snippet is compiled. One that does not import the package gets its public names
 *   imported, so an example that omits the import still makes a checked claim.
 * - The names a snippet takes from its surrounding prose are declared, typed, in
 *   `readme-prelude.d.ts`, so a call through one of them is checked instead of resolving to `any`,
 *   and any other undeclared name is an error.
 *
 * Run after `pnpm build`: the snippets compile against `dist/`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')

/** A throwaway consumer built by this script. Nothing outside it is touched, and
 * it is portable: the sibling libraries have no consumer fixture to borrow.
 *
 * The package is symlinked into its own `node_modules` so TypeScript resolves it
 * through the published `exports` map into `dist/` — exactly what a consumer
 * sees — while peers still resolve by walking up to the repository's own
 * `node_modules`. */
const GATE_DIR = join(ROOT, '.docs-gate')

/** The published type tests, compiled here against `dist/` as well. Empty when a
 * library has none — the check then covers only the README snippets. */
const TYPE_TESTS_GLOB = existsSync(join(ROOT, 'test', 'types')) ? '../test/types/**/*.ts' : '*.ts'

/** Create `.docs-gate/` with the package symlinked into its own `node_modules`.
 * `paths` is emptied: the repository tsconfig maps the package name to `./src`,
 * which is precisely the mapping that has to be out of the way here. */
function scaffoldConsumer() {
  rmSync(GATE_DIR, { recursive: true, force: true })
  const scope = join(GATE_DIR, 'node_modules', ...PKG.name.split('/').slice(0, -1))
  mkdirSync(scope, { recursive: true })
  // 'junction' rather than 'dir': a directory symlink needs elevation or Developer
  // Mode on Windows, where a junction does not. Node ignores the type on POSIX.
  symlinkSync(ROOT, join(GATE_DIR, 'node_modules', PKG.name), 'junction')
  writeFileSync(
    join(GATE_DIR, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '../tsconfig.json',
        compilerOptions: {
          noEmit: true,
          rootDir: '..',
          baseUrl: '.',
          // `baseUrl` blanks out the inherited `paths`, and TypeScript 6 reports it as the
          // deprecation error TS5101; the flag accepts it so this generated config compiles.
          ignoreDeprecations: '6.0',
          paths: {},
          noUnusedLocals: false,
          // A README snippet may name a handler parameter it does not use; that is
          // prose, not an API defect.
          noUnusedParameters: false,
          // A React snippet is JSX; without this it fails to parse for a reason
          // that says nothing about the published API. Inert when there is none.
          jsx: 'react-jsx',
        },
        include: ['*.ts', '*.tsx', TYPE_TESTS_GLOB],
      },
      null,
      2,
    )}\n`,
  )
  // The names a snippet uses without introducing them, typed for real.
  copyFileSync(join(ROOT, 'scripts', 'readme-prelude.d.ts'), join(GATE_DIR, 'prelude.d.ts'))
}

// ---------------------------------------------------------------------------
// Receivers
// ---------------------------------------------------------------------------

/**
 * Exported classes of the built package's root entry, by name.
 *
 * Only the root entry: `writeReceiverDeclarations` imports these from the root
 * specifier, and a subpath like `./shared` is not re-exported there, so
 * harvesting from it would emit an import of a member the root does not export.
 *
 * Only classes: a class name is usable directly as its instance type, so nothing
 * has to infer a value from a type-only export. The trailing `export { ... }`
 * list is the authority on what ships; `declare class` alone can name an
 * internal the bundler kept.
 *
 * @returns The class names a receiver may be bound to.
 */
function exportedClasses() {
  const dts = join(ROOT, 'dist', 'server', 'index.d.ts')
  if (!existsSync(dts)) return new Set()
  const src = readFileSync(dts, 'utf8')
  const declared = new Set([...src.matchAll(/^declare class ([A-Za-z0-9_]+)/gm)].map((m) => m[1]))
  const names = new Set()
  for (const list of src.matchAll(/^export \{([^}]*)\};?$/gm)) {
    for (const raw of list[1].split(',')) {
      const name = raw.trim()
      if (name && !name.startsWith('type ') && declared.has(name)) names.add(name)
    }
  }
  return names
}

/**
 * Collect the `this.<name>` receivers a snippet itself declares or assigns, by
 * parsing it rather than matching its text.
 *
 * A rewrite must leave such a receiver alone for two reasons, both meaning it
 * would make the check worse rather than better: the snippet already gives the
 * receiver a type, in which case TypeScript checks it natively and a binding
 * would silently substitute a different one; or the snippet assigns to it, which
 * a `const` cannot accept. The declaring forms are class properties, annotated or
 * initialised, with or without modifiers, and constructor parameter properties,
 * with or without decorators. Reading syntax nodes means an options-object key, a
 * plain constructor parameter, a string holding a brace or a decorator argument
 * holding a parenthesis cannot be mistaken for any of them.
 *
 * @param code - The snippet source.
 * @param ext - The snippet's file extension, `ts` or `tsx`, which decides how JSX is read.
 * @returns The receiver names the snippet declares or assigns.
 */
function declaredReceivers(code, ext) {
  const declared = new Set()
  const sourceFile = ts.createSourceFile(`snippet.${ext}`, code, ts.ScriptTarget.Latest, true)
  const parameterProperty =
    ts.ModifierFlags.Public |
    ts.ModifierFlags.Private |
    ts.ModifierFlags.Protected |
    ts.ModifierFlags.Readonly
  const visit = (node) => {
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text)
    } else if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      ts.isIdentifier(node.name) &&
      (ts.getCombinedModifierFlags(node) & parameterProperty) !== 0
    ) {
      declared.add(node.name.text)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      declared.add(node.left.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return declared
}

/**
 * Rewrite `this.<name>` receivers a snippet never declares into declared
 * constants, and return the bindings that type them.
 *
 * Binding is name-based and nothing else: a receiver binds only where its
 * PascalCased name **is** an exported class, as `this.metricsService` is
 * `MetricsService`. Inferring the class from anywhere else — a snippet's sole
 * import, say — cannot separate `this.mailer` in a snippet importing
 * `QueueService` from the receiver such a rule is meant to catch, and binding a
 * local helper to a package class fails a correct README. A gate that can
 * redden correct documentation is worse than one that misses a receiver, so the
 * inference stops at the name.
 *
 * An unresolved receiver is therefore never rewritten, so this pass can only add
 * checks and never introduces a diagnostic about anything but the documented
 * package API. A receiver whose property name is not its class name is typed by
 * `SnippetContext` in `readme-prelude.d.ts` instead.
 *
 * @param code - The snippet source.
 * @param classes - Exported class names of the built package.
 * @param slot - The snippet's index, which scopes the generated names.
 * @param ext - The snippet's file extension, `ts` or `tsx`.
 * @returns The rewritten source and the receiver bindings it needs.
 */
function bindReceivers(code, classes, slot, ext) {
  const bound = new Map()
  const names = new Set([...code.matchAll(/\bthis\.([a-z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]))
  const declared = declaredReceivers(code, ext)
  let rewritten = code
  for (const name of names) {
    const cls = name[0].toUpperCase() + name.slice(1)
    if (!classes.has(cls) || declared.has(name)) continue
    bound.set(name, cls)
    rewritten = rewritten.replace(new RegExp(`\\bthis\\.${name}\\b`, 'g'), `__ctx_${slot}_${name}`)
  }
  return { rewritten, bound }
}

/**
 * Emit the bound receivers as ambient globals, in a file of their own so every
 * snippet keeps its original line numbers — a diagnostic then points at the line
 * the reader sees in the README rather than at one this gate shifted.
 *
 * Names are scoped per snippet rather than merged by property name: two snippets
 * may each write `this.service` for a different class, and one shared
 * declaration would compile one of them against the other's API.
 *
 * @param bindings - `<slot>_<prop>` → the exported class that types it.
 */
function writeReceiverDeclarations(bindings) {
  const imports = [...new Set(bindings.values())].sort().join(', ')
  const consts = [...bindings]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cls]) => `  const __ctx_${key}: ${cls}`)
    .join('\n')
  writeFileSync(
    join(GATE_DIR, 'receivers.d.ts'),
    `import type { ${imports} } from '${PKG.name}'\n\ndeclare global {\n${consts}\n}\n`,
  )
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** Names a snippet binds itself: imported, or declared at its top level. */
function boundNames(code) {
  const source = ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.Latest, true)
  const names = new Set()
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const { name, namedBindings } = node.importClause
      if (name) names.add(name.text)
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) names.add(element.name.text)
      } else if (namedBindings) {
        names.add(namedBindings.name.text)
      }
    } else if ('name' in node && node.name && ts.isIdentifier(node.name)) {
      names.add(node.name.text)
    }
  }
  return names
}

/** `import { values, type Types } from '<pkg>'` for every name the package exports that the
 * snippet does not bind itself, read from the built declaration file so it cannot drift from
 * `dist/`. A snippet that shows `BymaxQueueModule.forRoot(...)` and imports only a service
 * further down still makes a claim about the module's options. */
function publicImports(taken) {
  const entry = join(ROOT, 'dist', 'server', 'index.d.ts')
  const program = ts.createProgram({ rootNames: [entry], options: { skipLibCheck: true } })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entry)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  const names = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []
  const parts = names
    .filter((symbol) => !taken.has(symbol.name))
    .map((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      return target.flags & ts.SymbolFlags.Value ? symbol.name : `type ${symbol.name}`
    })
  return parts.length > 0 ? `import { ${parts.join(', ')} } from '${PKG.name}'` : ''
}

/** Top-level `export`ed names per snippet file, so a relative import can be resolved to the
 * README snippet that defines what it imports. */
function snippetExports(blocks) {
  const exporters = new Map()
  blocks.forEach(({ code }, i) => {
    const file = `snippet-${String(i + 1).padStart(2, '0')}`
    for (const m of code.matchAll(
      /^export\s+(?:abstract\s+|declare\s+)?(?:class|function|const|let|interface|type|enum)\s+(\w+)/gm,
    )) {
      exporters.set(m[1], file)
    }
  })
  return exporters
}

/** Point each relative import at the snippet that exports one of the names it imports. An
 * import no snippet satisfies is left alone and fails to resolve, so it is reported. */
function resolveRelativeImports(importText, exporters) {
  return importText.replace(
    /^(import\s[\s\S]*?from\s+)(['"])(\.{1,2}\/[^'"]*)\2/m,
    (whole, head, quote) => {
      const imported = [...head.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => m[1])
      const file = imported.map((n) => exporters.get(n)).find((f) => f !== undefined)
      return file === undefined ? whole : `${head}${quote}./${file}${quote}`
    },
  )
}

const IMPORT = /^import\s(?:[\s\S]*?from\s+)?['"][^'"]+['"]\s*;?\n/gm

/**
 * Turn a README fragment into something a compiler can check without changing what it
 * claims: a snippet gets the package's public names it does not bind itself, and a relative
 * import resolves to the snippet that exports it; a
 * decorated method fragment is put in a class that holds the context services; a block of
 * statements is put in an async function whose `this` holds them, so `await` and
 * `this.queue` mean what the prose means. A snippet that declares classes or types is left
 * as written.
 *
 * Imports move into the header and leave blank lines behind, so the snippet body keeps the
 * README's line numbers; `offset` is the number of lines the header adds.
 *
 * @param code - The snippet source.
 * @param exporters - Exported name → the snippet file that defines it.
 * @returns The text to compile and the number of header lines before the snippet body.
 */
function prepareSnippet(code, exporters) {
  const imports = (code.match(IMPORT) ?? []).map((i) => resolveRelativeImports(i, exporters))
  // `{ ... }` is how a snippet says "the usual arguments". Left alone it is a parse
  // error, and a parse error in a call hides every semantic error around it.
  const body = code
    .replace(IMPORT, (m) => '\n'.repeat(m.split('\n').length - 1))
    .replaceAll('{ ... }', '{} as never')
  const missing = publicImports(boundNames(code))
  const header = `${missing ? `${missing}\n` : ''}${imports.join('')}`
  const declares = /^(export\s+)?(abstract\s+)?(class|interface|type|enum|function)\s/m.test(body)
  const decoratedMethod = /^@\w+\([^)]*\)\s*\n\s*(async\s+)?\w+\s*\(/m.test(body)
  let prefix = header
  let suffix = ''
  if (decoratedMethod) {
    prefix = `${header}class SnippetController extends SnippetBase {\n`
    suffix = '}\n'
  } else if (!declares) {
    prefix = `${header}async function snippet(this: SnippetContext) {\n`
    suffix = '}\n'
  }
  return { text: `${prefix}${body}${suffix}`, offset: prefix.split('\n').length - 1 }
}

/**
 * Write each snippet into the gate directory, with its receivers bound and its header
 * added, and emit the ambient declarations that type the bound receivers.
 *
 * @param blocks - Every TypeScript block of the README.
 * @returns What the author wrote per file, and the header lines each file carries.
 */
function writeSnippetFiles(blocks) {
  const classes = exportedClasses()
  const exporters = snippetExports(blocks)
  const sources = new Map()
  const offsets = new Map()
  /** `<slot>_<prop>` → the exported class that types it. */
  const bindings = new Map()
  blocks.forEach(({ ext, code }, i) => {
    const name = `snippet-${String(i + 1).padStart(2, '0')}.${ext}`
    const { rewritten, bound } = bindReceivers(code, classes, i, ext)
    for (const [prop, cls] of bound) bindings.set(`${i}_${prop}`, cls)
    const { text, offset } = prepareSnippet(rewritten, exporters)
    // The abbreviated-type check reads what the author wrote, not the header added here.
    sources.set(name, code)
    offsets.set(name, offset)
    writeFileSync(join(GATE_DIR, name), text)
  })
  if (bindings.size > 0) writeReceiverDeclarations(bindings)
  return { sources, offsets }
}

/** Whether a snippet imports the package itself. */
function importsPackage(code) {
  return new RegExp(`from ['"]${PKG.name}`).test(code)
}

/**
 * Compile the consumer project and return every diagnostic as a `tsc`-shaped line,
 * syntactic and semantic together, with snippet line numbers mapped back to the README's.
 *
 * @param offsets - Snippet file name → header lines before the snippet body.
 * @returns One line per diagnostic.
 */
function compileGate(offsets) {
  const config = ts.readConfigFile(join(GATE_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, GATE_DIR)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, ' ')
    if (!d.file) return `error TS${String(d.code)}: ${text}`
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0)
    const where = relative(ROOT, d.file.fileName).split(sep).join('/')
    const shift = offsets.get(where.split('/').pop() ?? '') ?? 0
    // A diagnostic in the generated header has no README line to point at.
    const position =
      line < shift ? 'header' : `${String(line + 1 - shift)},${String(character + 1)}`
    return `${where}(${position}): error TS${String(d.code)}: ${text}`
  })
}

/** Diagnostics that say nothing about the published API: a snippet that elides code with
 * `…` or shows a bare `return` is prose at that point, not a program. */
const CONTEXT_ONLY = new Set(['TS1108', 'TS1109'])

/** `Property 'x' does not exist on type 'Y'` is an API defect when `Y` comes from the
 * package, and snippet noise when `Y` is a class the snippet declares itself and
 * abbreviates — a README example routinely writes `this.repo` without spelling out the
 * constructor that injects it. Decided by looking for the declaration in the same snippet. */
function isAbbreviatedLocalType(line, sources) {
  const m = /Property '[^']+' does not exist on type '([^']+)'/.exec(line)
  if (!m) return false
  const file = /^([^(]+)\(/.exec(line)?.[1]
  // `tsc` emits backslashes on Windows, so the basename is taken on either.
  const own = (sources.get(file?.split(/[\\/]/).pop() ?? '') ?? '').replace(IMPORT, '')
  // The type text is escaped: it can hold `<`, `[`, `.` or `|`. Imports are left out of the
  // search, so `import type Foo from` is not mistaken for a declaration of `Foo`.
  const escaped = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(class|interface|type)\\s+${escaped}\\b`).test(own)
}

/** An import of some OTHER package the fixture does not install — a documented optional
 * integration. Reported as uncovered, not as a failure. A relative specifier is never foreign:
 * it must resolve to a README snippet that exports what it imports. Neither is the package
 * itself or any subpath of it: those resolve through `exports`, so one that does not is a
 * wrong import. */
function isForeignModule(line) {
  if (!/error TS2307/.test(line)) return false
  const specifier = /Cannot find module '([^']+)'/.exec(line)?.[1] ?? ''
  const ownPackage = specifier === PKG.name || specifier.startsWith(`${PKG.name}/`)
  return !specifier.startsWith('.') && !ownPackage
}

/**
 * Compile every TypeScript block of the README against `dist/` and record a failure for
 * each diagnostic about the published API.
 *
 * @param fail - Records a failure without stopping the run.
 */
export function checkSnippets(fail) {
  // `tsx` too, and the fence language is kept: a React example has to be written to a .tsx
  // file or it does not parse.
  const blocks = [...README.matchAll(/^```(ts|typescript|tsx)\n([\s\S]*?)^```$/gm)].map((m) => ({
    ext: m[1] === 'tsx' ? 'tsx' : 'ts',
    code: m[2],
  }))
  if (!blocks.some((b) => importsPackage(b.code))) {
    fail('snippets', 'no README snippet imports the package — the gate would be vacuous')
    return
  }
  scaffoldConsumer()
  const { sources, offsets } = writeSnippetFiles(blocks)
  try {
    const lines = compileGate(offsets)
    if (process.env.GATE_DEBUG) console.log(lines.join('\n'))
    const real = lines.filter(
      (l) =>
        !CONTEXT_ONLY.has((/error (TS\d+)/.exec(l) ?? [])[1]) &&
        !isForeignModule(l) &&
        !isAbbreviatedLocalType(l, sources),
    )
    if (real.length > 0) {
      fail(
        'snippets',
        `${real.length} README snippet error(s) about the published API:\n${real.map((l) => `      ${l}`).join('\n')}`,
      )
    }
    const ignored = lines.length - real.length
    console.log(
      `  snippets: ${blocks.length} compiled against dist/` +
        (ignored > 0
          ? ` (${ignored} diagnostic(s) ignored: a peer the fixture does not install, or a parse-level elision)`
          : ''),
    )
  } finally {
    rmSync(GATE_DIR, { recursive: true, force: true })
  }
}
