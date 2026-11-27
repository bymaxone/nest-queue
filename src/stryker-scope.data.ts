/**
 * @fileoverview The mutation-scope facts specific to this library, read by `stryker-scope.spec.ts`: which
 * shipped files `mutate` leaves out and why, and what the shipped closure must contain.
 * @layer tests
 *
 * The spec is the family template and is copied byte for byte; everything that differs between libraries
 * lives here. This file is data for that spec, so `stryker.config.json` does not mutate it.
 */
import type { Exclusion } from './stryker-scope.spec'

/** The shipped files `mutate` does not select, each with the property that justifies leaving it out. */
export const EXCLUSIONS: readonly Exclusion[] = [
  {
    kind: 'barrel',
    reason:
      'Re-exports only: there is no statement to mutate, and a barrel that gains logic fails this spec.',
    files: ['src/server/index.ts', 'src/shared/index.ts', 'src/observability/index.ts'],
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

/** What the closure of the package entries must contain, so an empty closure cannot pass the checks vacuously. */
export const EXPECTED = {
  entries: 3,
  includes: ['src/server/index.ts', 'src/shared/index.ts', 'src/observability/index.ts'],
  shipped: 74,
} as const

/** Shipped files that are data rather than code: none, this package ships bundles only. */
export const SHIPPED_DATA: readonly { readonly path: string; readonly tsupNeedle: string }[] = []

/** The end-to-end suite that owns excluded files, or `null` when no exclusion is owned that way. */
export const E2E_OWNED: { readonly suites: readonly string[]; readonly subpath: string } | null =
  null
