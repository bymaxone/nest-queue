import type { Config } from 'jest'
import base from './jest.config'

/**
 * End-to-end test configuration. Targets specs under `test/e2e` that exercise
 * the library against a real Redis instance. Passes with no tests until the
 * suite is populated.
 */
const config: Config = {
  ...base,
  roots: ['<rootDir>/test/e2e'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  collectCoverageFrom: undefined,
}

export default config
