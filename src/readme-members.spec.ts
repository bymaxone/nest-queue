/**
 * @fileoverview Holds the README to the public members of the library's own classes: every public
 * method and property of a class that an entry exports is named in the README, so a member added to
 * the published declarations without a line of documentation fails here. The classes of BullMQ that
 * the main entry re-exports are BullMQ's to document and are left out.
 * @layer test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

const ROOT = join(__dirname, '..')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

/** The classes of BullMQ the main entry re-exports as types. */
const BULLMQ = new Set(['Job', 'Queue', 'QueueEvents', 'Worker', 'FlowProducer'])

/** Whether the declaration is private or protected, which is not public API. */
function hasHiddenModifier(declaration: ts.Declaration): boolean {
  const modifiers = ts.getCombinedModifierFlags(declaration)
  return (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
}

/**
 * Whether `text` names the identifier `name`: it appears with no identifier character, a letter,
 * a digit, `_` or `$`, directly before or after it, so `enqueue` is not named by `enqueueBulk`.
 */
function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text)
}

/** `Class.member` for every public member of every class an entry file exports, from the sources. */
function publicMembers(entries: string[]): string[] {
  const program = ts.createProgram(
    entries.map((entry) => join(ROOT, entry)),
    { skipLibCheck: true, experimentalDecorators: true },
  )
  const checker = program.getTypeChecker()
  const found: string[] = []
  for (const entry of entries) {
    const source = program.getSourceFile(join(ROOT, entry))
    const module = source === undefined ? undefined : checker.getSymbolAtLocation(source)
    if (module === undefined) continue
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      if (!(symbol.flags & ts.SymbolFlags.Class) || BULLMQ.has(exported.getName())) continue
      for (const [key, member] of symbol.members ?? []) {
        const name = String(key)
        const declaration = member.declarations?.[0]
        if (declaration === undefined || name.startsWith('__') || name.startsWith('#')) continue
        if (hasHiddenModifier(declaration)) continue
        found.push(`${exported.getName()}.${name}`)
      }
    }
  }
  return found
}

describe('README member coverage', () => {
  const members = publicMembers(['src/server/index.ts', 'src/observability/index.ts'])

  it('finds the public members of the library classes, so an empty list cannot pass', () => {
    expect(members).toEqual(
      expect.arrayContaining(['QueueService.enqueue', 'WorkerRegistry.register']),
    )
    expect(members.length).toBeGreaterThan(30)
  })

  it('names every one of them', () => {
    const missing = members.filter((member) => {
      const name = member.split('.')[1] ?? ''
      return !names(readme, name)
    })

    expect(missing).toEqual([])
  })
})

describe('naming an identifier in text', () => {
  it('accepts the name as a word, in code or in prose', () => {
    expect(names('call `queue.enqueue(job)` first', 'enqueue')).toBe(true)
    expect(names('enqueue', 'enqueue')).toBe(true)
  })

  it('does not accept the name inside a longer identifier', () => {
    expect(names('call enqueueBulk', 'enqueue')).toBe(false)
    expect(names('call reenqueue', 'enqueue')).toBe(false)
    expect(names('call enqueue_all', 'enqueue')).toBe(false)
    expect(names('call enqueue2', 'enqueue')).toBe(false)
    expect(names('call $enqueue', 'enqueue')).toBe(false)
    expect(names('call enqueue$', 'enqueue')).toBe(false)
  })

  it('reads a name with a dollar sign as the literal it is', () => {
    expect(names('read `$state` here', '$state')).toBe(true)
    expect(names('read a state here', '$state')).toBe(false)
  })
})
