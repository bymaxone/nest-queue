// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * Flat ESLint configuration (v9). Type-aware linting on the source tree with the
 * strict + stylistic typescript-eslint presets. Prettier is applied last to
 * disable formatting rules that would conflict with the formatter.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      // Shared templates copied byte for byte from bymaxone/.github: their bytes are the contract, so no
      // fixer may rewrite them.
      'scripts/check-function-length.mjs',
      'scripts/function-length-key.mjs',
      'scripts/check-dist-fresh.mjs',
      'scripts/check-dist-fresh.test.mjs',
      'scripts/commitlint-no-ai-attribution.cjs',
      'src/check-function-length.spec.ts',
      'src/check-function-length.baseline.spec.ts',
      'src/check-function-length.key.spec.ts',
      'src/stryker-scope.spec.ts',
      'coverage/**',
      'node_modules/**',
      '.stryker-tmp/**',
      'test/consumer-app/**',
      '*.config.ts',
      'jest.*.config.ts',
      // Compiled by the README snippet gate against `dist/` in its own throwaway project.
      'scripts/readme-prelude.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    // Plain-JavaScript tooling (build scripts, this config) is not part of the
    // TypeScript program, so the type-aware rules have no type information to
    // work with and must be switched off for these files. They still get the
    // syntactic rules, which is what catches an unused binding or a bad regex in
    // a release-gate script.
    files: ['**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // `fetch` is a Node global from 18 onward and this package requires 24, but
      // `no-undef` only knows the globals it is told about. Declared rather than
      // silenced with an inline disable, so the next script that uses it is
      // covered too.
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        // CommonJS tooling (the commitlint config and plugin) uses `module.exports` and `require`.
        module: 'readonly',
        require: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      // The release-gate scripts report each assertion with `cond ? pass() : fail()`.
      // The ternary IS the statement there, and spelling it out as if/else nine
      // times obscures the one-line-per-assertion shape the output mirrors.
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
    },
  },
  {
    // `require` is how a CommonJS file loads a module; there is no import form to prefer.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // A Nest module that only lists providers is a decorated class with no members, which is the
    // whole of what the framework needs from it.
    files: ['src/observability/observability.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }] },
  },
  {
    // AGENTS.md: a function over 50 lines is a finding for what a change introduces. Lines are
    // counted raw (blank lines and comments included), the way a reviewer reads the file. Tests are
    // out of scope: their unit is the body of a single `it`, and `describe` callbacks are grouping
    // constructs this rule cannot tell apart.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    // An `eslint-disable` comment would otherwise accept a long function without a trace: inline
    // configuration is ignored here, so the directive does nothing and the rule still reports.
    linterOptions: { noInlineConfig: true },
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Decorator-only test classes are intentional — not extraneous in NestJS DI context.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Empty method bodies in test processor stubs are intentional placeholders.
      '@typescript-eslint/no-empty-function': 'off',
      // Test doubles are plain objects typed as the BullMQ, Nest and ioredis classes they stand in for; the rule stays on for src.
      '@typescript-eslint/no-unsafe-class-instance-assignment': 'off',
    },
  },
  {
    // The E2E fixtures model a CONSUMER application and are compiled by ts-jest
    // with `emitDecoratorMetadata` on (tsconfig.e2e-jest.json), because that is
    // what a NestJS app has. A class named only as a constructor parameter type
    // is therefore a RUNTIME use there — the metadata references the binding —
    // even though the same shape is type-only everywhere else in this package,
    // where the flag is off to match the published bundle. Converting these to
    // `import type` erases the binding and the fixture's dependency arrives
    // undefined, which is how the DLQ and flow E2E suites failed once already.
    files: ['test/e2e/fixtures/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // The README Quick Start is run as written, and its handler is `async` with no `await`
    // and returns `Promise<void>`, which is what a reader copies.
    files: ['src/readme-quick-start.spec.ts'],
    rules: {
      '@typescript-eslint/no-invalid-void-type': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['test/types/**/*.ts'],
    rules: {
      // The invariant-equality helper compares two generic signatures that each
      // mention their type parameter once; that single use is the whole point of
      // the idiom, so the "used only once" heuristic does not apply here.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  prettier,
)
