/**
 * Pins `scripts/strip-bundle-comments.mjs`, the post-build step that removes the comments from
 * the shipped JavaScript bundles.
 *
 * Layer: repository tooling, tests. The script is plain Node and is run here the way the build
 * runs it, as a child process over a small `dist/` directory, so the files it leaves behind and
 * its exit code are what the cases assert.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'strip-bundle-comments.mjs')

const roots: string[] = []

/** Lays out `{ dist/server/<files> }` and returns the `dist` directory. */
function layout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'strip-bundle-spec-'))
  roots.push(root)
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, 'dist', 'server', name), text)
  }
  return join(root, 'dist')
}

function run(dist: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, dist], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const read = (dist: string, name: string): string =>
  readFileSync(join(dist, 'server', name), 'utf8')

/** Whether Node accepts the file as syntactically valid JavaScript. */
function parses(dist: string, name: string): boolean {
  return (
    spawnSync(process.execPath, ['--check', join(dist, 'server', name)], { encoding: 'utf8' })
      .status === 0
  )
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('strip-bundle-comments', () => {
  // The point of the step: prose that no runtime reads leaves the bundle, the code does not change.
  it('removes block comments, line comments and trailing comments', () => {
    const dist = layout({
      'index.mjs': [
        '/**',
        ' * Documented.',
        ' */',
        'export const a = 1 // trailing',
        '// a comment on its own line',
        'export const b = /* inline */ 2',
        '',
      ].join('\n'),
    })

    expect(run(dist).status).toBe(0)

    expect(read(dist, 'index.mjs')).toBe('export const a = 1\nexport const b = 2\n')
  })

  it('removes several comments that share one line', () => {
    const dist = layout({ 'index.mjs': 'const a = 1 /* one */ /* two */ // three\n' })

    run(dist)

    expect(read(dist, 'index.mjs')).toBe('const a = 1\n')
  })

  // Two comments alone on a line go together with the line, and the code after it stays.
  it('removes a line that holds only several comments without touching the next line', () => {
    const dist = layout({ 'index.mjs': '/* one */ /* two */\nexport const x = 1\n' })

    run(dist)

    expect(read(dist, 'index.mjs')).toBe('export const x = 1\n')
  })

  // A block comment that spans lines is a line break to the parser: `return` followed by one and
  // then a value returns nothing. Removing the comment outright would make it return the value.
  it('keeps the line break a multi-line comment stood for after `return`', () => {
    const dist = layout({
      'index.mjs': [
        'function f() {',
        '  return /* first',
        '     second */ 1',
        '}',
        'console.log(String(f()))',
        '',
      ].join('\n'),
    })
    const before = spawnSync(process.execPath, [join(dist, 'server', 'index.mjs')], {
      encoding: 'utf8',
    }).stdout

    run(dist)

    const after = spawnSync(process.execPath, [join(dist, 'server', 'index.mjs')], {
      encoding: 'utf8',
    }).stdout
    expect(before).toBe('undefined\n')
    expect(after).toBe(before)
  })

  it('removes a comment inside an empty block and one at the end of the file', () => {
    const dist = layout({ 'index.mjs': 'function f() { /* nothing */ }\n// last line\n' })

    run(dist)

    expect(read(dist, 'index.mjs')).toBe('function f() { }\n')
  })

  // Legal text must travel with the bundle.
  it.each([
    ['a /*! legal */ block', '/*! Copyright */'],
    ['a //! legal line', '//! Copyright'],
    ['an @license block', '/** @license MIT */'],
    ['an @preserve block', '/* @preserve keep me */'],
  ])('keeps %s', (_label, comment) => {
    const dist = layout({ 'index.mjs': `${comment}\nexport const a = 1\n` })

    run(dist)

    expect(read(dist, 'index.mjs')).toBe(`${comment}\nexport const a = 1\n`)
  })

  // A consumer's bundler uses these annotations to drop unused calls, so the count must not move.
  it('keeps every __PURE__ and __NO_SIDE_EFFECTS__ annotation', () => {
    const source = [
      'const a = /* @__PURE__ */ make()',
      'const b = /* #__PURE__ */ make()',
      '/* @__NO_SIDE_EFFECTS__ */',
      'function make() {',
      '  return /* @__PURE__ */ other()',
      '}',
      '',
    ].join('\n')
    const dist = layout({ 'index.mjs': source })

    run(dist)

    const count = (text: string): number =>
      (text.match(/__PURE__|__NO_SIDE_EFFECTS__/g) ?? []).length
    expect(count(read(dist, 'index.mjs'))).toBe(count(source))
  })

  // esbuild writes `// src/...` between modules; they tell a reader which file a stretch came from.
  it('keeps the region markers and removes other line comments', () => {
    const dist = layout({
      'index.mjs': '// src/server/a.ts\nconst a = 1\n// note\n// src/server/b.ts\nconst b = 2\n',
    })

    run(dist)

    expect(read(dist, 'index.mjs')).toBe(
      '// src/server/a.ts\nconst a = 1\n// src/server/b.ts\nconst b = 2\n',
    )
  })

  // Text that only looks like a comment is data; only the parser can tell it from one.
  it('leaves comment-like text inside strings, template literals and regular expressions alone', () => {
    const source = [
      "const url = 'http://example.com/*not a comment*/'",
      'const tpl = `a // b ${1 /* real */} /* c */`',
      'const re = /\\/\\/ not a comment/',
      'const block = "/* still a string */"',
      '',
    ].join('\n')
    const dist = layout({ 'index.mjs': source })

    run(dist)

    expect(read(dist, 'index.mjs')).toBe(source.replace(' /* real */', ''))
  })

  it('gives the same bytes when it runs twice', () => {
    const dist = layout({
      'index.mjs':
        '/** a */\nexport const a = 1 // b\n// src/x.ts\nexport const c = /* @__PURE__ */ f()\n',
    })

    run(dist)
    const once = read(dist, 'index.mjs')
    run(dist)

    expect(read(dist, 'index.mjs')).toBe(once)
  })

  // The output must still load: stripping a comment can never leave invalid syntax behind.
  it.each(['index.mjs', 'index.cjs'])('leaves %s as valid JavaScript', (name) => {
    const body =
      name === 'index.mjs'
        ? '/** doc */\nexport const a = 1 // x\nexport default /* y */ { a }\n'
        : "'use strict'\n/** doc */\nconst a = 1 // x\nmodule.exports = /* y */ { a }\n"
    const dist = layout({ [name]: body })

    run(dist)

    expect(parses(dist, name)).toBe(true)
  })

  // Declarations carry the documentation people read in an editor; only the two bundles are touched.
  it('never touches a declaration file or any other file', () => {
    const dts = '/** Documented. */\nexport declare const a: number\n'
    const other = '// helper\nconst a = 1\n'
    const dist = layout({
      'index.mjs': '// gone\nconst a = 1\n',
      'index.d.ts': dts,
      'index.d.cts': dts,
      'helper.mjs': other,
    })

    run(dist)

    expect(read(dist, 'index.d.ts')).toBe(dts)
    expect(read(dist, 'index.d.cts')).toBe(dts)
    expect(read(dist, 'helper.mjs')).toBe(other)
  })

  it('fails when there is no bundle to strip', () => {
    const dist = layout({ 'index.d.ts': 'export {}\n' })

    const { status, output } = run(dist)

    expect(status).toBe(1)
    expect(output).toContain('run the build first')
  })
})
