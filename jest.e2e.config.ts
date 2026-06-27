import type { Config } from 'jest'
import base from './jest.config.ts'

/**
 * End-to-end test configuration. Targets specs under `test/e2e` that exercise
 * the library against a real Redis instance (Testcontainers). The package name
 * is mapped to the source entry points so fixtures consume the public API
 * exactly as a downstream app would. Worker count stays capped at 50% (from the
 * base config) so only one Redis container is exercised at a time.
 */
const config: Config = {
  ...base,
  roots: ['<rootDir>/test/e2e'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  collectCoverageFrom: undefined,
  testTimeout: 30_000,
  // Testcontainers keeps a background reaper connection alive for the process;
  // force a clean exit once the suite (which stops the container) has finished.
  forceExit: true,
  moduleNameMapper: {
    '^@bymax-one/nest-queue/shared$': '<rootDir>/src/shared/index.ts',
    '^@bymax-one/nest-queue$': '<rootDir>/src/server/index.ts',
  },
}

export default config
