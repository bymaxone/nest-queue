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
}

export default config
