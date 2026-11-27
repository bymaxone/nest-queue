/**
 * @fileoverview Holds the README to the public members of the library's own classes: every public
 * method and property of a class that an entry exports is named in the README as code, so a member
 * added to the published declarations without a line of documentation fails here. The check goes by
 * the member's name, not by its class. The classes of BullMQ that the main entry re-exports are
 * BullMQ's to document and are left out.
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
 * Whether the Markdown `text` names the member `name` as code. A word of prose does not count. In a
 * fenced block or an inline code span the name counts after a dot or before `(` or `<`, and an
 * inline span that is exactly the name counts too. A longer identifier does not name it, so
 * `enqueue` is not named by `enqueueBulk`.
 */
function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const member = new RegExp(`\\.${escaped}(?![\\w$])|(?<![\\w$])${escaped}[(<]`)
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm
  const blocks = [...text.matchAll(fence)].map(([, body = '']) => body)
  const spans = [...text.replace(fence, '').matchAll(/`([^`\n]+)`/g)].map(([, span = '']) => span)
  return spans.includes(name) || [...blocks, ...spans].some((code) => member.test(code))
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

describe('naming a member in Markdown', () => {
  it('accepts the member form in an inline code span', () => {
    expect(names('call `queue.enqueue(job)` first', 'enqueue')).toBe(true)
    expect(names('read `service.isOwned` first', 'isOwned')).toBe(true)
    expect(names('then `list()`', 'list')).toBe(true)
    expect(names('then `get<Job>(id)`', 'get')).toBe(true)
  })

  it('accepts a span that is exactly the name', () => {
    expect(names('read `state` here', 'state')).toBe(true)
  })

  it('accepts the member form in a fenced block', () => {
    expect(names('```ts\nawait flows.close()\n```\n', 'close')).toBe(true)
  })

  it('does not accept a word of prose, or a bare word inside code', () => {
    expect(names('close the list (ping) of queue.check here', 'close')).toBe(false)
    expect(names('close the list (ping) of queue.check here', 'ping')).toBe(false)
    expect(names('close the list (ping) of queue.check here', 'check')).toBe(false)
    expect(names('run `pnpm run check` now', 'check')).toBe(false)
    expect(names('```sh\npnpm run check\n```\n', 'check')).toBe(false)
  })

  it('does not accept the name inside a longer identifier', () => {
    expect(names('`enqueueBulk()`', 'enqueue')).toBe(false)
    expect(names('`reenqueue()`', 'enqueue')).toBe(false)
    expect(names('`queue.enqueue_all`', 'enqueue')).toBe(false)
    expect(names('`queue.enqueue2`', 'enqueue')).toBe(false)
    expect(names('`$enqueue()`', 'enqueue')).toBe(false)
    expect(names('`queue.enqueue$`', 'enqueue')).toBe(false)
  })

  it('reads a name with a dollar sign as the literal it is', () => {
    expect(names('read `this.$state` here', '$state')).toBe(true)
    expect(names('read `this.state` here', '$state')).toBe(false)
  })
})
