# Phase 1 — Foundation: module, ConnectionResolver & base QueueService

> **Status**: 🔄 In Progress · **Progress**: 0 / 8 tasks · **Last updated**: 2026-06-26
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § Phase 1
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md)

---

## Context

The repository currently contains only `docs/` — the technical specification (`technical_specification.md`, the 21-section source of truth) and the development plan (`development_plan.md`, the 5-phase roadmap). There is no `src/`, no build chain, no `package.json`, and no CI. This is a greenfield public NestJS library that wraps BullMQ; the spec's invariants (§0) and the plan's guiding principles (§1.2) are the authoritative convention source.

Phase 1 produces the **first end-to-end usable slice**: a fully-gated project scaffold (2 subpath bundles, 100/100/100/100 coverage thresholds, Stryker `break 95`, an 18 KiB-brotli bundle budget), the public type/constant surface, every public interface, the DI tokens and defaults, the dual-mode `ConnectionResolver`, options resolution + validation, the base `QueueService` (queue cache + typed `enqueue`/`getJob`/`getMetrics`/control helpers), the `QueueException` error type, and the synchronous `BymaxQueueModule.forRoot()` built on `ConfigurableModuleBuilder`. When Phase 1 is done you can install the lib in a NestJS fixture, enqueue a job against a local Redis, and read its counts. **`forRootAsync`, decorators, workers, flows, schedulers, metrics caching, and graceful shutdown are out of scope here** — they land in later phases.

---

## Rules-of-phase

1. **TypeScript strict, zero `any`.** `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Where a BullMQ signature uses `any`, re-export it as `unknown` on the lib's public API — never widen the lib's own surface to `any`.
2. **Clean Code sizing.** Functions ≤ 50 lines; files ≤ 800 lines (200–400 typical). Split by responsibility when over the limit.
3. **One responsibility per file/function (SRP); SOLID throughout.** Explicit DI (no implicit metadata wiring beyond NestJS providers); DI tokens are `Symbol`.
4. **JSDoc on every exported symbol** (class, function, interface, type, constant), with `@example` where it clarifies usage.
5. **English-only and timeless comments** — no `Phase N`/`Task`/roadmap-stage references inside any committed file (code, config, or docs-as-config). Explain *what* and *why*, never *which roadmap stage*.
6. **100% line/branch coverage** on every implemented file (`jest.coverage.config.ts` thresholds `100/100/100/100`). No `eslint-disable`, no `@ts-ignore`, no `@ts-expect-error` to dodge a gate.
7. **Never create `.gitkeep`/`.keep` or empty-directory placeholders** — directories emerge from real files only (the `index.ts` placeholders in §2.1 are real files).
8. **Current BullMQ API only.** Built on `ConfigurableModuleBuilder` + `isGlobal`/`setExtras` (no `@Global`, no `forFeature`); recurring jobs use `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` (never `addRepeatable`); `cleanQueue(name, grace, limit, status?)` mirrors BullMQ argument order; per-role `maxRetriesPerRequest` (Queue/FlowProducer keep ioredis default; only duplicated Worker/QueueEvents connections are forced to `null`).
9. **Zero runtime `dependencies`.** `package.json` ships `"dependencies": {}`; everything is a peer dep (`@nestjs/common`, `@nestjs/core`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata`, optional `bullmq-otel`).
10. **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

---

## Reference docs

- [`docs/technical_specification.md`](../technical_specification.md) — § 2 "Architecture" (dual-mode connection, per-role retry policy §2.2/§2.3, init flow §2.4), § 3 "Package Structure" (directory tree §3.1, subpath exports §3.2, exports-per-subpath §3.3), § 4 "Configuration API" (`BymaxQueueModuleOptions` §4.1, async options §4.2, `ConfigurableModuleBuilder` registration §4.3, consolidated defaults §4.4), § 5 "Main Service" (`QueueService` methods §5.1–§5.9), § 12 "Error Code Catalog" (`QueueException` §12.1, catalog §12.2, code constants §12.3, response format §12.4, security §12.5), § 14 "Dependencies" (peer deps §14.1, zero direct deps §14.2).
- [`docs/development_plan.md`](../development_plan.md) — § 1.3 "Phase summary", § 1.4 "Global Done criteria per phase", § 2 "Phase 1 — Foundation + ConnectionResolver + base QueueService" (sub-steps §2.1–§2.8).
- `/bymax-workflow:standards` skill — universal coding rules (TypeScript track: type/lint discipline, JSDoc policy, layered architecture, typed errors, English-only, Conventional Commits).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1.1 | Project scaffold (build chain, configs, budgets) | 📋 ToDo | P0 | M | — |
| 1.2 | Shared types & constants (`src/shared/`) | 📋 ToDo | P0 | S | 1.1 |
| 1.3 | Public server interfaces & contracts | 📋 ToDo | P0 | M | 1.1 |
| 1.4 | DI tokens, default options & error messages | 📋 ToDo | P0 | S | 1.1, 1.2 |
| 1.5 | `ConnectionResolver`, `QueueException` & connection utils | 📋 ToDo | P0 | L | 1.3, 1.4 |
| 1.6 | Resolved options + bootstrap validation | 📋 ToDo | P0 | M | 1.3, 1.4 |
| 1.7 | Base `QueueService` (cache, enqueue, metrics, control) | 📋 ToDo | P0 | M | 1.3, 1.5, 1.6 |
| 1.8 | `BymaxQueueModule.forRoot()`, barrel & unit tests | 📋 ToDo | P0 | L | 1.1–1.7 |

---

## Tasks

### Task 1.1 — Project scaffold (build chain, configs, budgets)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: —

#### Description

Create the project root, the build/test/lint toolchain, and the package contract — mirroring the canonical `nest-auth` / `nest-logger` configs but with **2 subpaths** (`.` = server, `./shared`) and BullMQ + ioredis as peer deps. No library logic in this task: only configuration files plus placeholder `index.ts` entry points so the build and gates run green on an empty surface.

#### Acceptance criteria

- [ ] Directory structure created per the spec §3.1 tree (`src/server/`, `src/shared/`, `scripts/`).
- [ ] `package.json` declares `"type": "module"`, `"sideEffects": false`, `"dependencies": {}`, the 2-subpath `exports` map, peer deps (`@nestjs/common`/`@nestjs/core ^11`, `bullmq ^5.16.0`, `ioredis ^5.0.0`, `reflect-metadata ^0.2.0`, optional `bullmq-otel ^1.0.0` via `peerDependenciesMeta`), `engines.node >=24`, `packageManager pnpm@11`, and `publishConfig` with `provenance: true`.
- [ ] `tsup.config.ts` declares **2 entries** (`server/index`, `shared/index`), `format: ['esm','cjs']`, `dts: true`, `treeshake: true`, and externals including `bullmq`, `ioredis`, `reflect-metadata`, and `/^@nestjs\//`.
- [ ] tsconfig variants exist: `tsconfig.json`, `tsconfig.build.json`, `tsconfig.server.json`, `tsconfig.e2e.json`, `tsconfig.jest.json` (TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`).
- [ ] Jest variants exist: `jest.config.ts`, `jest.coverage.config.ts` (thresholds `100/100/100/100`), `jest.e2e.config.ts`, `jest.stryker.config.ts`; plus `stryker.config.json` with `thresholds { high: 99, low: 95, break: 95 }`.
- [ ] `eslint.config.mjs` (flat config v9), `.prettierrc`, `.gitignore`, `.npmignore`, `commitlint.config.cjs` exist.
- [ ] `scripts/check-size.mjs` enforces brotli budgets: `server ≤ 18432` (18 KiB), `shared ≤ 2500`.
- [ ] `src/server/index.ts` and `src/shared/index.ts` exist as placeholders (real files, not `.gitkeep`).
- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm build` all pass; `dist/server/` and `dist/shared/` are produced.

#### Files to create / modify

- `package.json`, `tsup.config.ts`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `.npmignore`, `commitlint.config.cjs`
- `tsconfig.json`, `tsconfig.build.json`, `tsconfig.server.json`, `tsconfig.e2e.json`, `tsconfig.jest.json`
- `jest.config.ts`, `jest.coverage.config.ts`, `jest.e2e.config.ts`, `jest.stryker.config.ts`, `stryker.config.json`
- `scripts/check-size.mjs`
- `src/server/index.ts`, `src/shared/index.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11), published to npm with provenance.

CURRENT PHASE: 1 (Foundation) — Task 1.1 of 8 (FIRST)

PRECONDITIONS
- The repo contains only `docs/` (technical_specification.md, development_plan.md). No source, no package.json, no build chain.

REQUIRED READING (only these — do not load more):
- `docs/technical_specification.md` § 3 "Package Structure" (the §3.1 directory tree, the §3.2 subpath `exports` map, the §3.3 per-subpath export lists).
- `docs/technical_specification.md` § 14 "Dependencies" (peer-dep set §14.1, the "zero direct dependencies" rule §14.2, optional `bullmq-otel` §14.3).
- `docs/development_plan.md` § 2.1 "Project scaffold" (the exact package.json key fields, tsup.config.ts, and check-size budgets).

TASK
Scaffold the build/test/lint toolchain and the package contract. Mirror the canonical nest-auth / nest-logger configs but with TWO subpaths (server + shared) and bullmq + ioredis as peer deps. Write NO library logic — only configuration files and placeholder entry points so the build and gates run green on an empty surface.

DELIVERABLES

1. `package.json` (key fields — copy and adapt from the plan §2.1):
   ```json
   {
     "name": "@bymax-one/nest-queue",
     "version": "0.1.0-alpha.0",
     "type": "module",
     "sideEffects": false,
     "files": ["dist", "LICENSE", "README.md", "CHANGELOG.md"],
     "exports": {
       ".":        { "types": "./dist/server/index.d.ts", "import": "./dist/server/index.mjs", "require": "./dist/server/index.cjs" },
       "./shared": { "types": "./dist/shared/index.d.ts", "import": "./dist/shared/index.mjs", "require": "./dist/shared/index.cjs" }
     },
     "scripts": {
       "build": "pnpm clean && tsup",
       "lint": "eslint src",
       "test": "jest",
       "test:cov": "jest --coverage",
       "test:e2e": "jest --config jest.e2e.config.ts",
       "test:cov:all": "jest --config jest.coverage.config.ts --coverage",
       "mutation": "stryker run",
       "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.server.json",
       "size": "node scripts/check-size.mjs",
       "clean": "rm -rf dist coverage"
     },
     "dependencies": {},
     "peerDependencies": {
       "@nestjs/common": "^11.0.0", "@nestjs/core": "^11.0.0",
       "bullmq": "^5.16.0", "ioredis": "^5.0.0",
       "reflect-metadata": "^0.2.0", "bullmq-otel": "^1.0.0"
     },
     "peerDependenciesMeta": { "bullmq-otel": { "optional": true } },
     "packageManager": "pnpm@11.0.0",
     "engines": { "node": ">=24.0.0" },
     "publishConfig": { "access": "public", "provenance": true, "registry": "https://registry.npmjs.org/" }
   }
   ```

2. `tsup.config.ts` — exactly TWO entries; externalize bullmq/ioredis/reflect-metadata/@nestjs:
   ```typescript
   import { defineConfig } from 'tsup'
   const common = {
     format: ['esm', 'cjs'] as const,
     dts: true,
     tsconfig: 'tsconfig.build.json',
     outDir: 'dist',
     outExtension: ({ format }: { format: string }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
     external: [/^@nestjs\//, 'reflect-metadata', 'bullmq', 'ioredis'],
     target: 'node24', splitting: false, treeshake: true, sourcemap: false,
   }
   export default defineConfig([
     { entry: { 'server/index': 'src/server/index.ts' }, ...common },
     { entry: { 'shared/index': 'src/shared/index.ts' }, ...common },
   ])
   ```

3. tsconfig variants — `tsconfig.json` (base; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: NodeNext`, `target: ES2023`, `experimentalDecorators` + `emitDecoratorMetadata` for NestJS), `tsconfig.build.json` (extends base, emit settings for tsup), `tsconfig.server.json` (typechecks only `src/server`), `tsconfig.e2e.json` (includes `test/e2e`), `tsconfig.jest.json` (CommonJS interop for ts-jest).

4. Jest variants — `jest.config.ts` (ts-jest, `maxWorkers: '50%'`), `jest.coverage.config.ts` (extends config, `coverageThreshold.global = { branches: 100, functions: 100, lines: 100, statements: 100 }`), `jest.e2e.config.ts` (`testMatch` under `test/e2e`), `jest.stryker.config.ts`. Plus `stryker.config.json` with `"thresholds": { "high": 99, "low": 95, "break": 95 }`, `testRunner: jest`, mutate `src/**/*.ts` excluding `*.spec.ts` and `index.ts`.

5. `eslint.config.mjs` (flat config v9, `typescript-eslint` strict + stylistic, no `eslint-disable` needed), `.prettierrc`, `.gitignore` (`node_modules`, `dist`, `coverage`, `.stryker-tmp`, `*.tsbuildinfo`), `.npmignore`, `commitlint.config.cjs` (`module.exports = { extends: ['@commitlint/config-conventional'] }`).

6. `scripts/check-size.mjs` — brotli-compress each built `.mjs` and fail if over budget:
   ```javascript
   const BUDGETS = { 'dist/server/index.mjs': 18_432, 'dist/shared/index.mjs': 2_500 } // bytes, brotli
   // read each file, brotliCompressSync, compare to budget, process.exit(1) on overflow
   ```

7. `src/server/index.ts` and `src/shared/index.ts` — placeholder real files: `export {}` with a one-line `// @fileoverview` header. They get real exports in later tasks.

Constraints:
- TS strict, no `any`. JSDoc/`@fileoverview` headers on files. English-only, timeless comments — no roadmap/phase references in any config.
- Do NOT create `.gitkeep` or empty-directory placeholders; the real `index.ts` files create `src/server` and `src/shared`. The `test/e2e/` dir is created on demand later.
- `"dependencies": {}` — bullmq and ioredis are PEER deps and `external` in tsup (never bundled). Do NOT copy nest-auth's tsup literally (it has 5 entries; this has 2).
- No `@ts-ignore`/`eslint-disable`. Follow `/bymax-workflow:standards`. Use the current BullMQ API only (relevant from later tasks).

Verification:
- `pnpm install` — expected: completes with no errors.
- `pnpm typecheck` — expected: no errors (placeholder entry points typecheck clean).
- `pnpm lint` — expected: no warnings on the empty folders.
- `pnpm build` — expected: produces `dist/server/index.{mjs,cjs,d.ts}` and `dist/shared/index.{mjs,cjs,d.ts}`.
- `ls -la dist/server/ dist/shared/` — expected: the six files above.
- `find src -name .gitkeep -o -name .keep` — expected: no output.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the 1.1 row in the Task index table.
4. Increment the phase progress counter to `1 / 8` in the header.
5. Update the Phase 1 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 1.1 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 1.2 — Shared types & constants (`src/shared/`)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: S
- **Depends on**: 1.1

#### Description

Define the dependency-free public type and constant surface for the `./shared` subpath: `JobStatus`, `QueueMetrics`, `JobSchedulerRepeatOptions`, and the constant objects `JOB_STATUS` and `QUEUE_ERROR_CODES` (plus the derived `QueueErrorCode` type). These are pure TypeScript with **zero** NestJS/BullMQ imports, consumable from any runtime (CI scripts, cross-tier validation).

#### Acceptance criteria

- [ ] All files created per the §2.2 tree (`types/job-status.types.ts`, `types/queue-metrics.types.ts`, `types/job-scheduler-options.types.ts`, `constants/job-status.ts`, `constants/error-codes.ts`, `index.ts`).
- [ ] `JobStatus` is the union `'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'`.
- [ ] `QueueMetrics` matches spec §5.8 / §9.2 (`queue`, `counts` keyed by the 6 statuses, `collectedAt` ISO string).
- [ ] `JobSchedulerRepeatOptions` is the discriminated union (cron `pattern` branch vs `every` ms branch — never both) per spec §8.2.
- [ ] `JOB_STATUS` and `QUEUE_ERROR_CODES` use `as const` (literal types preserved in `.d.ts`); `QUEUE_ERROR_CODES` has all 14 codes from spec §12.3; `QueueErrorCode` is derived from it.
- [ ] JSDoc present on every export; no logic, no runtime dependency.
- [ ] `pnpm build` produces `dist/shared/index.{mjs,cjs,d.ts}`; `pnpm size` shows `dist/shared/index.mjs` < 2.5 KiB brotli.

#### Files to create / modify

- `src/shared/types/job-status.types.ts`
- `src/shared/types/queue-metrics.types.ts`
- `src/shared/types/job-scheduler-options.types.ts`
- `src/shared/constants/job-status.ts`
- `src/shared/constants/error-codes.ts`
- `src/shared/index.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.2 of 8 (MIDDLE)

PRECONDITIONS
- Task 1.1 is done: the build chain exists; `pnpm typecheck`/`lint`/`build` pass on placeholder `index.ts` files.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 5.8 + § 9.2 (the `QueueMetrics` shape) and § 8.2 (the `JobSchedulerRepeatOptions` discriminated union).
- `docs/technical_specification.md` § 12.3 (the `QUEUE_ERROR_CODES` constant — all 14 codes).
- `docs/development_plan.md` § 2.2 "Shared types and constants" (the exact skeletons).

TASK
Author the dependency-free public type/constant surface for the `./shared` subpath. Pure TypeScript — zero NestJS/BullMQ imports, no logic.

DELIVERABLES

1. `src/shared/types/job-status.types.ts`:
   ```typescript
   /** Snapshot statuses BullMQ exposes via `Queue.getJobCounts()`. */
   export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'
   ```

2. `src/shared/types/queue-metrics.types.ts` — `QueueMetrics` with `queue: string`, `counts` keyed by the six statuses (numbers), `collectedAt: string` (ISO 8601 UTC). Import `JobStatus` as a `type`.

3. `src/shared/types/job-scheduler-options.types.ts` — the `JobSchedulerRepeatOptions` discriminated union: one branch with `pattern` (cron, `tz`/`limit`/`startDate`/`endDate`/`immediately`), one branch with `every` (ms interval, `limit`/`offset`/`startDate`/`endDate`). Document it as a thin projection of BullMQ's `RepeatOptions` minus the internal `key`. Either `pattern` OR `every`, never both.

4. `src/shared/constants/job-status.ts`:
   ```typescript
   export const JOB_STATUS = {
     WAITING: 'waiting', ACTIVE: 'active', COMPLETED: 'completed',
     FAILED: 'failed', DELAYED: 'delayed', PAUSED: 'paused',
   } as const
   ```

5. `src/shared/constants/error-codes.ts` — `QUEUE_ERROR_CODES` (all 14 codes from spec §12.3) `as const`, plus `export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES]`.

6. `src/shared/index.ts` — explicit named re-exports (no `export *`):
   ```typescript
   export type { JobStatus } from './types/job-status.types'
   export type { QueueMetrics } from './types/queue-metrics.types'
   export type { JobSchedulerRepeatOptions } from './types/job-scheduler-options.types'
   export { JOB_STATUS } from './constants/job-status'
   export { QUEUE_ERROR_CODES } from './constants/error-codes'
   export type { QueueErrorCode } from './constants/error-codes'
   ```

Constraints:
- TS strict, no `any`. `as const` is mandatory on the constants (preserves literal types in `.d.ts`).
- JSDoc on every export. English-only, timeless comments. No `@ts-ignore`/`eslint-disable`.
- No logic in `shared/` — pure types and constants only. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: clean.
- `pnpm build && pnpm size` — expected: `dist/shared/index.mjs` < 2.5 KiB brotli.
- `node -e "import('./dist/shared/index.mjs').then(m => console.log(Object.keys(m).sort()))"` — expected: `['JOB_STATUS','QUEUE_ERROR_CODES']` (types erase at runtime).

Completion Protocol:
1. Status ✅ (per-task block + index). 2. Tick AC. 3. Update the 1.2 index row. 4. Progress `2 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md` (status + Last updated). 6. Recompute the overall %.
7. Append: `- 1.2 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 1.3 — Public server interfaces & contracts

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.1

#### Description

Define every public server-side interface: `BymaxQueueModuleOptions` (including `isGlobal` and the optional `telemetry`), `BymaxQueueModuleAsyncOptions` + `BymaxQueueOptionsFactory`, the `QueueConnectionConfig` dual-mode union + `QueueConnectionMode`, `WorkerOptions` (**no `sandboxed` boolean**), `ProcessorMetadata`/`ProcessHandlerMetadata`/`QueueEventListenerMetadata`, and `BulkJob<TData>`. Types only — no logic.

#### Acceptance criteria

- [ ] All interface files created per the §2.3 tree, plus a `interfaces/index.ts` barrel with explicit named re-exports.
- [ ] `QueueConnectionConfig` is the 3-arm union: `{ client: Redis; ownsConnection?: false }` (Mode A) | `{ url: string; options?: Partial<RedisOptions> }` (Mode B url) | `{ options: RedisOptions }` (Mode B options); `QueueConnectionMode = 'mode-a-byo' | 'mode-b-owned'`.
- [ ] `BymaxQueueModuleOptions` carries `connection` (required), `defaultJobOptions?`, `prefix?`, `queueOptions?`, `flows?`, `metrics?`, `telemetry?: Telemetry` (BullMQ, opt-in OTel), `shutdown?`, `isGlobal?` (mapped to `DynamicModule.global` via `setExtras`), `connectionReadyTimeoutMs?`.
- [ ] `WorkerOptions` has `concurrency?`, `limiter?`, `autorun?`, `lockDuration?`, `stalledInterval?` and a comment documenting **why there is intentionally no `sandboxed` boolean** (sandboxed = file path, out-of-process, no DI).
- [ ] `BymaxQueueModuleAsyncOptions` extends `Pick<ModuleMetadata,'imports'>` with `useFactory`/`useClass`/`useExisting`/`inject` (factory typed `(...args: unknown[]) => ...`, never `any`).
- [ ] `BulkJob<TData = unknown>` = `{ name: string; data: TData; options?: JobsOptions }`.
- [ ] `readonly` on array members where applicable; `pnpm typecheck` passes; `grep -nE ': any\b|any\[\]' src/server/interfaces/` returns nothing.

#### Files to create / modify

- `src/server/interfaces/queue-connection.interface.ts`
- `src/server/interfaces/worker-options.interface.ts`
- `src/server/interfaces/processor-metadata.interface.ts`
- `src/server/interfaces/queue-job-data.interface.ts`
- `src/server/interfaces/queue-module-options.interface.ts`
- `src/server/interfaces/index.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.3 of 8 (MIDDLE)

PRECONDITIONS
- Task 1.1 is done: the build chain + tsconfig variants exist and typecheck clean.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 4.1 "BymaxQueueModuleOptions interface" (the full options shape incl. `isGlobal`, `connection`, `telemetry`, `shutdown`) and § 4.2 "BymaxQueueModuleAsyncOptions interface".
- `docs/technical_specification.md` § 2.2/§2.3 (the dual-mode connection and the per-role retry policy that `QueueConnectionConfig` encodes) and § 6.3 (the `WorkerOptions` shape and the no-`sandboxed`-boolean rationale).
- `docs/development_plan.md` § 2.3 "Interfaces and contracts" (the exact skeletons).

TASK
Author every public server-side interface. Types only — no logic, no runtime imports beyond `import type`.

DELIVERABLES

1. `src/server/interfaces/queue-connection.interface.ts`:
   ```typescript
   import type { Redis, RedisOptions } from 'ioredis'
   /** Connection config — Mode A (BYO client) or Mode B (lib-owned), mutually exclusive. */
   export type QueueConnectionConfig =
     | { client: Redis; ownsConnection?: false }      // Mode A
     | { url: string; options?: Partial<RedisOptions> } // Mode B (url)
     | { options: RedisOptions }                        // Mode B (options)
   /** Internal discriminator used by ConnectionResolver. */
   export type QueueConnectionMode = 'mode-a-byo' | 'mode-b-owned'
   ```
   Document Mode A (used AS-IS for Queue/FlowProducer; lib never closes it) vs Mode B (lib opens + closes its own ioredis; worker/QueueEvents connections duplicated with `maxRetriesPerRequest: null`).

2. `src/server/interfaces/worker-options.interface.ts` — `WorkerOptions` with `concurrency?`, `limiter?: { max: number; duration: number }`, `autorun?`, `lockDuration?`, `stalledInterval?`. Include the comment block explaining there is intentionally NO `sandboxed` boolean: BullMQ sandboxed processors take a FILE PATH (not a class), run out-of-process, and cannot use NestJS DI — so a toggle on a DI-managed @Processor is impossible; sandboxed work uses a separate registration path.

3. `src/server/interfaces/processor-metadata.interface.ts` — `ProcessorMetadata { queueName: string; workerOptions: WorkerOptions }`, `ProcessHandlerMetadata { jobName?: string; methodKey: string | symbol }`, `QueueEventListenerMetadata { eventName: string; methodKey: string | symbol }`.

4. `src/server/interfaces/queue-job-data.interface.ts` — `BulkJob<TData = unknown> { name: string; data: TData; options?: JobsOptions }` (`import type { JobsOptions } from 'bullmq'`).

5. `src/server/interfaces/queue-module-options.interface.ts`:
   ```typescript
   import type { ModuleMetadata, Type } from '@nestjs/common'
   import type { JobsOptions, QueueOptions, Telemetry } from 'bullmq'
   import type { QueueConnectionConfig } from './queue-connection.interface'

   export interface BymaxQueueModuleOptions {
     connection: QueueConnectionConfig
     defaultJobOptions?: JobsOptions
     prefix?: string
     queueOptions?: Partial<Omit<QueueOptions, 'connection' | 'defaultJobOptions' | 'prefix'>>
     flows?: { enabled?: boolean }
     metrics?: { enabled?: boolean; cacheTtlMs?: number }
     /** Opt-in OpenTelemetry — a BullMQ `Telemetry` (typically `new BullMQOtel(...)` from the OPTIONAL peer `bullmq-otel`); attached to every Queue/Worker. */
     telemetry?: Telemetry
     shutdown?: { drainTimeoutMs?: number; drainOnShutdown?: boolean }
     /** Global registration — mapped to DynamicModule.global by ConfigurableModuleBuilder.setExtras (no @Global). Default: true. */
     isGlobal?: boolean
     /** Mode B only: ms to wait for Redis `ready` before throwing. Default: 10_000. */
     connectionReadyTimeoutMs?: number
   }
   export interface BymaxQueueModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
     useFactory?: (...args: unknown[]) => Promise<BymaxQueueModuleOptions> | BymaxQueueModuleOptions
     useClass?: Type<BymaxQueueOptionsFactory>
     useExisting?: Type<BymaxQueueOptionsFactory>
     inject?: ReadonlyArray<Type<unknown> | string | symbol>
   }
   export interface BymaxQueueOptionsFactory {
     createQueueOptions(): Promise<BymaxQueueModuleOptions> | BymaxQueueModuleOptions
   }
   ```

6. `src/server/interfaces/index.ts` — explicit `export type { ... }` re-exports of all of the above.

Constraints:
- TS strict, NO `any` anywhere (factory args are `unknown[]`). Use `import type` for all imports.
- JSDoc on every export. `readonly` on array members where applicable.
- English-only, timeless comments. No `@ts-ignore`/`eslint-disable`. Follow `/bymax-workflow:standards`. Current BullMQ API only.

Verification:
- `pnpm typecheck` — expected: clean.
- `grep -nE ': any\b|any\[\]' src/server/interfaces/` — expected: no match.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update the 1.3 index row. 4. Progress `3 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md`. 6. Recompute the overall %.
7. Append: `- 1.3 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 1.4 — DI tokens, default options & error messages

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: S
- **Depends on**: 1.1, 1.2

#### Description

Define the `Symbol` injection tokens, the default constants (`DEFAULT_JOB_OPTIONS`, `DEFAULT_WORKER_CONCURRENCY`, and the timeout/TTL/drain defaults), and the server-side re-export of `QUEUE_ERROR_CODES` plus the human-readable `QUEUE_ERROR_MESSAGES` map (keyed by code, mirroring spec §12.2). No logic beyond constant declarations.

#### Acceptance criteria

- [ ] `src/server/bymax-queue.constants.ts` exports the `Symbol` tokens `BYMAX_QUEUE_OPTIONS`, `BYMAX_QUEUE_REDIS_CLIENT`, `BYMAX_QUEUE_CONNECTION_MODE`, `BYMAX_QUEUE_RESOLVED_OPTIONS` (each distinct; `===` reflexive, `!==` cross-token).
- [ ] `src/server/constants/default-options.ts` exports `DEFAULT_WORKER_CONCURRENCY = 2`, `DEFAULT_JOB_OPTIONS` (`attempts: 3`, exponential backoff `delay: 2000`, `removeOnComplete { age: 24h, count: 1000 }`, `removeOnFail { age: 7d, count: 5000 }`) `as const satisfies JobsOptions`, plus `DEFAULT_CONNECTION_READY_TIMEOUT_MS = 10_000`, `DEFAULT_METRICS_CACHE_TTL_MS = 5_000`, `DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000`.
- [ ] `src/server/constants/error-codes.ts` re-exports `QUEUE_ERROR_CODES`/`QueueErrorCode` from `../../shared/constants/error-codes` and adds `QUEUE_ERROR_MESSAGES: Record<string, string>` covering every code from spec §12.2.
- [ ] `src/server/constants/index.ts` re-exports the two files above.
- [ ] `DEFAULT_JOB_OPTIONS satisfies JobsOptions` compiles; `pnpm typecheck` passes.

#### Files to create / modify

- `src/server/bymax-queue.constants.ts`
- `src/server/constants/default-options.ts`
- `src/server/constants/error-codes.ts`
- `src/server/constants/index.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.4 of 8 (MIDDLE)

PRECONDITIONS
- Task 1.1 (build chain) and Task 1.2 (shared `QUEUE_ERROR_CODES`) are done.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 4.4 "Consolidated defaults" (`DEFAULT_WORKER_CONCURRENCY`, `DEFAULT_JOB_OPTIONS` incl. the `removeOnFail.count` cap rationale).
- `docs/technical_specification.md` § 12.2 (the message column for every error code).
- `docs/development_plan.md` § 2.4 "Constants and DI tokens" (the exact skeletons).

TASK
Author the Symbol injection tokens, the default-options constants, and the server-side error-code/message re-exports. Constant declarations only — no logic.

DELIVERABLES

1. `src/server/bymax-queue.constants.ts`:
   ```typescript
   /** Injection tokens — Symbols avoid collision with consumer tokens of the same string. */
   export const BYMAX_QUEUE_OPTIONS = Symbol('BYMAX_QUEUE_OPTIONS')
   export const BYMAX_QUEUE_REDIS_CLIENT = Symbol('BYMAX_QUEUE_REDIS_CLIENT')
   export const BYMAX_QUEUE_CONNECTION_MODE = Symbol('BYMAX_QUEUE_CONNECTION_MODE')
   export const BYMAX_QUEUE_RESOLVED_OPTIONS = Symbol('BYMAX_QUEUE_RESOLVED_OPTIONS')
   ```

2. `src/server/constants/default-options.ts`:
   ```typescript
   import type { JobsOptions } from 'bullmq'
   export const DEFAULT_WORKER_CONCURRENCY = 2 as const
   export const DEFAULT_JOB_OPTIONS = {
     attempts: 3,
     backoff: { type: 'exponential', delay: 2000 },
     removeOnComplete: { age: 24 * 3600, count: 1000 }, // 24h, 1000 entries
     removeOnFail: { age: 7 * 24 * 3600, count: 5000 },  // 7d; count caps Redis memory under failure storms
   } as const satisfies JobsOptions
   export const DEFAULT_CONNECTION_READY_TIMEOUT_MS = 10_000 as const
   export const DEFAULT_METRICS_CACHE_TTL_MS = 5_000 as const
   export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000 as const
   ```

3. `src/server/constants/error-codes.ts`:
   ```typescript
   export { QUEUE_ERROR_CODES } from '../../shared/constants/error-codes'
   export type { QueueErrorCode } from '../../shared/constants/error-codes'
   /** Human-readable messages keyed by error code — mirrors the spec catalog. */
   export const QUEUE_ERROR_MESSAGES: Record<string, string> = {
     'queue.connection_invalid': 'Invalid Redis connection configuration',
     'queue.connection_requires_null_retries': 'Worker connection must have maxRetriesPerRequest=null',
     'queue.connection_timeout': 'Redis connection timeout',
     // ... fill ALL 14 codes from spec §12.2
   }
   ```

4. `src/server/constants/index.ts`:
   ```typescript
   export * from './default-options'
   export * from './error-codes'
   ```

Constraints:
- TS strict, no `any`. JSDoc on every export. `as const` / `satisfies JobsOptions` mandatory on the defaults.
- `QUEUE_ERROR_MESSAGES` must cover every code present in `QUEUE_ERROR_CODES` (all 14).
- English-only, timeless comments. No `@ts-ignore`/`eslint-disable`. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: clean (`DEFAULT_JOB_OPTIONS satisfies JobsOptions` compiles).
- `node -e "import('./src/server/bymax-queue.constants.ts')"` is not required; rely on typecheck. Optionally add a quick `node --test` later — coverage is exercised in Task 1.8.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update the 1.4 index row. 4. Progress `4 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md`. 6. Recompute the overall %.
7. Append: `- 1.4 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 1.5 — `ConnectionResolver`, `QueueException` & connection utils

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.3, 1.4

#### Description

Implement the dual-mode `ConnectionResolver` (Mode A: BYO client used as-is for the Queue role; Mode B: lib opens its own `ioredis` with a ready timeout), the `QueueException` HTTP-shaped error, and the connection utilities (`duplicateConnection`, `assertBlockingConnection`, `isClientUsable`). The per-role `maxRetriesPerRequest` policy is enforced here: the Queue/FlowProducer connection keeps ioredis' default retries (enqueue fails fast on a Redis outage), and only **duplicated** Worker/QueueEvents connections are forced to `null`. In Mode A, fail fast with `queue.connection_requires_null_retries` when the duplicated probe cannot be coerced to `null`.

#### Acceptance criteria

- [ ] `QueueException extends HttpException` with response shape `{ error: { code, message, details } }`, message resolved from `QUEUE_ERROR_MESSAGES`, default status `500`.
- [ ] `duplicateConnection(client)` returns `client.duplicate({ maxRetriesPerRequest: null })`.
- [ ] `assertBlockingConnection(client)` throws `CONNECTION_REQUIRES_NULL_RETRIES` (with `{ actualValue, expectedValue: null }`) when `client.options.maxRetriesPerRequest !== null`.
- [ ] `isClientUsable(client)` returns true when `status` is `'ready'` or `'connecting'`.
- [ ] Mode A: a usable client is accepted and used as-is for the Queue role; the lib does **not** require `maxRetriesPerRequest === null` on the received client; it duplicates a probe, asserts the duplicate is `null`, and `disconnect()`s the probe in a `finally`; an `end` client is rejected with `CONNECTION_INVALID`.
- [ ] Mode B (url) and Mode B (options-only): the lib opens its own `ioredis`, the Queue connection keeps ioredis default retries, and `waitReady` resolves on `ready` or rejects with `CONNECTION_TIMEOUT` after `connectionReadyTimeoutMs` (default 10s); event listeners are cleaned up on resolve/reject/timeout (no leaked handles).
- [ ] `getClient()`, `getMode()`, `isOwned()` expose state; `onModuleDestroy` calls `quit()` (fallback `disconnect()`) **only** in Mode B and never touches a Mode A client.
- [ ] 100% line/branch coverage on the resolver and both utils (tests authored in Task 1.8 may live alongside, but coverage must be reachable).

#### Files to create / modify

- `src/server/errors/queue-exception.ts`
- `src/server/utils/duplicate-connection.ts`
- `src/server/utils/validate-connection.ts`
- `src/server/services/connection-resolver.service.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.5 of 8 (MIDDLE)

PRECONDITIONS
- Tasks 1.3 (interfaces) and 1.4 (tokens, defaults, error codes/messages) are done.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 2.2 "Connection modes", § 2.3 "Connection sharing strategy" (the per-role `maxRetriesPerRequest` table), § 2.4 "Initialization flow".
- `docs/technical_specification.md` § 12.1 "QueueException class", § 12.4 "Error response format", § 12.5 "Security in errors" (no secrets in `details`).
- `docs/development_plan.md` § 2.5 "ConnectionResolver — dual-mode" (the exact skeletons, the nest-cache `BYMAX_CACHE_QUEUE_REDIS` Mode A pattern, the listener-cleanup note).

TASK
Implement `QueueException`, the connection utilities, and the dual-mode `ConnectionResolver`. Enforce the per-role retry policy: Queue/FlowProducer keep ioredis default retries; only duplicated Worker/QueueEvents connections are forced to `maxRetriesPerRequest: null`.

DELIVERABLES

1. `src/server/errors/queue-exception.ts`:
   ```typescript
   import { HttpException, HttpStatus } from '@nestjs/common'
   import { QUEUE_ERROR_MESSAGES } from '../constants/error-codes'
   export class QueueException extends HttpException {
     constructor(code: string, statusCode: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR, details?: Record<string, unknown>) {
       super({ error: { code, message: QUEUE_ERROR_MESSAGES[code] ?? 'Queue error', details: details ?? null } }, statusCode)
     }
   }
   ```
   `details` must never carry secrets (connection string, password, job.data) — only scalar config values.

2. `src/server/utils/duplicate-connection.ts` — `duplicateConnection(client: Redis): Redis` returns `client.duplicate({ maxRetriesPerRequest: null })`.

3. `src/server/utils/validate-connection.ts`:
   - `assertBlockingConnection(client: Redis): void` — reads `(client.options ?? {}).maxRetriesPerRequest`; throws `QueueException(CONNECTION_REQUIRES_NULL_RETRIES, 500, { actualValue, expectedValue: null })` when it is not `null`. JSDoc: this validates the DUPLICATED worker/QueueEvents probe, not the Queue connection.
   - `isClientUsable(client: Redis): boolean` — `status === 'ready' || status === 'connecting'`.

4. `src/server/services/connection-resolver.service.ts` — `@Injectable()`, `implements OnModuleDestroy`:
   - Constructor injects `@Inject(BYMAX_QUEUE_OPTIONS) options: BymaxQueueModuleOptions`.
   - `async init()`: if `'client' in connection` → Mode A: set `mode='mode-a-byo'`, store the client, throw `CONNECTION_INVALID` if not `isClientUsable`, then `const probe = duplicateConnection(client); try { assertBlockingConnection(probe) } finally { probe.disconnect() }`. Else → Mode B: set `mode='mode-b-owned'`, open `new Redis(url, {...options, lazyConnect:false})` or `new Redis({...options, lazyConnect:false})`, then `await waitReady(timeoutMs)`.
   - `getClient()`, `getMode()`, `isOwned()` (`=== 'mode-b-owned'`).
   - `onModuleDestroy()`: if `isOwned()` and client present, `await client.quit().catch(() => client.disconnect())`.
   - private `waitReady(timeoutMs)`: resolve immediately if `status==='ready'`; else race a `setTimeout` (reject `CONNECTION_TIMEOUT`) against `once('ready')`/`once('error')`, with a `cleanup()` that `clearTimeout` + `off('ready')` + `off('error')` on every exit path.

Constraints:
- TS strict, no `any`. JSDoc on every export. Functions ≤ 50 lines (split `waitReady` helpers if needed).
- English-only, timeless comments. No `@ts-ignore`/`eslint-disable`. Follow `/bymax-workflow:standards`.
- Current BullMQ/ioredis API only. Never force `maxRetriesPerRequest: null` on the Queue connection; only on duplicates. No env-var reads.

Verification:
- `pnpm typecheck` — expected: clean.
- `pnpm test src/server/services/connection-resolver.service.spec.ts src/server/utils/` — expected: green once specs exist (authored here or in Task 1.8); use `ioredis-mock` for Mode B.
- `pnpm lint` — expected: no warnings.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update the 1.5 index row. 4. Progress `5 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md`. 6. Recompute the overall %.
7. Append: `- 1.5 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 1.6 — Resolved options + bootstrap validation

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.3, 1.4

#### Description

Implement `validateOptions` (fail-fast precondition checks in `forRoot()`) and `applyDefaults` (merge consumer options with defaults into a frozen `ResolvedQueueOptions`). Validation never silently corrects — it throws `QueueException(INVALID_OPTIONS)` with an actionable `reason`.

#### Acceptance criteria

- [ ] `src/server/config/resolved-options.ts` exports the `ResolvedQueueOptions` interface (every optional field of `BymaxQueueModuleOptions` filled) and `applyDefaults(opts): Readonly<ResolvedQueueOptions>` returning an `Object.freeze`d object.
- [ ] `applyDefaults` merges `defaultJobOptions` over `DEFAULT_JOB_OPTIONS` (merge, not replace), sets `prefix ?? 'bull'`, `flows.enabled ?? false`, `metrics.enabled ?? false` + `cacheTtlMs ?? DEFAULT_METRICS_CACHE_TTL_MS`, `shutdown.drainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS` + `drainOnShutdown ?? false`, passes through `telemetry`, and `connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS`.
- [ ] `src/server/config/validate-options.ts` exports `validateOptions(opts): void` throwing `INVALID_OPTIONS` on: missing `connection`; a `connection` that specifies none of `client`/`url`/`options`; `client` together with `url`/`options` (mutually exclusive); `shutdown.drainTimeoutMs <= 0`; `metrics.cacheTtlMs < 0`.
- [ ] `src/server/config/default-options.ts` re-exports the constants from `../constants/default-options` (the `config/` alias referenced by the spec tree).
- [ ] Mutating the frozen result throws in strict mode; 100% line/branch coverage on both files.

#### Files to create / modify

- `src/server/config/default-options.ts`
- `src/server/config/resolved-options.ts`
- `src/server/config/validate-options.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.6 of 8 (MIDDLE)

PRECONDITIONS
- Tasks 1.3 (interfaces) and 1.4 (defaults, error codes) are done.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 4.4 "Consolidated defaults" and § 12.2 (the `queue.invalid_options` row).
- `docs/development_plan.md` § 2.6 "Resolved options + validation" (the exact `validate-options.ts` and `resolved-options.ts` skeletons).

TASK
Implement bootstrap option validation and default-merging. Validation is fail-fast with actionable messages — never silently correct.

DELIVERABLES

1. `src/server/config/default-options.ts`:
   ```typescript
   export {
     DEFAULT_JOB_OPTIONS, DEFAULT_WORKER_CONCURRENCY,
     DEFAULT_METRICS_CACHE_TTL_MS, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
     DEFAULT_CONNECTION_READY_TIMEOUT_MS,
   } from '../constants/default-options'
   ```

2. `src/server/config/validate-options.ts`:
   ```typescript
   import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
   import { QueueException } from '../errors/queue-exception'
   import { QUEUE_ERROR_CODES } from '../constants/error-codes'
   export function validateOptions(opts: BymaxQueueModuleOptions): void {
     if (!opts.connection) throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'connection is required' })
     const cfg = opts.connection as Record<string, unknown>
     const hasClient = 'client' in cfg, hasUrl = 'url' in cfg, hasOptions = 'options' in cfg
     if (!hasClient && !hasUrl && !hasOptions) throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'connection must specify client | url | options' })
     if (hasClient && (hasUrl || (hasOptions && !hasUrl && false))) { /* refine: client is mutually exclusive with url/options */ }
     // throw INVALID_OPTIONS when client coexists with url/options
     // throw INVALID_OPTIONS when shutdown.drainTimeoutMs <= 0
     // throw INVALID_OPTIONS when metrics.cacheTtlMs < 0
   }
   ```
   (Implement the mutual-exclusion and numeric checks fully and clearly; each `throw` carries a distinct `reason`.)

3. `src/server/config/resolved-options.ts` — the `ResolvedQueueOptions` interface and `applyDefaults(opts): Readonly<ResolvedQueueOptions>`:
   ```typescript
   export function applyDefaults(opts: BymaxQueueModuleOptions): Readonly<ResolvedQueueOptions> {
     return Object.freeze({
       connection: opts.connection,
       defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...(opts.defaultJobOptions ?? {}) },
       prefix: opts.prefix ?? 'bull',
       queueOptions: opts.queueOptions ?? {},
       flows: { enabled: opts.flows?.enabled ?? false },
       metrics: { enabled: opts.metrics?.enabled ?? false, cacheTtlMs: opts.metrics?.cacheTtlMs ?? DEFAULT_METRICS_CACHE_TTL_MS },
       shutdown: { drainTimeoutMs: opts.shutdown?.drainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS, drainOnShutdown: opts.shutdown?.drainOnShutdown ?? false },
       telemetry: opts.telemetry,
       connectionReadyTimeoutMs: opts.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
     })
   }
   ```

Constraints:
- TS strict, no `any`. JSDoc on every export. Functions ≤ 50 lines.
- `applyDefaults` MUST return a frozen object; `defaultJobOptions` is MERGED, not replaced.
- English-only, timeless comments. No `@ts-ignore`/`eslint-disable`. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: clean.
- `pnpm test src/server/config/` — expected: green once specs exist (here or Task 1.8); cover every throw branch + the freeze.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update the 1.6 index row. 4. Progress `6 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md`. 6. Recompute the overall %.
7. Append: `- 1.6 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 1.7 — Base `QueueService` (cache, enqueue, metrics, control)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.3, 1.5, 1.6

#### Description

Implement the base `QueueService`: a per-name `Queue` cache (`getOrCreateQueue`), typed `enqueue`/`enqueueBulk`, `getJob`/`getJobs`, uncached `getMetrics`, and the control helpers `pauseQueue`/`resumeQueue`/`cleanQueue`. Decorators, workers, schedulers, flows, and metrics caching are **out of scope** — this is the standalone enqueue + inspect surface.

#### Acceptance criteria

- [ ] `getOrCreateQueue<TData,TResult>(name, overrides?)` returns a cached `Queue` (second call with the same name returns the same instance), built with `connection: connectionResolver.getClient()`, `prefix`, `defaultJobOptions`, merged `queueOptions` and `overrides`.
- [ ] `enqueue<TData,TResult>(queue, jobName, data, options?)` delegates to `queue.add(jobName, data, options)` and propagates `TData`/`TResult` typing; native `options.jobId` and `options.deduplication` pass straight through (no custom deduplication code).
- [ ] `enqueueBulk` delegates to `queue.addBulk`, wrapping any failure in `QueueException(BULK_ENQUEUE_FAILED, 500, { cause })`.
- [ ] `getJob` returns `null` (not throw) when absent; `getJobs(queue, status, start=0, end=50)` passes `[status]` (array) to `queue.getJobs`.
- [ ] `getMetrics` returns `{ queue, counts, collectedAt }` via `queue.getJobCounts('waiting','active','completed','failed','delayed','paused')` with an ISO `collectedAt`.
- [ ] `cleanQueue(queue, gracePeriodMs, limit, status?)` mirrors BullMQ `Queue.clean(grace, limit, type?)` argument order exactly (`limit` required, `0` = no limit) and returns the removed ids.
- [ ] `getCachedQueues()` returns a `ReadonlyMap`; `onModuleDestroy` closes every cached queue (swallowing per-queue errors) and clears the map.
- [ ] 100% line/branch coverage (BullMQ `Queue` mocked).

#### Files to create / modify

- `src/server/services/queue.service.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.7 of 8 (MIDDLE)

PRECONDITIONS
- Tasks 1.3 (interfaces), 1.5 (ConnectionResolver, QueueException), and 1.6 (ResolvedQueueOptions) are done.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 5 "Main Service" — §5.1 overview, §5.3 `getOrCreateQueue`, §5.4 `enqueue` (+§5.4.1 jobId/deduplication passthrough), §5.5 `enqueueBulk`, §5.7 `getJob`/`getJobs`, §5.8 `getMetrics`, §5.9 `pauseQueue`/`resumeQueue`/`cleanQueue`.
- `docs/development_plan.md` § 2.7 "Base QueueService" (the exact skeleton, incl. the `getJobs([status])` and `clean(grace, limit, status)` notes).

TASK
Implement the base `QueueService` — queue caching, typed enqueue/inspect, uncached metrics, and control helpers. No decorators/workers/schedulers/flows/metrics-cache here.

DELIVERABLES

`src/server/services/queue.service.ts` — `@Injectable()`, `implements OnModuleDestroy`:
```typescript
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>()
  constructor(
    private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly options: ResolvedQueueOptions,
  ) {}

  getOrCreateQueue<TData = unknown, TResult = unknown>(queueName: string, overrides?: Partial<Omit<QueueOptions, 'connection' | 'prefix'>>): Queue<TData, TResult> {
    const existing = this.queues.get(queueName)
    if (existing) return existing as Queue<TData, TResult>
    const queue = new Queue<TData, TResult>(queueName, {
      connection: this.connection.getClient(), prefix: this.options.prefix,
      defaultJobOptions: this.options.defaultJobOptions, ...this.options.queueOptions, ...overrides,
    })
    this.queues.set(queueName, queue as Queue)
    return queue
  }

  async enqueue<TData = unknown, TResult = unknown>(queueName: string, jobName: string, data: TData, options?: JobsOptions): Promise<Job<TData, TResult, string>> {
    return this.getOrCreateQueue<TData, TResult>(queueName).add(jobName, data, options)
  }

  async enqueueBulk<TData = unknown, TResult = unknown>(queueName: string, jobs: ReadonlyArray<BulkJob<TData>>): Promise<Array<Job<TData, TResult, string>>> {
    try { return await this.getOrCreateQueue<TData, TResult>(queueName).addBulk(jobs as Array<BulkJob<TData>>) }
    catch (err) { throw new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, 500, { cause: (err as Error).message }) }
  }

  async getJob<TData = unknown, TResult = unknown>(queueName: string, jobId: string): Promise<Job<TData, TResult, string> | null> {
    return (await this.getOrCreateQueue<TData, TResult>(queueName).getJob(jobId)) ?? null
  }
  async getJobs<TData = unknown, TResult = unknown>(queueName: string, status: JobStatus, start = 0, end = 50): Promise<Array<Job<TData, TResult, string>>> {
    return this.getOrCreateQueue<TData, TResult>(queueName).getJobs([status], start, end) as Promise<Array<Job<TData, TResult, string>>>
  }
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    const counts = await this.getOrCreateQueue(queueName).getJobCounts('waiting','active','completed','failed','delayed','paused')
    return { queue: queueName, counts: counts as QueueMetrics['counts'], collectedAt: new Date().toISOString() }
  }
  async pauseQueue(queueName: string): Promise<void> { await this.getOrCreateQueue(queueName).pause() }
  async resumeQueue(queueName: string): Promise<void> { await this.getOrCreateQueue(queueName).resume() }
  async cleanQueue(queueName: string, gracePeriodMs: number, limit: number, status?: 'completed' | 'failed' | 'delayed' | 'wait' | 'active' | 'paused'): Promise<string[]> {
    return this.getOrCreateQueue(queueName).clean(gracePeriodMs, limit, status)
  }
  getCachedQueues(): ReadonlyMap<string, Queue> { return this.queues }
  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined)
    this.queues.clear()
  }
}
```

Constraints:
- TS strict, no `any` (BullMQ `getJobCounts` returns a record — cast to `QueueMetrics['counts']`, never to `any`). JSDoc on every public method, with `@example` on `enqueue`.
- `getJobs` MUST pass `[status]` (array). `cleanQueue` MUST keep BullMQ's `(grace, limit, status?)` order.
- Functions ≤ 50 lines. English-only, timeless comments. No `@ts-ignore`/`eslint-disable`. Follow `/bymax-workflow:standards`. Current BullMQ API only.

Verification:
- `pnpm typecheck` — expected: clean.
- `pnpm test src/server/services/queue.service.spec.ts` — expected: green once the spec exists (here or Task 1.8); mock the `bullmq.Queue` factory and assert cache hit/miss, `add` delegation, bulk-failure wrapping, `null` on missing job, metrics shape, and `onModuleDestroy` closing every queue.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update the 1.7 index row. 4. Progress `7 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md`. 6. Recompute the overall %.
7. Append: `- 1.7 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 1.8 — `BymaxQueueModule.forRoot()`, barrel & unit tests

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7

#### Description

Wire the synchronous `BymaxQueueModule.forRoot()` on `ConfigurableModuleBuilder` (`isGlobal` mapped to `DynamicModule.global` via `setExtras`; **no `@Global`, no `forFeature`**), register the providers (`ConnectionResolver` as an async factory that `await`s `init()`, `QueueService`, the options/resolved tokens), author the public `src/server/index.ts` barrel, and write the full unit-test suite that lifts the whole phase to 100/100/100/100 coverage. `forRootAsync` is **out of scope** (Phase 4).

#### Acceptance criteria

- [ ] `src/server/bymax-queue.module.ts` builds the `ConfigurableModuleClass` via `new ConfigurableModuleBuilder<BymaxQueueModuleOptions>({ moduleName: 'BymaxQueue' }).setClassMethodName('forRoot').setExtras({ isGlobal: true }, (def, extras) => ({ ...def, global: extras.isGlobal })).build()`.
- [ ] `forRoot(options)` calls `validateOptions`, computes `applyDefaults`, extends `super.forRoot(options)` with providers: `{ provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN }`, `{ provide: BYMAX_QUEUE_RESOLVED_OPTIONS, useValue: resolved }`, an async-factory `ConnectionResolver` (`useFactory: async (opts) => { const r = new ConnectionResolver(opts); await r.init(); return r }`, `inject: [BYMAX_QUEUE_OPTIONS]`), and `QueueService`; exports `QueueService`, `ConnectionResolver`, and the two tokens.
- [ ] There is **no** `@Global()` decorator and **no** `forFeature` method anywhere.
- [ ] `src/server/index.ts` re-exports (explicit, no `export *`): `BymaxQueueModule`; the four `BYMAX_QUEUE_*` tokens; `QueueService`, `ConnectionResolver`; the public interface types; `QueueException`; `DEFAULT_WORKER_CONCURRENCY`/`DEFAULT_JOB_OPTIONS`/`DEFAULT_METRICS_CACHE_TTL_MS`/`DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`/`QUEUE_ERROR_CODES`; BullMQ convenience type re-exports (`Job`, `JobsOptions`, `Queue`, `Worker`, `QueueEvents`); and the shared re-exports (`JobStatus`, `QueueMetrics`, `JobSchedulerRepeatOptions`, `QueueErrorCode`, `JOB_STATUS`).
- [ ] Unit specs exist for resolver, queue service, validate-options, resolved-options, validate-connection, and the module; `bymax-queue.module.spec.ts` asserts the returned `DynamicModule.global === true` by default and `false` when `isGlobal: false`, that providers/exports are registered, and that `forRoot({ connection: {} as never })` throws via `validateOptions`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size` all pass; coverage is `100/100/100/100` on every implemented file; both bundles are within budget (server ≤ 18 KiB brotli).

#### Files to create / modify

- `src/server/bymax-queue.module.ts`
- `src/server/index.ts`
- `src/server/bymax-queue.module.spec.ts`
- `src/server/services/queue.service.spec.ts`
- `src/server/services/connection-resolver.service.spec.ts`
- `src/server/config/validate-options.spec.ts`
- `src/server/config/resolved-options.spec.ts`
- `src/server/utils/validate-connection.spec.ts`

#### Agent prompt

````
You are a senior TypeScript/NestJS library engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module over BullMQ (NestJS 11, bullmq ^5.16, ioredis 5, Node 24, pnpm 11).

CURRENT PHASE: 1 (Foundation) — Task 1.8 of 8 (LAST)

PRECONDITIONS
- Tasks 1.1–1.7 are done: scaffold, shared surface, interfaces, tokens/defaults, ConnectionResolver + QueueException + utils, resolved-options + validation, and the base QueueService all exist and typecheck.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 4.3 "Registration methods" (the `ConfigurableModuleBuilder` block; `forRoot` via `setClassMethodName`; `isGlobal` via `setExtras`; the "No `forFeature` stub" note in §4.3).
- `docs/technical_specification.md` § 3.3 "Exports per subpath" (the exact server-barrel export list).
- `docs/development_plan.md` § 2.8 "Synchronous BymaxQueueModule.forRoot() + barrel export + tests" (the exact module + index skeletons, the test highlights, and the smoke test).

TASK
Wire the synchronous module, author the public barrel, and write the full unit-test suite that brings the whole phase to 100/100/100/100 coverage. Do NOT implement `forRootAsync` (Phase 4) and do NOT add `@Global` or `forFeature`.

DELIVERABLES

1. `src/server/bymax-queue.module.ts`:
   ```typescript
   import { ConfigurableModuleBuilder, DynamicModule, Module, Provider } from '@nestjs/common'
   import type { BymaxQueueModuleOptions } from './interfaces/queue-module-options.interface'
   import { validateOptions } from './config/validate-options'
   import { applyDefaults } from './config/resolved-options'
   import { BYMAX_QUEUE_OPTIONS, BYMAX_QUEUE_RESOLVED_OPTIONS } from './bymax-queue.constants'
   import { ConnectionResolver } from './services/connection-resolver.service'
   import { QueueService } from './services/queue.service'

   export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
     new ConfigurableModuleBuilder<BymaxQueueModuleOptions>({ moduleName: 'BymaxQueue' })
       .setClassMethodName('forRoot')
       .setExtras({ isGlobal: true }, (definition, extras) => ({ ...definition, global: extras.isGlobal }))
       .build()

   @Module({})
   export class BymaxQueueModule extends ConfigurableModuleClass {
     static forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
       validateOptions(options)
       const resolved = applyDefaults(options)
       const base = super.forRoot(options)
       const providers: Provider[] = [
         ...(base.providers ?? []),
         { provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN },
         { provide: BYMAX_QUEUE_RESOLVED_OPTIONS, useValue: resolved },
         { provide: ConnectionResolver, useFactory: async (opts: BymaxQueueModuleOptions) => { const r = new ConnectionResolver(opts); await r.init(); return r }, inject: [BYMAX_QUEUE_OPTIONS] },
         QueueService,
       ]
       return { ...base, providers, exports: [QueueService, ConnectionResolver, BYMAX_QUEUE_OPTIONS, BYMAX_QUEUE_RESOLVED_OPTIONS] }
     }
   }
   ```

2. `src/server/index.ts` — explicit named re-exports per spec §3.3: the module, the four `BYMAX_QUEUE_*` tokens, `QueueService` + `ConnectionResolver`, the interface types, `QueueException`, the default/error constants, the BullMQ convenience type re-exports (`Job`, `JobsOptions`, `Queue`, `Worker`, `QueueEvents`), and the shared re-exports (`JobStatus`, `QueueMetrics`, `JobSchedulerRepeatOptions`, `QueueErrorCode`, `JOB_STATUS`).

3. Unit specs (Jest + ts-jest), targeting 100% line/branch on every implemented file:
   - `connection-resolver.service.spec.ts` — Mode A accept (used as-is for Queue role); Mode A reject `end` client (`CONNECTION_INVALID`); Mode A fail-fast `CONNECTION_REQUIRES_NULL_RETRIES` when the duplicated probe is not `null`; Mode B (url) reaches ready; Mode B `CONNECTION_TIMEOUT`; `onModuleDestroy` calls `quit()` in Mode B and does NOT touch a Mode A client. Use `ioredis-mock` for Mode B.
   - `queue.service.spec.ts` — mock `bullmq.Queue`; assert cache hit/miss, `enqueue` → `add(name,data,opts)`, bulk failure → `QueueException(BULK_ENQUEUE_FAILED)`, `getJob` → `null` when absent, metrics shape, `cleanQueue` arg order, `onModuleDestroy` closes all.
   - `validate-options.spec.ts` — every throw branch + the happy path.
   - `resolved-options.spec.ts` — defaults applied, `defaultJobOptions` merged not replaced, result is frozen (mutation throws).
   - `validate-connection.spec.ts` — `assertBlockingConnection` throw/pass, `isClientUsable` truth table, `duplicateConnection` forces `null`.
   - `bymax-queue.module.spec.ts` — `forRoot` registers `QueueService`/`ConnectionResolver`/tokens; `DynamicModule.global === true` by default and `false` when `isGlobal:false`; `forRoot({ connection: {} as never })` throws.

Constraints:
- TS strict, no `any` in lib or specs (use `as never`/typed mocks). JSDoc on `forRoot` (with `@example`) and the barrel members. 100% line/branch coverage — no `eslint-disable`/`@ts-ignore`/istanbul-ignore.
- No `@Global`, no `forFeature`. English-only, timeless comments. Follow `/bymax-workflow:standards`. Current BullMQ API only.
- Test execution is bounded: run Jest with `--maxWorkers=2`; do not fan out parallel agents.

Verification:
- `pnpm typecheck && pnpm lint` — expected: clean.
- `pnpm test:cov:all` — expected: pass at `100/100/100/100` on every implemented file.
- `pnpm build && pnpm size` — expected: `dist/server/index.mjs` ≤ 18 KiB brotli, `dist/shared/index.mjs` ≤ 2.5 KiB brotli.
- Optional smoke (requires local Redis): a minimal NestJS context importing `BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } })`, then `queueService.enqueue('smoke','hello',{greet:'world'})` and `getMetrics('smoke')`.

Completion Protocol:
1. Set status ✅ (block + index). 2. Tick AC. 3. Update the 1.8 index row. 4. Progress `8 / 8`.
5. Update the Phase 1 row in `docs/development_plan.md` (mark ✅ when all eight tasks are done; update Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append: `- 1.8 ✅ <YYYY-MM-DD> — <summary>`.
````

---

## Completion log

> Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`.

<!-- No entries yet. The first completed task appends its line here. -->
