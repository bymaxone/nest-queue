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
      'coverage/**',
      'node_modules/**',
      '.stryker-tmp/**',
      'test/consumer-app/**',
      '*.config.ts',
      'jest.*.config.ts',
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
      globals: { console: 'readonly', process: 'readonly' },
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
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Decorator-only test classes are intentional — not extraneous in NestJS DI context.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Empty method bodies in test processor stubs are intentional placeholders.
      '@typescript-eslint/no-empty-function': 'off',
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
