/**
 * @fileoverview Pins the header rule for test files: every tracked spec opens with a block comment
 * that states its purpose (`@fileoverview`) and its layer (`@layer`), the form AGENTS.md asks of
 * every source file. The rule is read from the tracked files, so a new spec that skips the header
 * fails here instead of waiting for a reviewer to notice.
 * @layer repository tooling, tests
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

/** The leading block comment of a file, or an empty string when the file does not open with one. */
function leadingComment(text: string): string {
  const match = /^\s*\/\*\*[\s\S]*?\*\//.exec(text)
  return match === null ? '' : match[0]
}

/** Tracked spec files under `src/` and `test/`, as repository-relative paths. */
function trackedSpecs(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src', 'test'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\0').filter((path) => path.endsWith('.spec.ts') || path.endsWith('.test-d.ts'))
}

describe('spec file headers', () => {
  it('reads the header of a file that opens with a block comment and of one that does not', () => {
    // Guards the reader itself: a rule that passes on an empty read would prove nothing.
    expect(leadingComment('/**\n * @fileoverview a\n */\nimport x')).toContain('@fileoverview')
    expect(leadingComment('import x\n/** @fileoverview a */')).toBe('')
  })

  it('finds the tracked specs it is meant to check', () => {
    expect(trackedSpecs()).toContain('src/stryker-scope.spec.ts')
  })

  it('opens every tracked spec with a @fileoverview and a @layer tag', () => {
    const missing = trackedSpecs().flatMap((path) => {
      const header = leadingComment(readFileSync(join(ROOT, path), 'utf8'))
      const lacking = ['@fileoverview', '@layer'].filter((tag) => !header.includes(tag))
      return lacking.length === 0 ? [] : [`${path}: no ${lacking.join(' or ')}`]
    })
    expect(missing).toEqual([])
  })
})
