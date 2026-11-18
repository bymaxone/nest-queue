import { defineConfig, type Options } from 'tsup'

/**
 * Shared bundling configuration for both subpaths. `bullmq`, `ioredis`, every
 * `@nestjs/*` package, and `reflect-metadata` stay external so they are never
 * bundled — the library declares them as peer dependencies and resolves them
 * from the host application at runtime.
 */
const common: Options = {
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  outDir: 'dist',
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
  external: [/^@nestjs\//, 'reflect-metadata', 'bullmq', 'ioredis'],
  target: 'node24',
  splitting: false,
  treeshake: true,
  sourcemap: false,
  clean: false,
}

export default defineConfig([
  { entry: { 'server/index': 'src/server/index.ts' }, ...common },
  { entry: { 'shared/index': 'src/shared/index.ts' }, ...common },
  {
    // The optional entry imports the main entry as a package, never a copy of it: the observer
    // registry the host's module provides and the one this entry injects must be one class.
    entry: { 'observability/index': 'src/observability/index.ts' },
    ...common,
    external: [
      ...(common.external ?? []),
      '@bymax-one/nest-queue',
      /^@bymax-one\/nest-core(\/|$)/,
      'prom-client',
      /^@opentelemetry\//,
    ],
  },
])
