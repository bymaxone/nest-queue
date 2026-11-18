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
      return !new RegExp(`\\b${name}\\b`).test(readme)
    })

    expect(missing).toEqual([])
  })
})
