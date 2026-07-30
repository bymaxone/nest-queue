import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * Coverage gate configuration. Enforces 100% line/branch/function/statement
 * coverage on every implemented file. Index barrels are excluded because they
 * only re-export and carry no executable branches.
 */
const config: Config = {
  ...base,
  // The base config tolerates an empty run so a filtered invocation is not an
  // error. This config IS the 100% gate, and there it is the opposite: if the
  // roots or testMatch globs ever stop matching, Jest reports 0/0 — which no
  // percentage threshold can fail — and the gate goes green having verified
  // nothing. Fail loudly instead.
  passWithNoTests: false,
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
