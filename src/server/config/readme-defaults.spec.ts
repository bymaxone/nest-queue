/**
 * @fileoverview Pins the README's option-defaults table and error-code catalog to the code.
 * @layer server/config
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Telemetry } from 'bullmq'
import { BymaxQueueModule } from '../bymax-queue.module'
import { DEFAULT_JOB_OPTIONS } from '../constants/default-options'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { applyDefaults } from './resolved-options'

// The README ships inside the npm package, so a wrong default there is read by every consumer and
// nothing else compiles it: `check:published` type-checks the fenced snippets, not the tables.
const readme = readFileSync(resolve(__dirname, '../../../README.md'), 'utf8')

const connection: BymaxQueueModuleOptions['connection'] = { url: 'redis://localhost:6379' }

/** The lines of one `##` section, up to the next `##` heading. */
function section(heading: string): string[] {
  const lines = readme.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`))
  if (start === -1) throw new Error(`README has no "${heading}" section`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
}

/** The rows of every Markdown table in the lines whose first cell is a code span, as trimmed cells. */
function tableRows(lines: string[]): string[][] {
  return lines
    .filter((line) => line.startsWith('| `'))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    )
}

/** Read a README number such as `5_000` or `1 000`. */
function num(text: string): number {
  return Number(text.replace(/[_\s]/g, ''))
}

/** Seconds in a README age such as `24 h` or `7 d`. */
function seconds(text: string): number {
  const match = /^(\d+) (h|d)$/.exec(text)
  if (match === null) throw new Error(`unreadable age "${text}"`)
  return Number(match[1]) * (match[2] === 'h' ? 3600 : 86_400)
}

const rows = tableRows(section('⚙️ Configuration')).map(([option = '', , fallback = '']) => ({
  option: option.replaceAll('`', ''),
  fallback,
}))
const documented = new Map(rows.map(({ option, fallback }) => [option, fallback]))

const resolved = applyDefaults({ connection })

/** Where each documented option lives on the resolved options, as a dotted path. */
const leaves: Record<string, unknown> = {
  prefix: resolved.prefix,
  queueOptions: resolved.queueOptions,
  'flows.enabled': resolved.flows.enabled,
  'metrics.enabled': resolved.metrics.enabled,
  'metrics.cacheTtlMs': resolved.metrics.cacheTtlMs,
  'shutdown.drainTimeoutMs': resolved.shutdown.drainTimeoutMs,
  'shutdown.drainOnShutdown': resolved.shutdown.drainOnShutdown,
  connectionReadyTimeoutMs: resolved.connectionReadyTimeoutMs,
  isGlobal: BymaxQueueModule.forRoot({ connection }).global,
}

/** Options whose value is itself an object that the table documents as a single row. */
const SINGLE_ROW_OPTIONS = new Set(['defaultJobOptions', 'queueOptions', 'telemetry'])

/** Every option the module accepts, read off the resolved shape instead of listed by hand. */
const accepted = [
  ...Object.entries(applyDefaults({ connection, telemetry: {} as Telemetry })).flatMap(
    ([key, value]) =>
      typeof value === 'object' && !SINGLE_ROW_OPTIONS.has(key)
        ? Object.keys(value).map((inner) => `${key}.${inner}`)
        : [key],
  ),
  'connection',
  'isGlobal',
]

describe('README Configuration table', () => {
  // A row for an option that does not exist, a missing row for one that does, or a row listed twice
  // is the drift this guards: the table is the only place a consumer learns the full option list.
  it('documents exactly the options the module accepts, once each', () => {
    expect(rows.map(({ option }) => option).sort()).toEqual([...accepted].sort())
  })

  // The two options with no default must say so, rather than quote a value that is not applied.
  it('shows no default for connection and telemetry, and the code applies none', () => {
    expect(documented.get('connection')).toBe('—')
    expect(documented.get('telemetry')).toBe('—')
    expect(resolved.telemetry).toBeUndefined()
  })

  it.each(Object.keys(leaves))('quotes the default of %s as the code applies it', (option) => {
    const text = documented.get(option)?.replaceAll('`', '')
    const actual = leaves[option]

    if (typeof actual === 'string') expect(text).toBe(`'${actual}'`)
    else if (typeof actual === 'number') expect(num(text ?? '')).toBe(actual)
    else if (typeof actual === 'boolean') expect(text).toBe(String(actual))
    else expect(text).toBe(JSON.stringify(actual))
  })

  // Free text with four numbers in it: read the numbers back out and compare each to the constant.
  it('quotes the default job options as DEFAULT_JOB_OPTIONS holds them', () => {
    const text = (documented.get('defaultJobOptions') ?? '').replaceAll('`', '')
    const attempts = /attempts: (\d+)/.exec(text)?.[1]
    const delay = /exponential backoff (\d+) ms/.exec(text)?.[1]
    const complete = /removeOnComplete: \{ age: (\d+ [hd]), count: (\d+) \}/.exec(text)
    const failed = /removeOnFail: \{ age: (\d+ [hd]), count: (\d+) \}/.exec(text)

    expect(DEFAULT_JOB_OPTIONS.backoff.type).toBe('exponential')
    expect(Number(attempts)).toBe(DEFAULT_JOB_OPTIONS.attempts)
    expect(Number(delay)).toBe(DEFAULT_JOB_OPTIONS.backoff.delay)
    expect(seconds(complete?.[1] ?? '')).toBe(DEFAULT_JOB_OPTIONS.removeOnComplete.age)
    expect(Number(complete?.[2])).toBe(DEFAULT_JOB_OPTIONS.removeOnComplete.count)
    expect(seconds(failed?.[1] ?? '')).toBe(DEFAULT_JOB_OPTIONS.removeOnFail.age)
    expect(Number(failed?.[2])).toBe(DEFAULT_JOB_OPTIONS.removeOnFail.count)
  })
})

describe('README error-code catalog', () => {
  // Every code is either thrown (first table) or reserved (second), never both and never absent.
  it('lists each published error code exactly once', () => {
    const listed = tableRows(section('🚨 Error Code Catalog')).map(([code = '']) =>
      code.replaceAll('`', ''),
    )

    expect(listed.sort()).toEqual(Object.values(QUEUE_ERROR_CODES).sort())
  })
})

describe('README export coverage', () => {
  /** The names an entry file exports, from its `export { ... }` and `export type { ... }` lists. */
  function exportedNames(entry: string): string[] {
    const source = readFileSync(resolve(__dirname, entry), 'utf8')
    return [...source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap(([, list = '']) =>
      list
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    )
  }

  // The README is the only place a consumer learns what the package exports, and a public name it
  // never mentions is one nobody can find. Naming it anywhere counts, so the check stays cheap.
  it.each(['../index.ts', '../../shared/index.ts'])('names every export of %s', (entry) => {
    const missing = exportedNames(entry).filter((name) => !new RegExp(`\\b${name}\\b`).test(readme))

    expect(missing).toEqual([])
  })
})
