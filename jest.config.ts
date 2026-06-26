import type { Config } from 'jest'

/**
 * Base Jest configuration. Specs are transformed by ts-jest against the
 * CommonJS-flavored `tsconfig.jest.json`. Worker count is capped at 50% to keep
 * memory bounded in CI and local runs.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.jest.json',
        isolatedModules: true,
      },
    ],
  },
  clearMocks: true,
  restoreMocks: true,
  passWithNoTests: true,
  maxWorkers: '50%',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/index.ts',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
}

export default config
