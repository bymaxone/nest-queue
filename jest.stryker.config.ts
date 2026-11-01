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
  // `check-api-surface.spec.ts` runs a repository script on fixture directories and touches no code
  // in `src`, so it kills no mutant; `pnpm test` still runs it.
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? ['/node_modules/']),
    '/check-api-surface\\.spec\\.ts$',
  ],
}

export default config
