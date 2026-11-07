import type { Config } from 'jest'

import base from './jest.config.ts'

/**
 * Jest configuration for `scripts/mutate-const-tables.mjs`. Type diagnostics are off so a removed
 * property that other code reads fails on an assertion rather than on the type check, which is
 * how a Stryker run would see it. Tests run in band: the script runs one mutant at a time.
 */
const config: Config = {
  ...base,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.jest.json', diagnostics: false }],
  },
  maxWorkers: 1,
}

export default config
