import type { Config } from 'jest'
import base from './jest.config'

/**
 * Coverage gate configuration. Enforces 100% line/branch/function/statement
 * coverage on every implemented file. Index barrels are excluded because they
 * only re-export and carry no executable branches.
 */
const config: Config = {
  ...base,
  collectCoverage: true,
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
}

export default config
