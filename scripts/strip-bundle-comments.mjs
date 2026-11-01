#!/usr/bin/env node
/**
 * @fileoverview Post-build step: removes the comments from the shipped JavaScript bundles.
 * @layer scripts
 *
 * tsup builds without minifying, so esbuild leaves every JSDoc block and `//` comment in
 * `dist/**\/index.mjs` and `index.cjs`. About half of those bundles' brotli size is that prose,
 * which a consumer's runtime never reads: the documentation people see in an editor comes from
 * the `.d.ts` and `.d.cts` files, and this script never touches them.
 *
 * What is removed and what is kept:
 * - Every comment goes, and a line that held only a comment goes with it, so the code keeps its
 *   structure, its identifiers and its line-by-line shape. A stack frame still points at readable
 *   code, which minifying the whitespace would not give.
 * - Kept: `/*!` and `//!` blocks, `@license` and `@preserve`, the `__PURE__` and
 *   `__NO_SIDE_EFFECTS__` annotations (a consumer's bundler uses them to drop unused calls), and
 *   the `// src/...` region markers esbuild writes between modules, which tell a reader which
 *   source file a stretch of the bundle came from.
 * - The TypeScript parser finds the comments, so text that only looks like one, inside a string,
 *   a template literal or a regular expression, is never touched.
 *
 * Running it twice gives the same bytes. Usage (from the package root):
 *   node scripts/strip-bundle-comments.mjs            strips dist/
 *   node scripts/strip-bundle-comments.mjs <dir>      strips another directory, for tests
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const BUNDLE_FILE_RE = /^index\.(mjs|cjs)$/
const KEPT_COMMENT_RE = /^\/\*!|^\/\/!|@license|@preserve|__PURE__|__NO_SIDE_EFFECTS__|^\/\/ src\//

/**
 * Removes the comments of one bundle.
 *
 * @param {string} source - Contents of a `.mjs` or `.cjs` bundle.
 * @returns {string} The same code without its comments, apart from the kept ones.
 */
export function stripComments(source) {
  const file = ts.createSourceFile(
    'bundle.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const ranges = new Map()
  const collect = (node) => {
    // A token's comments are its leading trivia; the end of file token holds the last ones.
    for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      if (!KEPT_COMMENT_RE.test(source.slice(range.pos, range.end))) ranges.set(range.pos, range)
    }
    for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) {
      if (!KEPT_COMMENT_RE.test(source.slice(range.pos, range.end))) ranges.set(range.pos, range)
    }
    // JSDoc nodes are children too, but their text is comment text, not code.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return
    for (const child of node.getChildren(file)) collect(child)
  }
  collect(file)

  let output = source
  for (const { pos, end } of [...ranges.values()].sort((a, b) => b.pos - a.pos)) {
    const lineStart = output.lastIndexOf('\n', pos - 1) + 1
    const lineEndAt = output.indexOf('\n', end)
    const lineEnd = lineEndAt === -1 ? output.length : lineEndAt
    const before = output.slice(lineStart, pos)
    const after = output.slice(end, lineEnd)
    if (before.trim() === '' && after.trim() === '') {
      // The comment owned its line: remove the line, newline included.
      output = output.slice(0, lineStart) + output.slice(lineEndAt === -1 ? lineEnd : lineEnd + 1)
    } else {
      // Code shares the line: drop the comment and the blanks that separated it from the code. A
      // comment that spans lines counts as a line break to the parser (after `return` it ends the
      // statement), so one break stays when code follows it.
      const lineBreak =
        before.trim() !== '' && after.trim() !== '' && source.slice(pos, end).includes('\n')
      output =
        output.slice(0, pos - (before.length - before.trimEnd().length)) +
        (lineBreak ? '\n' : '') +
        output.slice(end)
    }
  }
  return output
}

/** The `index.mjs` and `index.cjs` files under `root`, never a declaration file. */
function bundleFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (BUNDLE_FILE_RE.test(entry)) found.push(path)
    }
  }
  walk(root)
  return found.sort()
}

function main() {
  const root = resolve(process.argv[2] ?? 'dist')
  const files = bundleFiles(root)
  if (files.length === 0) {
    console.error(`No index.mjs or index.cjs under ${root}: run the build first.`)
    return 1
  }
  for (const path of files) {
    const before = readFileSync(path, 'utf8')
    const after = stripComments(before)
    if (after !== before) writeFileSync(path, after)
    console.log(`${path}: ${before.length} -> ${after.length} bytes`)
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
