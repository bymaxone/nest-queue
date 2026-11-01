import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * Jest configuration consumed by the Stryker mutation-testing runner. Coverage
 * collection is disabled because Stryker tracks mutant kills itself.
 */
const config: Config = {
  ...base,
  collectCoverage: false,
  coverageThreshold: undefined,
  // Keep a mutated async error (settling after its test) from crashing the
  // long-lived mutation worker and aborting the run.
  setupFiles: ['<rootDir>/test/stryker-jest-setup.ts'],
  // `check-api-surface.spec.ts` and `strip-bundle-comments.spec.ts` run a repository script on
  // fixture directories and touch no code in `src`, so they kill no mutant; `pnpm test` still runs
  // them.
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? ['/node_modules/']),
    '/check-api-surface\\.spec\\.ts$',
    '/strip-bundle-comments\\.spec\\.ts$',
  ],
}

export default config
