# Development Plan — @bymax-one/nest-queue

> **Version:** 2.0.0
> **Last updated:** 2026-06-26
> **Status:** Ready for execution
> **Reference spec:** [`docs/technical_specification.md`](./technical_specification.md)
> **Target engine:** BullMQ `^5.16.0` (Job Schedulers) + ioredis `^5` (peer deps)
> **Derived documents:** `docs/tasks/phase-NN-<slug>.md` (Layer 3 — one file per phase, generated from this plan)

---

## Table of Contents

1. [Plan Overview](#1-plan-overview)
2. [Phase 1 — Foundation + ConnectionResolver + base QueueService](#2-phase-1--foundation--connectionresolver--base-queueservice)
3. [Phase 2 — Workers (@Processor + WorkerRegistry)](#3-phase-2--workers-processor--workerregistry)
4. [Phase 3 — Flows + Job Schedulers + Metrics + Health](#4-phase-3--flows--job-schedulers--metrics--health)
5. [Phase 4 — forRootAsync + E2E + Mutation Baseline + Graceful Shutdown](#5-phase-4--forrootasync--e2e--mutation-baseline--graceful-shutdown)
6. [Phase 5 — Release v0.1.0](#6-phase-5--release-v010)
7. [Appendix A — Dependency Graph](#appendix-a--dependency-graph)
8. [Appendix B — Complexity Matrix](#appendix-b--complexity-matrix)
9. [Appendix C — Reference Configs](#appendix-c--reference-configs)
10. [Appendix D — Glossary](#appendix-d--glossary)

---

## 1. Plan Overview

### 1.1 Development strategy

Implementation follows the **TDD red-green-refactor** protocol with vertically sliced phases:

- Each phase ships **end-to-end usable functionality** — when a phase closes you can install the lib in a NestJS fixture app and exercise the feature.
- **Tests precede implementation** for every file with non-trivial logic (`QueueService`, `WorkerRegistry`, `ConnectionResolver`, `FlowService`, `MetricsService`, `QueueLifecycle`).
- **Per-phase coverage gate**: 100% line/branch on every file the phase implements (enforced by `jest.coverage.config.ts` thresholds `100/100/100/100`).
- **Mutation testing** runs as a **pre-release** gate only (Stryker `break 95`, takes 10–20 min) — not in per-commit CI.
- **Refactor pass + `/bymax-quality:code-review`** at the end of every phase, before marking it done.

The phase order respects the dependency graph (Appendix A): connection before queue; queue before worker; worker before flow/scheduler/metrics; everything before shutdown + E2E.

### 1.2 Guiding principles

| Principle | Practical application |
|---|---|
| **TS strict, zero `any`** | `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Exceptions (BullMQ signatures that use `any`) are re-exported as `unknown` on the lib's public API. |
| **JSDoc on every exported symbol** | Every `export` (class, function, interface, constant) carries JSDoc with `@example` where applicable. |
| **English in code** | Identifiers, comments, JSDoc, error messages — all English. Docs under `docs/` are in English. |
| **Zero `dependencies`** | `package.json` ships `"dependencies": {}`. Everything via peer dep — reduces supply chain surface. |
| **Dependency inversion over the connection** | The lib accepts injected Redis (Mode A) or opens its own (Mode B). **Never reads env vars directly**. |
| **Safe defaults** | `attempts: 3`, exponential backoff, `concurrency: 2`, 24h/7d retention. Override per option, always. |
| **End-to-end typing** | `enqueue<TData, TResult>()`, `Job<TData, TResult>`, generic decorators. No `Job<any, any>` in the public API. |
| **Fail fast, clear message** | Invalid options blow up in `forRoot()` with an actionable message, not via subtle runtime failure. |
| **No deep barrel re-exports** | `src/server/index.ts` explicitly references each export — better tree-shaking. |
| **Clean Code sizing & SRP** | Functions ≤ 50 lines, files ≤ 800 lines (200–400 typical); one responsibility per file/function; split by responsibility when over the limit. |
| **Official docs first — never from memory** | Before coding against any library/SDK/CLI (BullMQ, ioredis, NestJS), re-verify the current official docs (`context7` → official site). Trained memory goes stale; BullMQ's API moves fast. |
| **Layered architecture & reuse** | Every source file carries an `@fileoverview` + `@layer` header; reuse `@bymax-one/*` libs and BullMQ rather than reimplementing; DRY. |
| **BullMQ floor `^5.16.0`** | The peer dep floor is `bullmq ^5.16.0` (where the Job Schedulers API landed; current release `5.79.1`). Because the lib uses Job Schedulers (not the removed `addRepeatable` API), it is forward-compatible with v6; promotion to `^5.16.0 \|\| ^6` happens once the E2E suite is green on v6 (see §6.5). |
| **Conventional Commits** | `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Drives the semver bump on release. |

### 1.3 Phase dashboard

> **Status legend:** 📋 ToDo · 🔄 In Progress · 👀 Review · ✅ Done · ⛔ Blocked · 🟡 Partial

**Overall progress:** ✅ 3 / 5 phases (60%) — 20 / 35 tasks (57%)
**Active phase:** Phase 4 — forRootAsync + Graceful Shutdown + E2E + Mutation
**Blocked:** none

| ID | Phase | Status | Progress | Complexity | Last updated |
|---|---|---|---|---|---|
| 1 | [Foundation + ConnectionResolver + base QueueService](./tasks/phase-01-foundation.md) | ✅ Done | 8 / 8 | MEDIUM | 2026-06-26 |
| 2 | [Workers — decorators + WorkerRegistry + Discovery](./tasks/phase-02-workers.md) | ✅ Done | 6 / 6 | MEDIUM | 2026-06-26 |
| 3 | [Flows + Job Schedulers + Deduplication/Telemetry + Metrics](./tasks/phase-03-flows-schedulers-metrics.md) | ✅ Done | 6 / 6 | MEDIUM | 2026-06-27 |
| 4 | [forRootAsync + Graceful Shutdown + E2E + Mutation](./tasks/phase-04-async-shutdown-e2e.md) | 📋 ToDo | 0 / 7 | HIGH | 2026-06-23 |
| 5 | [Release v0.1.0 — docs, CI/CD, supply chain, publish](./tasks/phase-05-release.md) | 📋 ToDo | 0 / 8 | LOW | 2026-06-23 |
| | **Total** | **✅ 3 / 5 phases** | **20 / 35 tasks** | — | — |

> **No time estimate** — this plan targets execution by **AI agents**, so duration in human days does not apply. Relative complexity per phase is documented above and detailed per sub-step in the [Complexity Matrix in Appendix B](#appendix-b--complexity-matrix); use these signals to prioritize careful human review on HIGH-complexity phases.

> **Phase mapping to spec §15.** The spec slices the roadmap into 4 logical phases; this plan keeps the same total scope but splits the spec's Phase 4 (E2E + polish + release prep) into plan **Phase 4** (forRootAsync + graceful shutdown + E2E + mutation baseline) and plan **Phase 5** (release/publish). 4 spec phases ≡ 5 plan phases — not a contradiction. The per-phase descriptive content and "Sub-steps" granularity live in the §2–§6 phase sections; the derived `docs/tasks/phase-NN-*.md` files split those sub-steps into the **35** executable tasks tracked above (per the §1.6 derivation rule), so the canonical denominator for progress is **35 tasks**.

#### Update protocol

When a task or phase changes state, the executing agent updates this dashboard so it never drifts:

1. In the phase's `docs/tasks/phase-NN-*.md`: set the task's status emoji, tick its acceptance criteria, update its index row, and bump the file's `Progress: X / N tasks` header.
2. In this file: set the phase's **Status** + **Last updated** and bump its **Progress** cell; then recompute **Overall progress** (phases-done / 5 and tasks-done / 35) and update **Active phase** / **Blocked**.
3. Never mark a phase ✅ while any §1.4 Global Done criterion is unmet — use 🟡 Partial.
4. Commit with a `docs(plan): …` Conventional Commit (no attribution trailer).

### 1.4 Global Done criteria per phase

A phase is only marked **Done** when, **cumulatively**:

- [ ] `pnpm typecheck` passes with no errors
- [ ] `pnpm lint` passes with no warnings (no `eslint-disable`)
- [ ] `pnpm test:cov:all` passes with 100% line/branch coverage on every implemented file (`jest.coverage.config.ts` → `100/100/100/100`)
- [ ] `pnpm build` produces `dist/` with `.mjs`, `.cjs`, `.d.ts` for the 2 declared subpaths (`server`, `shared`)
- [ ] All sub-step acceptance criteria are checked
- [ ] JSDoc present on every new export; every new file carries an `@fileoverview` + `@layer` header
- [ ] Clean Code sizing respected (no function > 50 lines, no file > 800 lines)
- [ ] Official docs re-verified (via `context7`) for each library touched in the phase
- [ ] A phase-specific smoke test passes on a minimal NestJS fixture (module boots, the phase's surface works end to end)
- [ ] `git status` clean (commits made with Conventional Commits)
- [ ] `/bymax-quality:code-review` run and findings applied

### 1.5 Expected end file structure (after Phase 5)

```
nest-queue/
├── .github/
│   ├── workflows/                 # ci.yml, codeql.yml, release.yml, scorecard.yml, osv-scanner.yml
│   ├── copilot-instructions.md
│   ├── instructions/              # code.instructions.md, tests.instructions.md
│   └── agents/                    # agent-code-reviewer.agent.md
├── docs/
│   ├── technical_specification.md
│   ├── development_plan.md        ← this file
│   ├── mutation_testing_plan.md
│   ├── mutation_testing_results.md
│   └── tasks/                     # one file per phase (executable agent prompts)
│       ├── phase-01-foundation.md
│       ├── phase-02-workers.md
│       ├── phase-03-flows-schedulers-metrics.md
│       ├── phase-04-async-shutdown-e2e.md
│       └── phase-05-release.md
├── scripts/check-size.mjs
├── src/server/
│   ├── index.ts
│   ├── bymax-queue.module.ts
│   ├── bymax-queue.constants.ts
│   ├── interfaces/
│   ├── config/
│   ├── services/
│   ├── decorators/
│   ├── lifecycle/
│   ├── constants/
│   ├── errors/
│   └── utils/
├── src/shared/
│   ├── index.ts
│   ├── types/
│   └── constants/
├── test/e2e/                      # E2E specs with Testcontainers Redis
├── package.json
├── tsup.config.ts
├── tsconfig.json (+ build / server / e2e / jest variants)
├── jest.config.ts (+ coverage / e2e / stryker variants)
├── stryker.config.json
├── eslint.config.mjs
├── commitlint.config.cjs
├── README.md / CHANGELOG.md / SECURITY.md / LICENSE / CLAUDE.md / AGENTS.md
```

### 1.6 How this plan feeds `docs/tasks/`

Each **sub-step** numbered in this plan (§2.X, §3.X, etc.) becomes **one or more executable tasks** in the per-phase files under `docs/tasks/phase-NN-<slug>.md`. Derivation rule:

- Sub-step with **one file + logic < 100 LoC** → **1 task**
- Sub-step with **multiple related files** → **grouped task** with per-file checklist
- Sub-step with **logic > 200 LoC or high blast radius** (e.g. `QueueLifecycle`) → **task split** into red (test), green (impl), refactor

Each task carries the full prompt for AI agent execution (Role / Project / Preconditions / Required Reading / Task / Deliverables / Constraints / Verification / Completion Protocol — `/bymax-workflow:phase-tasks` standard). The phase files are the canonical task source; this plan stays the phase dashboard.

---

## 2. Phase 1 — Foundation + ConnectionResolver + base QueueService

> **Phase goal:** Set up the complete project scaffold, define public contracts (interfaces, types, constants), implement `ConnectionResolver` with support for both modes (A: BYO client / B: lib-owned), `QueueService` with queue cache and typed helpers (`enqueue`, `enqueueBulk`, `getJob`, `getJobs`, `getMetrics`, `pauseQueue/resumeQueue/cleanQueue`), and register synchronous `BymaxQueueModule.forRoot()`. By the end you can install the lib in a fixture, enqueue a job, and read its count.
>
> **Complexity:** MEDIUM.
>
> **Highest-blast-radius files (100% line/branch, like every implemented file):** `src/server/services/connection-resolver.service.ts`, `src/server/services/queue.service.ts`, `src/server/config/resolved-options.ts`, `src/server/utils/validate-connection.ts`.

### 2.1 Project scaffold

**Goal:** Create the folder structure, configuration files, and base dependencies, mirroring the canonical `nest-auth` / `nest-logger` configs.

**Files to create:**

```
nest-queue/
├── .gitignore
├── .prettierrc
├── .npmignore
├── eslint.config.mjs
├── jest.config.ts
├── jest.coverage.config.ts
├── jest.e2e.config.ts
├── jest.stryker.config.ts
├── stryker.config.json
├── tsconfig.json
├── tsconfig.build.json
├── tsconfig.server.json
├── tsconfig.e2e.json
├── tsconfig.jest.json
├── tsup.config.ts
├── commitlint.config.cjs
├── package.json
├── scripts/check-size.mjs
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                # incremental-safe: typecheck/lint/test:cov/build/size — green on the first empty-source PR
│   │   ├── codeql.yml
│   │   ├── scorecard.yml
│   │   ├── osv-scanner.yml
│   │   └── release.yml           # created here but INERT — fires only on a v*.*.* tag
│   ├── copilot-instructions.md
│   ├── instructions/{code,tests}.instructions.md
│   └── agents/agent-code-reviewer.agent.md
├── src/server/index.ts          # empty in this step — only placeholder
└── src/shared/index.ts          # empty in this step
```

> **Incremental-safe CI (must hold at every phase).** Because the whole library is built by AI agents, CI must gate **every** PR from the first one — so the workflows are created here in Phase 1, not at release. `ci.yml` is incremental-safe: `jest --passWithNoTests`, coverage scoped via `collectCoverageFrom` over implemented files only (100% on what exists), `e2e` is pass-with-no-tests until Phase 4 adds specs, and the size budget passes on a near-empty bundle. `release.yml` is created now but stays inert until a `v*.*.*` tag (Phase 5). The Copilot review files and `commitlint.config.cjs` likewise land here so every PR is reviewed under them.

> The `test/e2e/` directory is created on demand when the E2E specs are added (no placeholder files).

**Reference content:**

Copy from `nest-auth/` / `nest-logger/` and adapt (`nest-auth` → `nest-queue`, 5 entries → 2 entries, peer deps `bullmq` + `ioredis` instead of `pino`).

**Detail — `package.json` (key fields):**

```json
{
  "name": "@bymax-one/nest-queue",
  "version": "0.1.0-alpha.0",
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "LICENSE", "README.md", "CHANGELOG.md"],
  "exports": {
    ".": {
      "types": "./dist/server/index.d.ts",
      "import": "./dist/server/index.mjs",
      "require": "./dist/server/index.cjs"
    },
    "./shared": {
      "types": "./dist/shared/index.d.ts",
      "import": "./dist/shared/index.mjs",
      "require": "./dist/shared/index.cjs"
    }
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
    "clean": "rm -rf dist coverage",
    "prepublishOnly": "pnpm clean && pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build",
    "release": "pnpm publish --provenance"
  },
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "bullmq": "^5.16.0",
    "ioredis": "^5.0.0",
    "reflect-metadata": "^0.2.0",
    "bullmq-otel": "^1.0.0"
  },
  "peerDependenciesMeta": {
    "bullmq-otel": { "optional": true }
  },
  "packageManager": "pnpm@11.0.0",
  "engines": { "node": ">=24.0.0" },
  "publishConfig": { "access": "public", "provenance": true, "registry": "https://registry.npmjs.org/" }
}
```

**Detail — `tsup.config.ts`:**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { 'server/index': 'src/server/index.ts' },
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
  },
  {
    entry: { 'shared/index': 'src/shared/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    tsconfig: 'tsconfig.build.json',
    outDir: 'dist',
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
    target: 'node24',
    splitting: false,
    treeshake: true,
    sourcemap: false,
  },
])
```

**Detail — `scripts/check-size.mjs`:** budgets `server: 18_432` (18 KiB) brotli, `shared: 2_500` brotli (the lib is small — it supersedes a ~154 LoC hand-rolled helper).

**Acceptance criteria:**

- [ ] Directory structure created per tree above
- [ ] `package.json` with 2 subpaths and correct peer deps
- [ ] `tsup.config.ts` with 2 entries; externals include `bullmq` and `ioredis`
- [ ] `eslint.config.mjs` flat config v9 with no warnings on empty folders
- [ ] `pnpm install` completes without errors
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build` pass with placeholder `index.ts`

**Validation commands:**

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm build
ls -la dist/server/ dist/shared/
```

**Dependencies:** none — this is the first sub-step.

**Risks/Notes:**

- `bullmq` and `ioredis` stay **outside** the bundle via `external` — essential for tree-shaking and size.
- Do not copy `tsup.config.ts` from nest-auth literally (5 entries vs 2).

### 2.2 Shared types and constants (`src/shared/`)

**Goal:** Define types and constants that are public without NestJS/BullMQ dependencies. Consumable from any runtime (CI scripts, cross-tier validation, etc.).

**Files to create:**

```
src/shared/
├── types/
│   ├── job-status.types.ts
│   ├── queue-metrics.types.ts
│   └── job-scheduler-options.types.ts
├── constants/
│   ├── job-status.ts
│   └── error-codes.ts
└── index.ts
```

**Skeleton — `src/shared/types/job-status.types.ts`:**

```typescript
/**
 * Snapshot statuses BullMQ exposes via `Queue.getJobCounts()`.
 * Kept in sync with bullmq's internal status set.
 */
export type JobStatus =
  | 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'
```

**Skeleton — `src/shared/types/queue-metrics.types.ts`:**

```typescript
import type { JobStatus } from './job-status.types'

/** Instantaneous snapshot of a queue's job counts. */
export interface QueueMetrics {
  queue: string
  counts: Record<Extract<JobStatus, 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'>, number>
  collectedAt: string  // ISO 8601 UTC
}
```

**Skeleton — `src/shared/types/job-scheduler-options.types.ts`:**

```typescript
/**
 * Discriminated union for the BullMQ Job Schedulers API (the current recurring-jobs
 * surface; the legacy `addRepeatable` API is removed in BullMQ v6).
 * Either `pattern` (cron) OR `every` (ms interval) — never both.
 *
 * Thin, validated projection of BullMQ's `RepeatOptions` (minus the internal `key`).
 */
export type JobSchedulerRepeatOptions =
  | {
      /** Crontab expression (5-field, or 6-field with seconds). */
      pattern: string
      /** IANA timezone (e.g. 'America/Sao_Paulo'). Default: UTC. */
      tz?: string
      /** Optional cap on the number of runs. */
      limit?: number
      /** Start time (epoch ms or ISO). */
      startDate?: number | string
      /** Stop time (epoch ms or ISO). Must be in the future or BullMQ throws. */
      endDate?: number | string
      /** Fire the first occurrence immediately at registration. Cron only. */
      immediately?: boolean
    }
  | {
      /** Interval in milliseconds between runs. */
      every: number
      /** Optional cap on the number of runs. */
      limit?: number
      /** Phase offset (ms) for interval schedulers. */
      offset?: number
      startDate?: number | string
      endDate?: number | string
    }
```

**Skeleton — `src/shared/constants/job-status.ts`:**

```typescript
/** Canonical job status constants — use in business logic to avoid hardcoded strings. */
export const JOB_STATUS = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DELAYED: 'delayed',
  PAUSED: 'paused',
} as const
```

**Skeleton — `src/shared/constants/error-codes.ts`:**

```typescript
/** Error codes emitted by QueueException — see technical_specification.md §12. */
export const QUEUE_ERROR_CODES = {
  CONNECTION_INVALID: 'queue.connection_invalid',
  CONNECTION_REQUIRES_NULL_RETRIES: 'queue.connection_requires_null_retries',
  CONNECTION_TIMEOUT: 'queue.connection_timeout',
  QUEUE_NOT_FOUND: 'queue.queue_not_found',
  JOB_NOT_FOUND: 'queue.job_not_found',
  INVALID_JOB_DATA: 'queue.invalid_job_data',
  INVALID_REPEAT_OPTIONS: 'queue.invalid_repeat_options',
  DUPLICATE_PROCESSOR: 'queue.duplicate_processor',
  FLOW_DISABLED: 'queue.flow_disabled',
  METRICS_DISABLED: 'queue.metrics_disabled',
  SHUTDOWN_TIMEOUT_EXCEEDED: 'queue.shutdown_timeout_exceeded',
  BULK_ENQUEUE_FAILED: 'queue.bulk_enqueue_failed',
  WORKER_REGISTRATION_FAILED: 'queue.worker_registration_failed',
  INVALID_OPTIONS: 'queue.invalid_options',
} as const

export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES]
```

**Skeleton — `src/shared/index.ts`:**

```typescript
export type { JobStatus } from './types/job-status.types'
export type { QueueMetrics } from './types/queue-metrics.types'
export type { JobSchedulerRepeatOptions } from './types/job-scheduler-options.types'
export { JOB_STATUS } from './constants/job-status'
export { QUEUE_ERROR_CODES } from './constants/error-codes'
export type { QueueErrorCode } from './constants/error-codes'
```

**Acceptance criteria:**

- [ ] All files created per the tree
- [ ] JSDoc present on every export
- [ ] `pnpm build` generates `dist/shared/index.{mjs,cjs,d.ts}`
- [ ] Bundle `dist/shared/index.mjs` < 2.5 KiB brotli
- [ ] `import('@bymax-one/nest-queue/shared')` resolves correctly in a fixture

**Validation commands:**

```bash
pnpm build && pnpm size
node -e "import('./dist/shared/index.mjs').then(m => console.log(Object.keys(m).sort()))"
```

**Dependencies:** §2.1.

**Risks/Notes:**

- `as const` is mandatory on constants — preserves literal types in `.d.ts`.
- No logic in `shared/` — only pure types and constants.

### 2.3 Interfaces and contracts (`src/server/interfaces/`)

**Goal:** Define every public interface — `BymaxQueueModuleOptions`, `QueueConnectionConfig`, `WorkerOptions`, `ProcessorMetadata`, `BulkJob<TData>`.

**Files to create:**

```
src/server/interfaces/
├── queue-module-options.interface.ts
├── queue-connection.interface.ts
├── worker-options.interface.ts
├── processor-metadata.interface.ts
├── queue-job-data.interface.ts
└── index.ts
```

**Skeleton — `src/server/interfaces/queue-connection.interface.ts`:**

```typescript
import type { Redis, RedisOptions } from 'ioredis'

/**
 * Connection configuration — Mode A or Mode B (mutually exclusive).
 *
 * Mode A: caller passes a `Redis` already configured for BullMQ
 *         (typically obtained from `@bymax-one/nest-cache` `getClientForQueue()`).
 *         The lib does NOT close it.
 *
 * Mode B: lib opens its own `ioredis` using a URL or options object.
 *         The Queue/FlowProducer connection keeps ioredis' default retries (so enqueue
 *         fails fast during a Redis outage); worker/QueueEvents connections are
 *         duplicated with `maxRetriesPerRequest: null`. The lib closes it on `onModuleDestroy`.
 *
 * @example Mode A
 *   { client: queueRedis }
 * @example Mode B (url)
 *   { url: process.env.REDIS_URL, options: { db: 1 } }
 * @example Mode B (options only)
 *   { options: { host: 'localhost', port: 6379, db: 1 } }
 */
export type QueueConnectionConfig =
  | { client: Redis; ownsConnection?: false }
  | { url: string; options?: Partial<RedisOptions> }
  | { options: RedisOptions }

/** Internal discriminator used by ConnectionResolver to tag the active mode. */
export type QueueConnectionMode = 'mode-a-byo' | 'mode-b-owned'
```

**Skeleton — `src/server/interfaces/worker-options.interface.ts`:**

```typescript
/**
 * Tunables applied when registering a Worker (via decorator or programmatically).
 * Maps 1:1 to the bullmq `WorkerOptions` subset relevant to the lib's defaults.
 */
export interface WorkerOptions {
  /** Max concurrent jobs. Default: DEFAULT_WORKER_CONCURRENCY (2). */
  concurrency?: number

  /** Rate limiter — `max` jobs per `duration` ms (e.g. `{ max: 10, duration: 1000 }`). */
  limiter?: { max: number; duration: number }

  // NOTE: there is intentionally NO `sandboxed` boolean. BullMQ sandboxed processors
  // are created by passing a FILE PATH (not a class) to the Worker constructor, so they
  // run out-of-process and CANNOT use NestJS DI. A toggle on a DI-managed @Processor is
  // therefore impossible — sandboxed work uses WorkerRegistry.registerSandboxed (§3.2, §6.8).

  /** Auto-start worker on registration. Default: true. */
  autorun?: boolean

  /** Lock duration for active jobs in ms. Default: 30_000. */
  lockDuration?: number

  /** Stalled job check interval in ms. Default: 30_000. */
  stalledInterval?: number
}
```

**Skeleton — `src/server/interfaces/processor-metadata.interface.ts`:**

```typescript
import type { WorkerOptions } from './worker-options.interface'

/** Metadata attached by @Processor decorator and read by WorkerRegistry on discovery. */
export interface ProcessorMetadata {
  queueName: string
  workerOptions: WorkerOptions
}

/** Metadata attached by @Process decorator on a handler method. */
export interface ProcessHandlerMetadata {
  /** Specific jobName filter — `undefined` means catch-all. */
  jobName?: string
  /** Method key on the host class (used by the registry to resolve dispatch). */
  methodKey: string | symbol
}

/** Metadata attached by @OnQueueEvent decorator on a listener method. */
export interface QueueEventListenerMetadata {
  eventName: string
  methodKey: string | symbol
}
```

**Skeleton — `src/server/interfaces/queue-job-data.interface.ts`:**

```typescript
import type { JobsOptions } from 'bullmq'

/** Single job descriptor used by `enqueueBulk`. */
export interface BulkJob<TData = unknown> {
  name: string
  data: TData
  options?: JobsOptions
}
```

**Skeleton — `src/server/interfaces/queue-module-options.interface.ts`:**

```typescript
import type { ModuleMetadata, Type } from '@nestjs/common'
import type { JobsOptions, QueueOptions, Telemetry } from 'bullmq'
import type { QueueConnectionConfig } from './queue-connection.interface'

/** Synchronous configuration for `BymaxQueueModule.forRoot()`. */
export interface BymaxQueueModuleOptions {
  connection: QueueConnectionConfig
  defaultJobOptions?: JobsOptions
  prefix?: string
  queueOptions?: Partial<Omit<QueueOptions, 'connection' | 'defaultJobOptions' | 'prefix'>>
  flows?: { enabled?: boolean }
  metrics?: { enabled?: boolean; cacheTtlMs?: number }
  /**
   * OpenTelemetry instrumentation. Opt-in. Pass a BullMQ `Telemetry` implementation
   * (typically `new BullMQOtel(...)` from the OPTIONAL peer dep `bullmq-otel`). When set,
   * it is attached to every Queue/Worker so spans propagate from enqueue() into the handler.
   */
  telemetry?: Telemetry
  shutdown?: { drainTimeoutMs?: number; drainOnShutdown?: boolean }
  /**
   * Register the module globally. Mapped to `DynamicModule.global` by
   * `ConfigurableModuleBuilder.setExtras` — there is no hand-written `@Global` decorator. Default: true.
   */
  isGlobal?: boolean
  /** Mode B only: ms to wait for Redis `ready` before throwing. Default: 10_000. */
  connectionReadyTimeoutMs?: number
}

/** Async configuration mirroring the NestJS standard async dynamic module pattern. */
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

**Skeleton — `src/server/interfaces/index.ts`:**

```typescript
export type { QueueConnectionConfig, QueueConnectionMode } from './queue-connection.interface'
export type { WorkerOptions } from './worker-options.interface'
export type {
  ProcessorMetadata,
  ProcessHandlerMetadata,
  QueueEventListenerMetadata,
} from './processor-metadata.interface'
export type { BulkJob } from './queue-job-data.interface'
export type {
  BymaxQueueModuleOptions,
  BymaxQueueModuleAsyncOptions,
  BymaxQueueOptionsFactory,
} from './queue-module-options.interface'
```

**Acceptance criteria:**

- [ ] All interfaces created with full JSDoc
- [ ] `readonly` on arrays/lists where applicable
- [ ] `pnpm typecheck` passes
- [ ] No `any` in any signature

**Validation commands:**

```bash
pnpm typecheck
grep -nE ': any\b|any\[\]' src/server/interfaces/  # expect: no match
```

**Dependencies:** §2.1 (build chain), §2.2 (shared types unused here, but alignment).

**Risks/Notes:**

- `QueueConnectionConfig` is the key to dual-mode — keep the discriminated union by presence of `client` vs `url` vs `options`.

### 2.4 Constants and DI tokens

**Goal:** Define injection tokens (`Symbol()`) and internal constants (job options defaults, default concurrency).

**Files to create:**

```
src/server/bymax-queue.constants.ts
src/server/constants/
├── default-options.ts
├── error-codes.ts
└── index.ts
```

**Skeleton — `src/server/bymax-queue.constants.ts`:**

```typescript
/** Injection tokens — Symbols avoid collision with consumer tokens of the same string. */
export const BYMAX_QUEUE_OPTIONS = Symbol('BYMAX_QUEUE_OPTIONS')
export const BYMAX_QUEUE_REDIS_CLIENT = Symbol('BYMAX_QUEUE_REDIS_CLIENT')
export const BYMAX_QUEUE_CONNECTION_MODE = Symbol('BYMAX_QUEUE_CONNECTION_MODE')
export const BYMAX_QUEUE_RESOLVED_OPTIONS = Symbol('BYMAX_QUEUE_RESOLVED_OPTIONS')
```

**Skeleton — `src/server/constants/default-options.ts`:**

```typescript
import type { JobsOptions } from 'bullmq'

export const DEFAULT_WORKER_CONCURRENCY = 2 as const

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },  // 24h, 1000 entries
  removeOnFail: { age: 7 * 24 * 3600 },                // 7d
} as const satisfies JobsOptions

export const DEFAULT_CONNECTION_READY_TIMEOUT_MS = 10_000 as const
export const DEFAULT_METRICS_CACHE_TTL_MS = 5_000 as const
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000 as const
```

**Skeleton — `src/server/constants/error-codes.ts`:** re-export from `shared` + human-readable messages.

```typescript
export { QUEUE_ERROR_CODES } from '../../shared/constants/error-codes'
export type { QueueErrorCode } from '../../shared/constants/error-codes'

/** Human-readable messages keyed by error code. */
export const QUEUE_ERROR_MESSAGES: Record<string, string> = {
  'queue.connection_invalid': 'Invalid Redis connection configuration',
  'queue.connection_requires_null_retries': 'Redis client must have maxRetriesPerRequest=null',
  // ... (full list mirrors spec §12.2)
}
```

**Skeleton — `src/server/constants/index.ts`:** grouped re-export.

```typescript
export * from './default-options'
export * from './error-codes'
```

**Acceptance criteria:**

- [ ] Symbols are unique (verifiable: `===` reflexive, `!==` cross-token)
- [ ] `DEFAULT_JOB_OPTIONS satisfies JobsOptions` compiles
- [ ] `pnpm typecheck` passes

**Validation commands:**

```bash
pnpm typecheck
```

**Dependencies:** §2.2 (re-export of error-codes).

### 2.5 ConnectionResolver — dual-mode

**Goal:** Implement `ConnectionResolver` that detects the mode (A: BYO client / B: lib-owned), validates `maxRetriesPerRequest === null` in both cases, opens its own connection with timeout in mode B, and exposes `getClient()` + `isOwned()` so `QueueLifecycle` knows whether to close.

**Files to create:**

```
src/server/services/connection-resolver.service.ts
src/server/utils/validate-connection.ts
src/server/utils/duplicate-connection.ts
src/server/errors/queue-exception.ts
```

**Skeleton — `src/server/utils/validate-connection.ts`:**

```typescript
import type { Redis } from 'ioredis'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Asserts that a duplicated Worker/QueueEvents connection honors
 * `maxRetriesPerRequest: null`. BullMQ requires null on blocking connections
 * (`BRPOPLPUSH` / `BZPOPMIN` / `BLMOVE`) and throws at `Worker` construction otherwise.
 * The Queue/FlowProducer connection is NOT checked — it keeps ioredis' default retries so
 * `enqueue` fails fast during a Redis outage. Called on the duplicated probe in Mode A to
 * fail fast when a client wrapper prevents the `duplicate()` override from taking effect.
 * @throws QueueException with code CONNECTION_REQUIRES_NULL_RETRIES if the override is ignored
 */
export function assertBlockingConnection(client: Redis): void {
  const actual = (client.options ?? {}).maxRetriesPerRequest
  if (actual !== null) {
    throw new QueueException(
      QUEUE_ERROR_CODES.CONNECTION_REQUIRES_NULL_RETRIES,
      500,
      { actualValue: actual, expectedValue: null },
    )
  }
}

/** Returns true when the client is ready or connecting (BullMQ tolerates both). */
export function isClientUsable(client: Redis): boolean {
  return client.status === 'ready' || client.status === 'connecting'
}
```

**Skeleton — `src/server/utils/duplicate-connection.ts`:**

```typescript
import type { Redis } from 'ioredis'

/**
 * Safely duplicate an ioredis client for use by a Worker or QueueEvents.
 * Inherits all options and forces `maxRetriesPerRequest: null` on the duplicate.
 */
export function duplicateConnection(client: Redis): Redis {
  return client.duplicate({ maxRetriesPerRequest: null })
}
```

**Skeleton — `src/server/errors/queue-exception.ts`:**

```typescript
import { HttpException, HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_MESSAGES } from '../constants/error-codes'

/**
 * Standardized exception for queue operations.
 * Response shape: `{ error: { code, message, details } }`.
 */
export class QueueException extends HttpException {
  constructor(
    code: string,
    statusCode: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, unknown>,
  ) {
    super(
      { error: { code, message: QUEUE_ERROR_MESSAGES[code] ?? 'Queue error', details: details ?? null } },
      statusCode,
    )
  }
}
```

**Skeleton — `src/server/services/connection-resolver.service.ts`:**

```typescript
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { BYMAX_QUEUE_OPTIONS } from '../bymax-queue.constants'
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import type { QueueConnectionMode } from '../interfaces/queue-connection.interface'
import { assertBlockingConnection, isClientUsable } from '../utils/validate-connection'
import { duplicateConnection } from '../utils/duplicate-connection'
import { DEFAULT_CONNECTION_READY_TIMEOUT_MS } from '../constants/default-options'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

@Injectable()
export class ConnectionResolver implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectionResolver.name)
  private client!: Redis
  private mode!: QueueConnectionMode

  constructor(@Inject(BYMAX_QUEUE_OPTIONS) private readonly options: BymaxQueueModuleOptions) {}

  /** Resolves and validates the client. Must be called once during module bootstrap. */
  async init(): Promise<void> {
    const cfg = this.options.connection
    if ('client' in cfg) {
      // Mode A — BYO. The received client is used AS-IS for the Queue/FlowProducer role
      // (it keeps its own retry policy). Worker/QueueEvents use duplicated connections forced
      // to maxRetriesPerRequest:null; fail fast if a wrapper prevents that override.
      this.mode = 'mode-a-byo'
      this.client = cfg.client
      if (!isClientUsable(this.client)) {
        throw new QueueException(QUEUE_ERROR_CODES.CONNECTION_INVALID, 500, { status: this.client.status })
      }
      const probe = duplicateConnection(this.client)
      try {
        assertBlockingConnection(probe)
      } finally {
        probe.disconnect()
      }
      return
    }

    // Mode B — open our own. The Queue connection keeps ioredis' DEFAULT retries (so enqueue
    // fails fast during a Redis outage); worker/QueueEvents connections are duplicated with
    // maxRetriesPerRequest:null by duplicateConnection().
    this.mode = 'mode-b-owned'
    const timeoutMs = this.options.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS
    this.client = 'url' in cfg
      ? new Redis(cfg.url, { ...(cfg.options ?? {}), lazyConnect: false })
      : new Redis({ ...cfg.options, lazyConnect: false })

    await this.waitReady(timeoutMs)
  }

  getClient(): Redis { return this.client }
  getMode(): QueueConnectionMode { return this.mode }
  isOwned(): boolean { return this.mode === 'mode-b-owned' }

  async onModuleDestroy(): Promise<void> {
    if (this.isOwned() && this.client) {
      // Graceful disconnect; ioredis flushes pending commands.
      await this.client.quit().catch(() => this.client.disconnect())
    }
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    if (this.client.status === 'ready') return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new QueueException(QUEUE_ERROR_CODES.CONNECTION_TIMEOUT, 500, { timeoutMs }))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.client.off('ready', onReady)
        this.client.off('error', onError)
      }
      const onReady = (): void => { cleanup(); resolve() }
      const onError = (err: Error): void => { cleanup(); reject(err) }
      this.client.once('ready', onReady)
      this.client.once('error', onError)
    })
  }
}
```

**Acceptance criteria:**

- [ ] Mode A: a `ready` client is accepted (used as-is for the Queue role); an `end` client is rejected with `CONNECTION_INVALID`
- [ ] Mode A: the received client's `maxRetriesPerRequest` is **not** required to be `null`; the lib fails fast with `CONNECTION_REQUIRES_NULL_RETRIES` only when the duplicated worker connection cannot be coerced to `null`
- [ ] Mode B (URL): connects within the timeout; the Queue connection keeps ioredis default retries
- [ ] Mode B (options-only): same guarantee
- [ ] Mode B: `onModuleDestroy` calls `quit()` (fallback `disconnect()`)
- [ ] Mode A: `onModuleDestroy` **does not** touch the connection
- [ ] `waitReady` rejects after `timeoutMs` with `CONNECTION_TIMEOUT`
- [ ] 100% line/branch coverage on the resolver and utils
- [ ] `duplicateConnection()` returns a client with `maxRetriesPerRequest: null`

**Validation commands:**

```bash
pnpm test src/server/services/connection-resolver.service.spec.ts
pnpm test src/server/utils/
```

**Dependencies:** §2.3 (interfaces), §2.4 (constants).

**Risks/Notes:**

- **Connection sharing pattern with `nest-cache`:** the canonical case is Mode A — `nest-cache` exposes `BYMAX_CACHE_QUEUE_REDIS` (an `ioredis` client dedicated to BullMQ); the consumer injects that token into the `nest-queue` `useFactory` (`{ client: queueRedis }`). `nest-queue` reuses the same client AS-IS for all `Queue`s and `FlowProducer`s (Queue role keeps default retries), but **always** duplicates via `duplicateConnection()` — forcing `maxRetriesPerRequest: null` — for `Worker` and `QueueEvents` (BullMQ requirement for blocking commands `BRPOPLPUSH`/`BZPOPMIN`/`BLMOVE`). In Mode B (without `nest-cache`), the lib opens its own `ioredis` for the Queue role and closes it on shutdown. The fail-fast assertion on the duplicated worker connection prevents the classic blocking-command-returns-prematurely bug.
- ioredis emits `error` before `end` in some cases — listener cleanup is mandatory to avoid leaking handles.

### 2.6 Resolved options + validation

**Goal:** Merge consumer-provided options with defaults and validate critical preconditions in `forRoot()`.

**Files to create:**

```
src/server/config/
├── default-options.ts          # alias for constants/default-options
├── resolved-options.ts
└── validate-options.ts
```

**Skeleton — `src/server/config/validate-options.ts`:**

```typescript
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Validates user-provided options at module bootstrap.
 * Fails fast with actionable messages — never silently corrects.
 * @throws QueueException with code INVALID_OPTIONS on any violation
 */
export function validateOptions(opts: BymaxQueueModuleOptions): void {
  if (!opts.connection) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'connection is required' })
  }
  // Mutually-exclusive: cannot pass both `client` AND `url`/`options`.
  const cfg = opts.connection as Record<string, unknown>
  const hasClient = 'client' in cfg
  const hasUrl = 'url' in cfg
  const hasOptionsOnly = !hasClient && !hasUrl && 'options' in cfg
  if (!hasClient && !hasUrl && !hasOptionsOnly) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'connection must specify client | url | options' })
  }
  if (hasClient && (hasUrl || 'options' in cfg && !hasOptionsOnly)) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'connection.client is mutually exclusive with url/options' })
  }
  const drainTimeout = opts.shutdown?.drainTimeoutMs
  if (drainTimeout !== undefined && drainTimeout <= 0) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'shutdown.drainTimeoutMs must be > 0' })
  }
  const cacheTtl = opts.metrics?.cacheTtlMs
  if (cacheTtl !== undefined && cacheTtl < 0) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, 500, { reason: 'metrics.cacheTtlMs must be >= 0' })
  }
}
```

**Skeleton — `src/server/config/resolved-options.ts`:**

```typescript
import type { BymaxQueueModuleOptions } from '../interfaces/queue-module-options.interface'
import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_CONNECTION_READY_TIMEOUT_MS,
} from '../constants/default-options'

/** Fully-resolved options with defaults applied — every optional field is filled. */
export interface ResolvedQueueOptions {
  connection: BymaxQueueModuleOptions['connection']
  defaultJobOptions: NonNullable<BymaxQueueModuleOptions['defaultJobOptions']>
  prefix: string
  queueOptions: NonNullable<BymaxQueueModuleOptions['queueOptions']>
  flows: { enabled: boolean }
  metrics: { enabled: boolean; cacheTtlMs: number }
  shutdown: { drainTimeoutMs: number; drainOnShutdown: boolean }
  /** Optional OpenTelemetry instance, attached to every Queue/Worker when present. */
  telemetry?: BymaxQueueModuleOptions['telemetry']
  connectionReadyTimeoutMs: number
}

export function applyDefaults(opts: BymaxQueueModuleOptions): Readonly<ResolvedQueueOptions> {
  return Object.freeze({
    connection: opts.connection,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...(opts.defaultJobOptions ?? {}) },
    prefix: opts.prefix ?? 'bull',
    queueOptions: opts.queueOptions ?? {},
    flows: { enabled: opts.flows?.enabled ?? false },
    metrics: {
      enabled: opts.metrics?.enabled ?? false,
      cacheTtlMs: opts.metrics?.cacheTtlMs ?? DEFAULT_METRICS_CACHE_TTL_MS,
    },
    shutdown: {
      drainTimeoutMs: opts.shutdown?.drainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
      drainOnShutdown: opts.shutdown?.drainOnShutdown ?? false,
    },
    telemetry: opts.telemetry,
    connectionReadyTimeoutMs: opts.connectionReadyTimeoutMs ?? DEFAULT_CONNECTION_READY_TIMEOUT_MS,
  })
}
```

**Acceptance criteria:**

- [ ] `validateOptions` throws on: missing `connection`, ambiguous (`client` + `url`), `drainTimeoutMs <= 0`, `cacheTtlMs < 0`
- [ ] `applyDefaults` returns `Object.frozen` (mutation in strict mode throws)
- [ ] `defaultJobOptions` is merged (not replaced)
- [ ] 100% coverage on both files

**Validation commands:**

```bash
pnpm test src/server/config/
```

**Dependencies:** §2.3, §2.4.

### 2.7 Base QueueService (no decorators yet)

**Goal:** Implement `QueueService` covering `Queue` caching, `enqueue<T>`, `enqueueBulk<T>`, `getJob`, `getJobs`, `getMetrics` (uncached — default version), `pauseQueue/resumeQueue/cleanQueue`.

**Files to create:**

```
src/server/services/queue.service.ts
```

**Skeleton:**

```typescript
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { Job, JobsOptions, Queue, QueueOptions } from 'bullmq'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import type { BulkJob } from '../interfaces/queue-job-data.interface'
import type { JobStatus } from '../../shared/types/job-status.types'
import type { QueueMetrics } from '../../shared/types/queue-metrics.types'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name)
  private readonly queues = new Map<string, Queue>()

  constructor(
    private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly options: ResolvedQueueOptions,
  ) {}

  /**
   * Returns cached Queue or creates one with module defaults applied.
   * Subsequent calls with the same name return the same instance.
   */
  getOrCreateQueue<TData = unknown, TResult = unknown>(
    queueName: string,
    overrides?: Partial<Omit<QueueOptions, 'connection' | 'prefix'>>,
  ): Queue<TData, TResult> {
    const existing = this.queues.get(queueName)
    if (existing) return existing as Queue<TData, TResult>

    const queue = new Queue<TData, TResult>(queueName, {
      connection: this.connection.getClient(),
      prefix: this.options.prefix,
      defaultJobOptions: this.options.defaultJobOptions,
      ...this.options.queueOptions,
      ...overrides,
    })
    this.queues.set(queueName, queue as Queue)
    return queue
  }

  /**
   * Adds a job to the queue. `options` surfaces BullMQ natives directly — including
   * `jobId` (idempotent insert) and `deduplication` (Simple/Throttle/Debounce/keepLastIfActive);
   * no custom deduplication code lives in this lib (wired in Phase 3).
   */
  async enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    jobName: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<Job<TData, TResult, string>> {
    const queue = this.getOrCreateQueue<TData, TResult>(queueName)
    return queue.add(jobName, data, options)
  }

  async enqueueBulk<TData = unknown, TResult = unknown>(
    queueName: string,
    jobs: ReadonlyArray<BulkJob<TData>>,
  ): Promise<Array<Job<TData, TResult, string>>> {
    const queue = this.getOrCreateQueue<TData, TResult>(queueName)
    try {
      return await queue.addBulk(jobs as Array<BulkJob<TData>>)
    } catch (err) {
      throw new QueueException(QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED, 500, { cause: (err as Error).message })
    }
  }

  async getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult, string> | null> {
    const queue = this.getOrCreateQueue<TData, TResult>(queueName)
    return (await queue.getJob(jobId)) ?? null
  }

  async getJobs<TData = unknown, TResult = unknown>(
    queueName: string,
    status: JobStatus,
    start = 0,
    end = 50,
  ): Promise<Array<Job<TData, TResult, string>>> {
    const queue = this.getOrCreateQueue<TData, TResult>(queueName)
    return queue.getJobs([status], start, end) as Promise<Array<Job<TData, TResult, string>>>
  }

  /** Default (no-cache) implementation. MetricsService delegates here when metrics are enabled. */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    const queue = this.getOrCreateQueue(queueName)
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')
    return {
      queue: queueName,
      counts: counts as QueueMetrics['counts'],
      collectedAt: new Date().toISOString(),
    }
  }

  async pauseQueue(queueName: string): Promise<void> {
    await this.getOrCreateQueue(queueName).pause()
  }

  async resumeQueue(queueName: string): Promise<void> {
    await this.getOrCreateQueue(queueName).resume()
  }

  /**
   * Removes up to `limit` jobs older than `gracePeriodMs` in a given status.
   * Mirrors BullMQ `Queue.clean(grace, limit, type?)` exactly: `limit` is REQUIRED
   * and precedes the status (`0` means "no limit"). Returns the ids removed.
   */
  async cleanQueue(
    queueName: string,
    gracePeriodMs: number,
    limit: number,
    status?: 'completed' | 'failed' | 'delayed' | 'wait' | 'active' | 'paused',
  ): Promise<string[]> {
    return this.getOrCreateQueue(queueName).clean(gracePeriodMs, limit, status)
  }

  /** Internal — returns the cache for QueueLifecycle iteration on shutdown. */
  getCachedQueues(): ReadonlyMap<string, Queue> { return this.queues }

  async onModuleDestroy(): Promise<void> {
    // QueueLifecycle orchestrates the full shutdown sequence.
    // This hook is a safety net for ad-hoc usage without QueueLifecycle.
    for (const queue of this.queues.values()) {
      await queue.close().catch(() => undefined)
    }
    this.queues.clear()
  }
}
```

**Acceptance criteria:**

- [ ] `getOrCreateQueue` caches by name (second call returns the same instance)
- [ ] `enqueue<TData>` propagates typing to `Job<TData>`
- [ ] `enqueueBulk` batch failure → `QueueException(BULK_ENQUEUE_FAILED)` with `cause`
- [ ] `getJob` returns `null` when not found (does not throw)
- [ ] `getMetrics` returns shape `{ queue, counts, collectedAt }`
- [ ] `onModuleDestroy` closes all cached queues (does not throw on error)
- [ ] 100% line/branch coverage

**Validation commands:**

```bash
pnpm test src/server/services/queue.service.spec.ts
```

**Dependencies:** §2.3, §2.5, §2.6.

**Risks/Notes:**

- `Queue.getJobs(statuses)` accepts an array — pass `[status]` (not `status`).
- `Queue.clean(grace, limit, status)` returns the removed IDs.

### 2.8 Synchronous `BymaxQueueModule.forRoot()` + barrel export + tests + validation

**Goal:** Implement the dynamic module with `forRoot()` (async is deferred to Phase 4), expose providers `ConnectionResolver`, `QueueService`, `BYMAX_QUEUE_*` tokens; close the phase with full tests and validation.

**Files to create/modify:**

```
src/server/bymax-queue.module.ts
src/server/index.ts
src/server/services/queue.service.spec.ts
src/server/services/connection-resolver.service.spec.ts
src/server/config/validate-options.spec.ts
src/server/config/resolved-options.spec.ts
src/server/utils/validate-connection.spec.ts
src/server/bymax-queue.module.spec.ts
```

**Skeleton — `src/server/bymax-queue.module.ts`:**

```typescript
import { ConfigurableModuleBuilder, DynamicModule, Module, Provider } from '@nestjs/common'
import type { BymaxQueueModuleOptions } from './interfaces/queue-module-options.interface'
import { validateOptions } from './config/validate-options'
import { applyDefaults } from './config/resolved-options'
import {
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_RESOLVED_OPTIONS,
} from './bymax-queue.constants'
import { ConnectionResolver } from './services/connection-resolver.service'
import { QueueService } from './services/queue.service'

/**
 * Built on NestJS' ConfigurableModuleBuilder: it generates the typed forRoot()/forRootAsync()
 * class methods and the options token (MODULE_OPTIONS_TOKEN). `isGlobal` is mapped to
 * DynamicModule.global via setExtras — there is NO hand-written @Global decorator and NO forFeature stub.
 */
export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<BymaxQueueModuleOptions>({ moduleName: 'BymaxQueue' })
  .setClassMethodName('forRoot')
  .setExtras(
    { isGlobal: true },
    (definition, extras) => ({ ...definition, global: extras.isGlobal }),
  )
  .build()

@Module({})
export class BymaxQueueModule extends ConfigurableModuleClass {
  /**
   * Synchronous registration. Use when options are static. Extends the
   * ConfigurableModuleClass definition (which already carries `global` from setExtras)
   * with the lib's providers.
   *
   * @example
   *   BymaxQueueModule.forRoot({
   *     connection: { url: process.env.REDIS_URL! },
   *     defaultJobOptions: { attempts: 5 },
   *   })
   */
  static forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    validateOptions(options)
    const resolved = applyDefaults(options)
    const base = super.forRoot(options)

    const providers: Provider[] = [
      ...(base.providers ?? []),
      // Public options token aliased to the builder-generated MODULE_OPTIONS_TOKEN.
      { provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN },
      { provide: BYMAX_QUEUE_RESOLVED_OPTIONS, useValue: resolved },
      {
        provide: ConnectionResolver,
        useFactory: async (opts: BymaxQueueModuleOptions) => {
          const resolver = new ConnectionResolver(opts)
          await resolver.init()
          return resolver
        },
        inject: [BYMAX_QUEUE_OPTIONS],
      },
      QueueService,
    ]

    return {
      ...base,
      providers,
      exports: [QueueService, ConnectionResolver, BYMAX_QUEUE_OPTIONS, BYMAX_QUEUE_RESOLVED_OPTIONS],
    }
  }
}
```

**Skeleton — `src/server/index.ts`:**

```typescript
// Module
export { BymaxQueueModule } from './bymax-queue.module'

// Tokens
export {
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_REDIS_CLIENT,
  BYMAX_QUEUE_CONNECTION_MODE,
  BYMAX_QUEUE_RESOLVED_OPTIONS,
} from './bymax-queue.constants'

// Services
export { QueueService } from './services/queue.service'
export { ConnectionResolver } from './services/connection-resolver.service'

// Interfaces
export type {
  BymaxQueueModuleOptions,
  BymaxQueueModuleAsyncOptions,
  BymaxQueueOptionsFactory,
  QueueConnectionConfig,
  QueueConnectionMode,
  WorkerOptions,
  BulkJob,
  ProcessorMetadata,
  ProcessHandlerMetadata,
  QueueEventListenerMetadata,
} from './interfaces'

// Errors + constants
export { QueueException } from './errors/queue-exception'
export {
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_METRICS_CACHE_TTL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  QUEUE_ERROR_CODES,
} from './constants'

// BullMQ re-exports for convenience
export type { Job, JobsOptions, Queue, Worker, QueueEvents } from 'bullmq'

// Shared re-exports
export type { JobStatus, QueueMetrics, JobSchedulerRepeatOptions, QueueErrorCode } from '../shared'
export { JOB_STATUS } from '../shared'
```

**Test highlights — `connection-resolver.service.spec.ts`:**

```typescript
describe('ConnectionResolver', () => {
  it('should accept a Mode A client with maxRetriesPerRequest=null', async () => { /* ... */ })
  it('should throw CONNECTION_REQUIRES_NULL_RETRIES when client has retries=20', async () => { /* ... */ })
  it('should throw CONNECTION_INVALID when Mode A client status is "end"', async () => { /* ... */ })
  it('should open Mode B with URL and reach ready before timeout', async () => { /* ... */ })  // ioredis-mock
  it('should reject with CONNECTION_TIMEOUT when ready not reached', async () => { /* ... */ })
  it('should call quit() on Mode B in onModuleDestroy', async () => { /* ... */ })
  it('should NOT touch Mode A client on shutdown', async () => { /* ... */ })
})
```

**Test highlights — `queue.service.spec.ts`:** mock the `bullmq.Queue` factory, assert cache hit/miss, assert `enqueue` calls `queue.add(name, data, opts)`, assert bulk failure wraps to `QueueException`.

**Test highlights — `bymax-queue.module.spec.ts`:** assert `forRoot` registers `QueueService`, `ConnectionResolver`, tokens; assert the returned `DynamicModule.global === true` by default (and `false` when `isGlobal: false`, via `setExtras`); assert `forRoot({ connection: {} as never })` throws via validateOptions.

**Smoke test (manual):**

```javascript
// /tmp/smoke-phase1.mjs
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import { BymaxQueueModule, QueueService } from './dist/server/index.mjs'

@Module({
  imports: [BymaxQueueModule.forRoot({
    connection: { url: 'redis://localhost:6379' },
  })],
})
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule)
const queue = app.get(QueueService)
const job = await queue.enqueue('smoke', 'hello', { greet: 'world' })
console.log('enqueued', job.id)
console.log('metrics', await queue.getMetrics('smoke'))
await app.close()
```

**Acceptance criteria (full phase):**

- [ ] `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build` pass
- [ ] 100% line/branch coverage on every implemented file (`jest.coverage.config.ts` → `100/100/100/100`)
- [ ] The smoke test above connects to local Redis, enqueues a job, and reads metrics
- [ ] PR opened with label `phase-1`, `/bymax-quality:code-review` applied

**Validation commands (phase):**

```bash
pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm size
node /tmp/smoke-phase1.mjs  # requires local Redis
```

**Dependencies:** §2.1 to §2.7.

**Risks/Notes:**

- `ConnectionResolver` is an async factory (`useFactory` + `await resolver.init()`) — NestJS supports async providers natively.
- There is **no** `forFeature` — `QueueService` is an app-wide singleton (global by default) reaching every queue by name (spec §4.3 and §A.5).

---

## 3. Phase 2 — Workers (@Processor + WorkerRegistry)

> **Phase goal:** Enable job processing via decorators (`@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`) discovered automatically by NestJS `DiscoveryService`, and expose a programmatic API (`WorkerRegistry.register/registerSandboxed/unregister`) for dynamic and sandboxed (out-of-process, no DI) cases. Includes `concurrency` and `limiter` validation. By the end, a fixture can declare `@Processor('email')` with a `@Process()` handler and the job enqueued on `email` runs, and an `@OnWorkerEvent('progress')` listener observes `job.updateProgress()`.
>
> **Complexity:** MEDIUM.
>
> **Highest-blast-radius files (100% line/branch, like every implemented file):** `src/server/services/worker-registry.service.ts`, `src/server/decorators/processor.decorator.ts`, `src/server/decorators/process.decorator.ts`.

### 3.1 Decorators — `@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`

**Goal:** Create decorators that write metadata via `Reflect.defineMetadata` (Symbol keys) for `WorkerRegistry` to read during discovery. No execution logic — only marking.

**Files to create:**

```
src/server/decorators/
├── processor.decorator.ts
├── process.decorator.ts
├── on-worker-event.decorator.ts
├── on-queue-event.decorator.ts
└── metadata-keys.constants.ts
```

**Skeleton — `src/server/decorators/metadata-keys.constants.ts`:**

```typescript
/** Symbol metadata keys — never collide with user-defined metadata. */
export const PROCESSOR_METADATA_KEY = Symbol('bymax_queue:processor')
export const PROCESS_HANDLERS_METADATA_KEY = Symbol('bymax_queue:process_handlers')
export const WORKER_EVENT_LISTENERS_METADATA_KEY = Symbol('bymax_queue:worker_event_listeners')
export const QUEUE_EVENT_LISTENERS_METADATA_KEY = Symbol('bymax_queue:queue_event_listeners')
```

**Skeleton — `src/server/decorators/processor.decorator.ts`:**

```typescript
import 'reflect-metadata'
import type { WorkerOptions } from '../interfaces/worker-options.interface'
import type { ProcessorMetadata } from '../interfaces/processor-metadata.interface'
import { PROCESSOR_METADATA_KEY } from './metadata-keys.constants'
import { DEFAULT_WORKER_CONCURRENCY } from '../constants/default-options'

/**
 * Marks a class as a queue processor. The class is instantiated by NestJS DI,
 * so dependencies are injected normally.
 *
 * If `workerOptions.concurrency` is omitted, DEFAULT_WORKER_CONCURRENCY (2) is
 * used — but a runtime warning is logged to discourage silent serial execution.
 *
 * @example
 *   @Processor('email', { concurrency: 5, limiter: { max: 10, duration: 1000 } })
 *   export class EmailProcessor { ... }
 */
export function Processor(queueName: string, workerOptions: WorkerOptions = {}): ClassDecorator {
  return (target) => {
    const metadata: ProcessorMetadata = {
      queueName,
      workerOptions: { concurrency: DEFAULT_WORKER_CONCURRENCY, autorun: true, ...workerOptions },
    }
    Reflect.defineMetadata(PROCESSOR_METADATA_KEY, metadata, target)
  }
}
```

**Skeleton — `src/server/decorators/process.decorator.ts`:**

```typescript
import 'reflect-metadata'
import type { ProcessHandlerMetadata } from '../interfaces/processor-metadata.interface'
import { PROCESS_HANDLERS_METADATA_KEY } from './metadata-keys.constants'

/**
 * Marks a method as a job handler inside a @Processor class.
 *
 * - `@Process()` — catch-all (dispatched for every job in the queue)
 * - `@Process('jobName')` — only jobs whose `name` matches
 *
 * Multiple @Process methods are allowed. Dispatch order (worker time):
 *   1. Method with matching jobName (most specific)
 *   2. Catch-all fallback
 */
export function Process(jobName?: string): MethodDecorator {
  return (target, propertyKey) => {
    const existing: ProcessHandlerMetadata[] =
      Reflect.getMetadata(PROCESS_HANDLERS_METADATA_KEY, target.constructor) ?? []
    const entry: ProcessHandlerMetadata = { jobName, methodKey: propertyKey }
    Reflect.defineMetadata(PROCESS_HANDLERS_METADATA_KEY, [...existing, entry], target.constructor)
  }
}
```

**Skeleton — `src/server/decorators/on-worker-event.decorator.ts`:**

```typescript
import 'reflect-metadata'
import type { QueueEventListenerMetadata } from '../interfaces/processor-metadata.interface'
import { WORKER_EVENT_LISTENERS_METADATA_KEY } from './metadata-keys.constants'

/** Worker-local events — fired by THIS worker's process; the handler receives the full `Job`. */
export type WorkerEventName =
  | 'completed' | 'failed' | 'progress' | 'active' | 'stalled' | 'closing' | 'closed' | 'error'

/**
 * Marks a method as a worker-local event listener. No extra Redis connection is needed —
 * these fire on the Worker the @Processor already owns, so the handler gets the full `Job`
 * (`job.data`, timings, `attemptsMade`), unlike the global `@OnQueueEvent`. Use `'progress'`
 * to observe `job.updateProgress()`; use `'failed'` for the DLQ pattern when `attemptsMade >= attempts`.
 */
export function OnWorkerEvent(eventName: WorkerEventName): MethodDecorator {
  return (target, propertyKey) => {
    const existing: QueueEventListenerMetadata[] =
      Reflect.getMetadata(WORKER_EVENT_LISTENERS_METADATA_KEY, target.constructor) ?? []
    const entry: QueueEventListenerMetadata = { eventName, methodKey: propertyKey }
    Reflect.defineMetadata(WORKER_EVENT_LISTENERS_METADATA_KEY, [...existing, entry], target.constructor)
  }
}
```

**Skeleton — `src/server/decorators/on-queue-event.decorator.ts`:**

```typescript
import 'reflect-metadata'
import type { QueueEventListenerMetadata } from '../interfaces/processor-metadata.interface'
import { QUEUE_EVENT_LISTENERS_METADATA_KEY } from './metadata-keys.constants'

/** Canonical BullMQ QueueEvents event names. */
export type QueueEventName =
  | 'completed' | 'failed' | 'active' | 'progress' | 'stalled'
  | 'waiting' | 'delayed' | 'paused' | 'resumed' | 'cleaned'

/** Marks a method as a listener for a specific QueueEvents event of the parent @Processor's queue. */
export function OnQueueEvent(eventName: QueueEventName): MethodDecorator {
  return (target, propertyKey) => {
    const existing: QueueEventListenerMetadata[] =
      Reflect.getMetadata(QUEUE_EVENT_LISTENERS_METADATA_KEY, target.constructor) ?? []
    const entry: QueueEventListenerMetadata = { eventName, methodKey: propertyKey }
    Reflect.defineMetadata(QUEUE_EVENT_LISTENERS_METADATA_KEY, [...existing, entry], target.constructor)
  }
}
```

**Acceptance criteria:**

- [ ] `@Processor('foo', { concurrency: 3 })` writes metadata with `queueName: 'foo'`, `concurrency: 3`, `autorun: true` (default)
- [ ] `@Processor('foo')` without options applies `concurrency: DEFAULT_WORKER_CONCURRENCY`
- [ ] `@Process()` pushes an entry with `jobName: undefined`
- [ ] `@Process('send')` pushes with `jobName: 'send'`
- [ ] Multiple `@Process` on the same class accumulate (do not overwrite)
- [ ] `@OnWorkerEvent('progress')` pushes a worker-local listener (separate metadata key)
- [ ] `@OnQueueEvent('completed')` pushes a global listener
- [ ] 100% line/branch coverage (decorators are small)

**Validation commands:**

```bash
pnpm test src/server/decorators/
```

**Dependencies:** §2.3, §2.4.

**Risks/Notes:**

- `Reflect.getMetadata` returns `undefined` when absent — always default to `[]`.
- Event listeners are per class, **not** per queue — `WorkerRegistry` associates them to the `QueueEvents` of the parent `@Processor`'s queue.

### 3.2 WorkerRegistry — programmatic + lifecycle

**Goal:** Implement a service that creates/destroys BullMQ `Worker`s. Programmatic API `register/unregister/list`, with per-worker connection `duplicate()` and options validation.

**Files to create:**

```
src/server/services/worker-registry.service.ts
```

**Skeleton:**

```typescript
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { Job, Worker } from 'bullmq'
import type { WorkerOptions as BullWorkerOptions } from 'bullmq'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'
import type { WorkerOptions } from '../interfaces/worker-options.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { DEFAULT_WORKER_CONCURRENCY } from '../constants/default-options'

export interface ProgrammaticWorkerConfig<TData = unknown, TResult = unknown> {
  queueName: string
  handler: (job: Job<TData, TResult>) => Promise<TResult>
  options?: WorkerOptions
}

@Injectable()
export class WorkerRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerRegistry.name)
  private readonly workers = new Map<string, Worker>()

  constructor(private readonly connection: ConnectionResolver) {}

  /** Register a worker programmatically. */
  async register<TData = unknown, TResult = unknown>(
    config: ProgrammaticWorkerConfig<TData, TResult>,
  ): Promise<Worker<TData, TResult>> {
    if (this.workers.has(config.queueName)) {
      throw new QueueException(QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR, 500, { queueName: config.queueName })
    }

    this.validateOptions(config.options)

    const bullOpts: BullWorkerOptions = {
      connection: duplicateConnection(this.connection.getClient()),
      concurrency: config.options?.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
      ...(config.options?.limiter ? { limiter: config.options.limiter } : {}),
      ...(config.options?.lockDuration !== undefined ? { lockDuration: config.options.lockDuration } : {}),
      ...(config.options?.stalledInterval !== undefined ? { stalledInterval: config.options.stalledInterval } : {}),
      ...(config.options?.autorun !== undefined ? { autorun: config.options.autorun } : { autorun: true }),
    }

    try {
      const worker = new Worker<TData, TResult>(config.queueName, config.handler, bullOpts)
      this.workers.set(config.queueName, worker as Worker)
      return worker
    } catch (err) {
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, { cause: (err as Error).message })
    }
  }

  /**
   * Registers a file-based, out-of-process (sandboxed) worker. The processor is a FILE PATH/URL
   * to a built `.js`/`.cjs`/`.mjs` artifact — it runs in a separate process (or worker thread when
   * `useWorkerThreads` is set) and has NO NestJS DI; pass everything it needs via `job.data` (§6.8).
   */
  async registerSandboxed(config: {
    queueName: string
    processorFile: string | URL
    options?: WorkerOptions & { useWorkerThreads?: boolean }
  }): Promise<Worker> {
    if (this.workers.has(config.queueName)) {
      throw new QueueException(QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR, 500, { queueName: config.queueName })
    }
    this.validateOptions(config.options)
    const bullOpts: BullWorkerOptions = {
      connection: duplicateConnection(this.connection.getClient()),
      concurrency: config.options?.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
      ...(config.options?.useWorkerThreads !== undefined ? { useWorkerThreads: config.options.useWorkerThreads } : {}),
    }
    try {
      // BullMQ treats a file path/URL (not a function) as a sandboxed processor.
      const worker = new Worker(config.queueName, config.processorFile, bullOpts)
      this.workers.set(config.queueName, worker)
      return worker
    } catch (err) {
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, { cause: (err as Error).message })
    }
  }

  async unregister(queueName: string): Promise<void> {
    const worker = this.workers.get(queueName)
    if (!worker) return
    await worker.close()
    this.workers.delete(queueName)
  }

  list(): readonly string[] {
    return Array.from(this.workers.keys())
  }

  /** Internal — used by QueueLifecycle to iterate during shutdown. */
  getAll(): ReadonlyMap<string, Worker> { return this.workers }

  async onModuleDestroy(): Promise<void> {
    // Full graceful shutdown is orchestrated by QueueLifecycle.
    // Best-effort fallback here.
    for (const [name, worker] of this.workers) {
      await worker.close().catch(() => this.logger.warn(`failed to close worker ${name}`))
    }
    this.workers.clear()
  }

  private validateOptions(opts?: WorkerOptions): void {
    if (!opts) return
    if (opts.concurrency !== undefined && opts.concurrency < 1) {
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, { reason: 'concurrency must be >= 1' })
    }
    if (opts.limiter && (opts.limiter.max < 1 || opts.limiter.duration < 1)) {
      throw new QueueException(QUEUE_ERROR_CODES.WORKER_REGISTRATION_FAILED, 500, { reason: 'limiter.max and limiter.duration must be >= 1' })
    }
  }
}
```

**Acceptance criteria:**

- [ ] `register` creates a worker and stores it in the Map
- [ ] `register` twice on the same queue → `DUPLICATE_PROCESSOR`
- [ ] `concurrency: 0` → `WORKER_REGISTRATION_FAILED` with `reason`
- [ ] `limiter: { max: 0, duration: 1000 }` → error
- [ ] `unregister` calls `close()` and removes from the Map
- [ ] `list()` returns names
- [ ] `registerSandboxed` creates a file-based worker (processor = path/URL); duplicate queue → `DUPLICATE_PROCESSOR`
- [ ] `onModuleDestroy` closes all without throwing
- [ ] 100% line/branch coverage

**Validation commands:**

```bash
pnpm test src/server/services/worker-registry.service.spec.ts
```

**Dependencies:** §2.5, §3.1.

**Risks/Notes:**

- Each `Worker` uses connection `duplicate()` — BullMQ requirement for blocking commands (`BRPOPLPUSH`/`BZPOPMIN`/`BLMOVE`).
- `autorun: true` by default — the worker starts pulling jobs as soon as it is registered.
- Sandboxed processors run out-of-process with no DI — the processor file must be a built artifact reachable at runtime (account for it in `tsup`/`dist`).

### 3.3 Discovery — wire decorators to WorkerRegistry

**Goal:** Service `ProcessorDiscoveryService` that, in `onModuleInit`, scans the app's providers via `DiscoveryService` from `@nestjs/core`, finds classes with `PROCESSOR_METADATA_KEY` metadata, and registers workers + listeners.

**Files to create:**

```
src/server/services/processor-discovery.service.ts
src/server/services/queue-events-registry.service.ts
```

**Skeleton — `src/server/services/queue-events-registry.service.ts`:**

```typescript
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { QueueEvents } from 'bullmq'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'

@Injectable()
export class QueueEventsRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(QueueEventsRegistry.name)
  private readonly events = new Map<string, QueueEvents>()

  constructor(private readonly connection: ConnectionResolver) {}

  /** Lazily creates a QueueEvents per queue. */
  getOrCreate(queueName: string): QueueEvents {
    const existing = this.events.get(queueName)
    if (existing) return existing
    const qe = new QueueEvents(queueName, { connection: duplicateConnection(this.connection.getClient()) })
    this.events.set(queueName, qe)
    return qe
  }

  list(): readonly string[] { return Array.from(this.events.keys()) }
  getAll(): ReadonlyMap<string, QueueEvents> { return this.events }

  async onModuleDestroy(): Promise<void> {
    for (const [name, qe] of this.events) {
      await qe.close().catch(() => this.logger.warn(`failed to close QueueEvents ${name}`))
    }
    this.events.clear()
  }
}
```

**Skeleton — `src/server/services/processor-discovery.service.ts`:**

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { DiscoveryService, MetadataScanner } from '@nestjs/core'
import { Job } from 'bullmq'
import { WorkerRegistry } from './worker-registry.service'
import { QueueEventsRegistry } from './queue-events-registry.service'
import {
  PROCESSOR_METADATA_KEY,
  PROCESS_HANDLERS_METADATA_KEY,
  WORKER_EVENT_LISTENERS_METADATA_KEY,
  QUEUE_EVENT_LISTENERS_METADATA_KEY,
} from '../decorators/metadata-keys.constants'
import type {
  ProcessorMetadata,
  ProcessHandlerMetadata,
  QueueEventListenerMetadata,
} from '../interfaces/processor-metadata.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

@Injectable()
export class ProcessorDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(ProcessorDiscoveryService.name)
  private readonly registeredQueues = new Set<string>()

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly workers: WorkerRegistry,
    private readonly events: QueueEventsRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const providers = this.discovery.getProviders()
    for (const wrapper of providers) {
      const instance = wrapper.instance
      if (!instance || typeof instance !== 'object') continue
      const target = instance.constructor
      const processorMeta: ProcessorMetadata | undefined = Reflect.getMetadata(PROCESSOR_METADATA_KEY, target)
      if (!processorMeta) continue

      if (this.registeredQueues.has(processorMeta.queueName)) {
        throw new QueueException(QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR, 500, { queueName: processorMeta.queueName })
      }
      this.registeredQueues.add(processorMeta.queueName)

      const handlers: ProcessHandlerMetadata[] =
        Reflect.getMetadata(PROCESS_HANDLERS_METADATA_KEY, target) ?? []
      const workerListeners: QueueEventListenerMetadata[] =
        Reflect.getMetadata(WORKER_EVENT_LISTENERS_METADATA_KEY, target) ?? []
      const queueListeners: QueueEventListenerMetadata[] =
        Reflect.getMetadata(QUEUE_EVENT_LISTENERS_METADATA_KEY, target) ?? []

      // Build dispatcher: jobName-specific first, then catch-all.
      const dispatcher = this.buildDispatcher(instance as Record<string | symbol, unknown>, handlers)

      const worker = await this.workers.register({
        queueName: processorMeta.queueName,
        handler: dispatcher,
        options: processorMeta.workerOptions,
      })

      // Worker-local listeners (@OnWorkerEvent) bind to the Worker — full Job, no extra connection.
      const bind = (instance as Record<string | symbol, unknown>)
      for (const { eventName, methodKey } of workerListeners) {
        const fn = bind[methodKey]
        if (typeof fn === 'function') {
          worker.on(eventName as never, (fn as (...args: unknown[]) => unknown).bind(instance) as never)
        }
      }

      // Global listeners (@OnQueueEvent) bind to a lazily-created QueueEvents — ids + serialized payload.
      if (queueListeners.length > 0) {
        const qe = this.events.getOrCreate(processorMeta.queueName)
        for (const { eventName, methodKey } of queueListeners) {
          const fn = bind[methodKey]
          if (typeof fn === 'function') {
            qe.on(eventName as never, (fn as (...args: unknown[]) => unknown).bind(instance))
          }
        }
      }
    }
  }

  private buildDispatcher(
    instance: Record<string | symbol, unknown>,
    handlers: ProcessHandlerMetadata[],
  ): (job: Job) => Promise<unknown> {
    const byName = new Map<string, ProcessHandlerMetadata>()
    let catchAll: ProcessHandlerMetadata | undefined
    for (const h of handlers) {
      if (h.jobName === undefined) catchAll = h
      else byName.set(h.jobName, h)
    }
    return async (job: Job): Promise<unknown> => {
      const specific = byName.get(job.name)
      const handler = specific ?? catchAll
      if (!handler) throw new Error(`No @Process handler matches job "${job.name}"`)
      const fn = instance[handler.methodKey] as (j: Job) => Promise<unknown>
      return fn.call(instance, job)
    }
  }
}
```

**Acceptance criteria:**

- [ ] A class `@Processor('email')` + `@Process()` is discovered on `onModuleInit`
- [ ] A worker is registered and processes real jobs (via BullMQ mock in unit; real in e2e)
- [ ] Multiple classes `@Processor('email')` → `DUPLICATE_PROCESSOR`
- [ ] `@Process('send')` is called for `job.name === 'send'`; `@Process()` (catch-all) for the rest
- [ ] `@OnWorkerEvent('completed'|'progress')` is bound to the `Worker` and receives the full `Job`
- [ ] `@OnQueueEvent('completed')` is bound to the corresponding `QueueEvents`
- [ ] 100% line/branch coverage (focus on `buildDispatcher` and discovery branches)

**Validation commands:**

```bash
pnpm test src/server/services/processor-discovery.service.spec.ts
pnpm test src/server/services/queue-events-registry.service.spec.ts
```

**Dependencies:** §3.1, §3.2.

**Risks/Notes:**

- `DiscoveryService` returns **all** providers in the Nest context (including internals) — filtering by metadata presence is the only robust approach.
- `QueueEvents` listeners receive `(jobId, returnvalue|error)` — signature on the consumer side is their responsibility; the lib just does `qe.on(eventName, fn)`.

### 3.4 Register discovery + WorkerRegistry in the module

**Goal:** Add `DiscoveryModule` import, `WorkerRegistry`, `QueueEventsRegistry`, `ProcessorDiscoveryService` to providers/exports of `BymaxQueueModule`.

**Files to modify:**

```
src/server/bymax-queue.module.ts
src/server/index.ts
```

**Change — `bymax-queue.module.ts`:**

```typescript
import { DiscoveryModule } from '@nestjs/core'
import { WorkerRegistry } from './services/worker-registry.service'
import { QueueEventsRegistry } from './services/queue-events-registry.service'
import { ProcessorDiscoveryService } from './services/processor-discovery.service'

// Inside forRoot, extend the definition (`...base` already carries `global` from setExtras):
return {
  ...base,
  imports: [DiscoveryModule],
  providers: [
    ...providers,   // existing providers assembled above
    WorkerRegistry,
    QueueEventsRegistry,
    ProcessorDiscoveryService,
  ],
  exports: [
    // ...existing exports
    WorkerRegistry,
    QueueEventsRegistry,
  ],
}
```

**Change — `src/server/index.ts`:** add exports.

```typescript
export { WorkerRegistry } from './services/worker-registry.service'
export type { ProgrammaticWorkerConfig } from './services/worker-registry.service'
export { QueueEventsRegistry } from './services/queue-events-registry.service'
export { Processor } from './decorators/processor.decorator'
export { Process } from './decorators/process.decorator'
export { OnWorkerEvent } from './decorators/on-worker-event.decorator'
export type { WorkerEventName } from './decorators/on-worker-event.decorator'
export { OnQueueEvent } from './decorators/on-queue-event.decorator'
export type { QueueEventName } from './decorators/on-queue-event.decorator'
```

**Acceptance criteria:**

- [ ] A fixture app with `@Processor` is discovered and a worker is registered
- [ ] `WorkerRegistry` is injectable in the consumer's providers (exposes `register`/`registerSandboxed`/`unregister`/`list`)

### 3.5 Concurrency/limiter warning + tests

**Goal:** Add an explicit warning when `@Processor` is declared **without** `concurrency` in `workerOptions`, and cover that path in tests.

**Files to modify:**

```
src/server/decorators/processor.decorator.ts   # add Logger-warn logic in metadata register
```

Implementation: in the decorator function, if `workerOptions.concurrency` is `undefined`, attach the flag `_warnedNoConcurrency: true` to the metadata. `ProcessorDiscoveryService` reads the flag and logs `Logger.warn` during discovery. This avoids side effects in the decorator (which runs at import time).

**Acceptance criteria:**

- [ ] `@Processor('q')` without options generates `Logger.warn` during discovery
- [ ] `@Processor('q', { concurrency: 5 })` does **not** generate a warning
- [ ] Warning includes `queueName` and a mental link: "Defaulting to concurrency=2"

**Risks/Notes:**

- Do not use `console.warn` directly — use the Nest `Logger` to respect the host app's log configuration.

### 3.6 Phase 2 tests

**Files to create:**

```
src/server/decorators/processor.decorator.spec.ts
src/server/decorators/process.decorator.spec.ts
src/server/decorators/on-worker-event.decorator.spec.ts
src/server/decorators/on-queue-event.decorator.spec.ts
src/server/services/worker-registry.service.spec.ts
src/server/services/processor-discovery.service.spec.ts
src/server/services/queue-events-registry.service.spec.ts
```

**Critical cases:**

- **Processor decorator**: metadata written, defaults applied, options override merged.
- **Process decorator**: multiple calls accumulate, optional `jobName` preserved.
- **OnWorkerEvent decorator**: multiple events on one class accumulate under the worker-local metadata key.
- **OnQueueEvent decorator**: multiple events on one class accumulate.
- **WorkerRegistry**: register/registerSandboxed/unregister/list; duplicate failures; `concurrency >= 1` validation.
- **ProcessorDiscoveryService**: integration with mock `DiscoveryService` (`getProviders()` returns 1+ wrapper whose instance carries metadata); worker-local listeners bind to the Worker, global listeners to QueueEvents.
- **QueueEventsRegistry**: idempotency (a second `getOrCreate` returns the same instance); `onModuleDestroy` closes all.

**Acceptance criteria:**

- [ ] 100% line/branch coverage on decorators and registries
- [ ] 100% line/branch coverage on every file implemented in this phase
- [ ] Mutation score ≥ 95% on critical paths (pre-release gate, Stryker `break 95`; optionally run `pnpm mutation --files src/server/services/processor-discovery.service.ts`)

**Validation commands:**

```bash
pnpm test:cov
```

### 3.7 Phase 2 validation

**Extended smoke test:**

```javascript
// /tmp/smoke-phase2.mjs
import { NestFactory } from '@nestjs/core'
import { Module, Injectable } from '@nestjs/common'
import { BymaxQueueModule, QueueService, Processor, Process, OnQueueEvent } from './dist/server/index.mjs'

@Injectable()
@Processor('demo', { concurrency: 3 })
class DemoProcessor {
  @Process()
  async handle(job) {
    return { echoed: job.data }
  }
  @OnQueueEvent('completed')
  onDone(jobId, returnValue) {
    console.log('completed', jobId, returnValue)
  }
}

@Module({
  imports: [BymaxQueueModule.forRoot({ connection: { url: 'redis://localhost:6379' } })],
  providers: [DemoProcessor],
})
class App {}

const ctx = await NestFactory.createApplicationContext(App)
const q = ctx.get(QueueService)
await q.enqueue('demo', 'echo', { hi: 'there' })
await new Promise(r => setTimeout(r, 1000))  // give worker time
await ctx.close()
```

**Done criteria:**

- [ ] `pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build` pass
- [ ] Smoke test shows `completed jobId { echoed: { hi: 'there' } }`
- [ ] PR `phase-2` with `/bymax-quality:code-review` applied

**Dependencies:** §3.1 to §3.6.

---

## 4. Phase 3 — Flows + Job Schedulers + Metrics + Health

> **Phase goal:** Add opt-in features — `FlowService` (FlowProducer wrapper, activated by `options.flows.enabled`), Job Schedulers (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`) on `QueueService`, native `deduplication` options surfaced on `enqueue`, optional `telemetry` (OpenTelemetry) attached to every Queue/Worker, `MetricsService` with TTL cache (activated by `options.metrics.enabled`), and document the health-check pattern. By the end you can compose hierarchical flows, schedule recurring jobs, deduplicate enqueues, and read cached metrics.
>
> **Complexity:** MEDIUM.
>
> **Highest-blast-radius files (100% line/branch, like every implemented file):** `src/server/services/flow.service.ts`, `src/server/services/metrics.service.ts`, the Job Scheduler methods (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`) in `QueueService`.

### 4.1 FlowService — opt-in FlowProducer wrapper

**Goal:** Create `FlowService` encapsulating the BullMQ `FlowProducer`. Registered **only** if `options.flows.enabled === true`. When disabled but referenced, throw `QueueException(FLOW_DISABLED)`.

**Files to create:**

```
src/server/services/flow.service.ts
```

**Skeleton:**

```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { FlowJob, FlowProducer, JobNode } from 'bullmq'
import { ConnectionResolver } from './connection-resolver.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

@Injectable()
export class FlowService implements OnModuleDestroy {
  private producer!: FlowProducer
  private readonly enabled: boolean

  constructor(connection: ConnectionResolver, enabled: boolean) {
    this.enabled = enabled
    if (this.enabled) {
      this.producer = new FlowProducer({ connection: connection.getClient() })
    }
  }

  /** Add a flow tree. The root job runs after all descendants complete successfully. */
  async add<TData = unknown>(flow: FlowJob): Promise<JobNode> {
    this.ensureEnabled()
    return this.producer.add(flow)
  }

  /** Bulk add — single Redis roundtrip. */
  async addBulk(flows: ReadonlyArray<FlowJob>): Promise<JobNode[]> {
    this.ensureEnabled()
    return this.producer.addBulk(flows as FlowJob[])
  }

  /** Escape hatch — returns the underlying FlowProducer. */
  getProducer(): FlowProducer {
    this.ensureEnabled()
    return this.producer
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled && this.producer) {
      await this.producer.close().catch(() => undefined)
    }
  }

  private ensureEnabled(): void {
    if (!this.enabled) {
      throw new QueueException(QUEUE_ERROR_CODES.FLOW_DISABLED, 503)
    }
  }
}
```

**Registration in `BymaxQueueModule.forRoot`:**

```typescript
// Conditional provider — register always but with a guard that throws when disabled.
providers.push({
  provide: FlowService,
  useFactory: (conn: ConnectionResolver) => new FlowService(conn, resolved.flows.enabled),
  inject: [ConnectionResolver],
})
```

> **Decision:** always register `FlowService` (not conditional) to avoid `UnknownDependenciesException` when the consumer injects it without enabling. The `ensureEnabled()` guard throws `FLOW_DISABLED` (503) with a clear message.

**Acceptance criteria:**

- [ ] `FlowService` enabled (enabled=true): `add` calls `producer.add(flow)`; `addBulk` calls `addBulk`
- [ ] Disabled (enabled=false): any method throws `FLOW_DISABLED`
- [ ] `onModuleDestroy` closes the `producer` when active (no-op when inactive)
- [ ] 100% line/branch coverage

**Validation commands:**

```bash
pnpm test src/server/services/flow.service.spec.ts
```

**Dependencies:** §2.5.

### 4.2 Job Schedulers — `upsertJobScheduler` + `removeJobScheduler` + `getJobSchedulers` in QueueService

**Goal:** Add the current BullMQ Job Schedulers methods to `QueueService` (cron and interval). The legacy `addRepeatable`/`removeRepeatable` API is **deprecated and removed in BullMQ v6**, so it never appears on the public surface. Validate the exclusivity of the `JobSchedulerRepeatOptions` union and parse cron with `cron-parser` (never a regex).

**Files to modify/create:**

```
src/server/services/queue.service.ts
src/server/utils/validate-repeat-options.ts  # new — parses cron with cron-parser
```

**Skeleton — `src/server/utils/validate-repeat-options.ts`:**

```typescript
import { CronExpressionParser } from 'cron-parser'
import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/**
 * Validates a Job Scheduler schedule before delegating to BullMQ. Cron patterns are parsed
 * with `cron-parser` (which accepts both 5-field and 6-field/seconds expressions) — never a
 * hand-rolled regex, which is both incorrect for 6-field patterns and a ReDoS risk.
 * @throws QueueException(INVALID_REPEAT_OPTIONS, 400) when invalid
 */
export function validateRepeatOptions(repeat: JobSchedulerRepeatOptions): void {
  const hasPattern = 'pattern' in repeat
  const hasEvery = 'every' in repeat
  if (hasPattern === hasEvery) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, 400, { reason: 'exactly one of pattern | every is required' })
  }
  if (hasPattern) {
    try {
      CronExpressionParser.parse(repeat.pattern, repeat.tz ? { tz: repeat.tz } : {})
    } catch {
      throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, 400, { reason: 'pattern must be a valid cron expression (5- or 6-field)' })
    }
  } else if (repeat.every <= 0) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, 400, { reason: 'every must be > 0' })
  }
  // BullMQ itself rejects a past endDate — surface it early when present.
  if (repeat.endDate !== undefined && new Date(repeat.endDate).getTime() <= Date.now()) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS, 400, { reason: 'endDate must be in the future' })
  }
}
```

**Skeleton — additions to `QueueService`** (add `import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'`):

```typescript
/**
 * Creates or updates a Job Scheduler. Idempotent by `schedulerId` (BullMQ performs an atomic
 * `override: true` upsert), so re-registering on every boot is safe and never duplicates the
 * scheduler. Supersedes the deprecated `addRepeatable` API (removed in BullMQ v6).
 * @returns The first scheduled (delayed) Job, or undefined.
 */
async upsertJobScheduler<TData = unknown, TResult = unknown>(
  queueName: string,
  schedulerId: string,
  repeat: JobSchedulerRepeatOptions,
  template?: { name?: string; data?: TData; opts?: JobsOptions },
): Promise<Job<TData, TResult, string> | undefined> {
  validateRepeatOptions(repeat)
  const queue = this.getOrCreateQueue<TData, TResult>(queueName)
  return queue.upsertJobScheduler(schedulerId, repeat, {
    name: template?.name ?? schedulerId,
    data: (template?.data ?? {}) as TData,
    opts: template?.opts,
  })
}

/** Removes a scheduler by id. Returns true if one was removed. */
async removeJobScheduler(queueName: string, schedulerId: string): Promise<boolean> {
  return this.getOrCreateQueue(queueName).removeJobScheduler(schedulerId)
}

/** Lists schedulers for a queue (paginated), for inspection/health. */
async getJobSchedulers(
  queueName: string,
  start = 0,
  end = 50,
  asc = true,
): Promise<Awaited<ReturnType<Queue['getJobSchedulers']>>> {
  return this.getOrCreateQueue(queueName).getJobSchedulers(start, end, asc)
}
```

**Acceptance criteria:**

- [ ] `upsertJobScheduler` with a valid 5-field cron creates a recurring scheduler
- [ ] `upsertJobScheduler` with a 6-field (seconds) cron is accepted
- [ ] `upsertJobScheduler` with `every: 5000` creates an interval scheduler
- [ ] Calling `upsertJobScheduler` twice with the same `schedulerId` is idempotent (updates in place, no duplicate)
- [ ] Invalid cron → `INVALID_REPEAT_OPTIONS` with `reason` (validated via `cron-parser`, not a regex)
- [ ] both `pattern` and `every`, or neither → error; `every <= 0` → error; past `endDate` → error
- [ ] `removeJobScheduler` returns `true` for an existing scheduler, `false` otherwise
- [ ] `getJobSchedulers` returns the registered schedulers
- [ ] 100% line/branch coverage in `validate-repeat-options` and the new QueueService methods

**Validation commands:**

```bash
pnpm test src/server/utils/validate-repeat-options.spec.ts
pnpm test src/server/services/queue.service.spec.ts  # new cases
```

**Dependencies:** §2.7.

**Risks/Notes:**

- Cron is validated with `cron-parser` (BullMQ's own cron engine; `CronExpressionParser.parse(...)` in v5) — confirm the exact import against the installed version (official docs first), and pin it as a direct dependency if you do not rely on the transitive copy.
- The lib never exposes the legacy `addRepeatable`/`removeRepeatable` surface; building exclusively on Job Schedulers keeps it forward-compatible with BullMQ v6 (see §6.5).

### 4.3 MetricsService — cached getJobCounts

**Goal:** Implement a service with in-memory TTL cache. When registered and `enabled=true`, intercepts `getMetrics` calls from `QueueService` (via factory override in the module).

**Files to create:**

```
src/server/services/metrics.service.ts
```

**Skeleton:**

```typescript
import { Injectable } from '@nestjs/common'
import type { QueueMetrics } from '../../shared/types/queue-metrics.types'
import { QueueService } from './queue.service'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

interface CacheEntry { metrics: QueueMetrics; expiresAt: number }

@Injectable()
export class MetricsService {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly queueService: QueueService,
    private readonly enabled: boolean,
    private readonly ttlMs: number,
  ) {}

  /** Returns cached metrics or fetches fresh (and caches) on miss/expiry. */
  async get(queueName: string): Promise<QueueMetrics> {
    this.ensureEnabled()
    const now = Date.now()
    const cached = this.cache.get(queueName)
    if (cached && cached.expiresAt > now) return cached.metrics
    const metrics = await this.queueService.getMetrics(queueName)
    this.cache.set(queueName, { metrics, expiresAt: now + this.ttlMs })
    return metrics
  }

  /** Aggregate snapshot across all queues currently cached in QueueService. */
  async getAll(): Promise<readonly QueueMetrics[]> {
    this.ensureEnabled()
    const names = Array.from(this.queueService.getCachedQueues().keys())
    return Promise.all(names.map((n) => this.get(n)))
  }

  /** Force cache invalidation for `queueName` (or all if omitted). */
  invalidate(queueName?: string): void {
    if (queueName) this.cache.delete(queueName)
    else this.cache.clear()
  }

  private ensureEnabled(): void {
    if (!this.enabled) throw new QueueException(QUEUE_ERROR_CODES.METRICS_DISABLED, 503)
  }
}
```

**Module registration:**

```typescript
providers.push({
  provide: MetricsService,
  useFactory: (qs: QueueService) => new MetricsService(qs, resolved.metrics.enabled, resolved.metrics.cacheTtlMs),
  inject: [QueueService],
})
exports.push(MetricsService)
```

**Acceptance criteria:**

- [ ] `get(queueName)` cache miss → calls `QueueService.getMetrics`, stores with `expiresAt = now + ttl`
- [ ] `get(queueName)` cache hit → returns without calling QueueService
- [ ] After `ttlMs`, the next call performs a fresh fetch
- [ ] `invalidate(name)` removes only that entry; `invalidate()` clears everything
- [ ] Disabled (enabled=false) → every operation throws `METRICS_DISABLED`
- [ ] 100% coverage

**Validation commands:**

```bash
pnpm test src/server/services/metrics.service.spec.ts
```

**Dependencies:** §2.7.

**Risks/Notes:**

- Use `jest.useFakeTimers()` to validate expiry without real `setTimeout`.
- Cache is `Map<string, ...>` — no size cap (fine for apps with dozens of queues; document as a limitation if it becomes an issue).

### 4.4 Health check pattern — documentation

**Goal:** Document (in the future `README.md` and `MetricsService` JSDoc) the `HealthIndicator` pattern from `@nestjs/terminus` using `MetricsService.getAll()`. Do not bundle terminus as a dep.

**Files to modify:**

```
src/server/services/metrics.service.ts   # JSDoc @example with HealthIndicator
```

**Snippet to include in JSDoc:**

```typescript
/**
 * @example Health check pattern (consumer side)
 *   @Injectable()
 *   class QueueHealthIndicator extends HealthIndicator {
 *     constructor(private readonly metrics: MetricsService) { super() }
 *     async isHealthy(key: string): Promise<HealthIndicatorResult> {
 *       const all = await this.metrics.getAll()
 *       const stuck = all.filter(m => m.counts.active > 100 || m.counts.failed > 1000)
 *       return this.getStatus(key, stuck.length === 0, { stuck: stuck.map(m => m.queue) })
 *     }
 *   }
 */
```

**Acceptance criteria:**

- [ ] `MetricsService` JSDoc includes an `@example` documenting the pattern
- [ ] README (Phase 5) references this section

### 4.5 Deduplication, telemetry, index + tests + validation

**Deduplication (native, no custom code):** `enqueue` already forwards the BullMQ `deduplication` option (Simple `{ id }`, Throttle `{ id, ttl }`, Debounce `{ id, ttl, extend: true, replace: true }`, keep-last-if-active `{ id, keepLastIfActive: true }`). This sub-step adds tests proving each mode collapses duplicates; the deduplication key is independent of `jobId`.

**Telemetry (opt-in OpenTelemetry):** when `options.telemetry` is set, the module passes it to every `Queue`/`Worker`/`FlowProducer` it constructs (read from `ResolvedQueueOptions.telemetry`), so spans propagate from `enqueue` into the handler. `bullmq-otel` is an **optional** peer dependency — only required when telemetry is configured.

**Files to modify:**

```
src/server/index.ts                                    # export FlowService, MetricsService
src/server/services/queue.service.ts                   # pass telemetry into Queue construction
src/server/services/flow.service.spec.ts
src/server/services/metrics.service.spec.ts
src/server/utils/validate-repeat-options.spec.ts
src/server/services/queue.service.spec.ts              # deduplication + telemetry passthrough cases
```

**Smoke test:**

```javascript
// Cron Job Scheduler + metrics (idempotent by schedulerId)
await queue.upsertJobScheduler('cleanup', 'nightly', { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' }, { name: 'cleanup', data: { mode: 'soft' } })
const metrics = await ctx.get(MetricsService).get('cleanup')
console.log(metrics)
// {queue:'cleanup', counts:{...}, collectedAt:'2026-...'}
```

**Done criteria:**

- [ ] `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build` pass
- [ ] 100% line/branch coverage on every implemented file (`jest.coverage.config.ts` → `100/100/100/100`)
- [ ] Deduplication modes and telemetry passthrough are covered by tests
- [ ] PR `phase-3` with `/bymax-quality:code-review` applied

**Dependencies:** §4.1 to §4.4.

### 4.6 Phase 3 validation

```bash
pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm size
```

Verify:
- `dist/server/index.mjs` exports `FlowService`, `MetricsService`
- Bundle still ≤ 18 KiB brotli

---

## 5. Phase 4 — forRootAsync + E2E + Mutation Baseline + Graceful Shutdown

> **Phase goal:** Add `forRootAsync()` for factory-based configuration (required for canonical `nest-cache` integration), implement `QueueLifecycle` covering the shutdown protocol from spec §10.2 (drain → close workers → close events → close queues → optional Redis disconnect), build an E2E suite with **Testcontainers Redis** validating end-to-end scenarios (enqueue → process → completed; graceful shutdown; 3-level flow; repeatable; exponential retry), and generate a mutation testing baseline.
>
> **Complexity:** HIGH — interactions between lifecycle hooks, race conditions in shutdown, isolation of E2E specs, and Testcontainers fixtures.
>
> **Highest-blast-radius files (100% line/branch, like every implemented file):** `src/server/lifecycle/queue-lifecycle.service.ts`, `src/server/bymax-queue.module.ts` (forRootAsync), `src/server/services/connection-resolver.service.ts` (await ready paths).

### 5.1 `forRootAsync()` implementation

**Goal:** Add support for `useFactory`, `useClass`, `useExisting`, `inject` in `BymaxQueueModule`. Official NestJS pattern.

**Files to modify:**

```
src/server/bymax-queue.module.ts
```

**Skeleton — additions:**

```typescript
// forRootAsync is generated by ConfigurableModuleClass: it already builds the async options
// provider (useFactory | useClass | useExisting) under MODULE_OPTIONS_TOKEN and applies `global`
// from setExtras. We extend it with the lib's providers, deriving resolved options from the
// async-resolved options. There is no hand-rolled options-provider builder.
static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
  const base = super.forRootAsync(options)

  // Resolved options provider — derives from the async-resolved options.
  const resolvedProvider: Provider = {
    provide: BYMAX_QUEUE_RESOLVED_OPTIONS,
    useFactory: (opts: BymaxQueueModuleOptions) => {
      validateOptions(opts)
      return applyDefaults(opts)
    },
    inject: [MODULE_OPTIONS_TOKEN],
  }

  const connectionProvider: Provider = {
    provide: ConnectionResolver,
    useFactory: async (opts: BymaxQueueModuleOptions) => {
      const r = new ConnectionResolver(opts)
      await r.init()
      return r
    },
    inject: [MODULE_OPTIONS_TOKEN],
  }

  // FlowService and MetricsService are resolved-options aware factories.
  const flowProvider: Provider = {
    provide: FlowService,
    useFactory: (conn: ConnectionResolver, resolved: ResolvedQueueOptions) =>
      new FlowService(conn, resolved.flows.enabled),
    inject: [ConnectionResolver, BYMAX_QUEUE_RESOLVED_OPTIONS],
  }
  const metricsProvider: Provider = {
    provide: MetricsService,
    useFactory: (qs: QueueService, resolved: ResolvedQueueOptions) =>
      new MetricsService(qs, resolved.metrics.enabled, resolved.metrics.cacheTtlMs),
    inject: [QueueService, BYMAX_QUEUE_RESOLVED_OPTIONS],
  }

  return {
    ...base,
    imports: [DiscoveryModule, ...(base.imports ?? [])],
    providers: [
      ...(base.providers ?? []),
      { provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN },
      resolvedProvider,
      connectionProvider,
      QueueService,
      WorkerRegistry,
      QueueEventsRegistry,
      ProcessorDiscoveryService,
      flowProvider,
      metricsProvider,
      QueueLifecycle,
    ],
    exports: [QueueService, FlowService, MetricsService, WorkerRegistry, QueueEventsRegistry, ConnectionResolver,
              BYMAX_QUEUE_OPTIONS, BYMAX_QUEUE_RESOLVED_OPTIONS],
  }
}
```

**Acceptance criteria:**

- [ ] `forRootAsync({ useFactory: () => ({...}) })` instantiates everything correctly
- [ ] `forRootAsync({ imports: [CacheModule], inject: [CACHE_TOKEN], useFactory: (c) => ({...}) })` integrates with an external module
- [ ] `forRootAsync({ useClass: MyOptsFactory })` registers the factory class
- [ ] `forRootAsync({})` (none of useFactory/useClass/useExisting) → the ConfigurableModuleBuilder rejects it
- [ ] Same providers/exports as synchronous `forRoot`; `global` is applied from `setExtras`
- [ ] 100% line/branch coverage on `forRootAsync` branches

**Validation commands:**

```bash
pnpm test src/server/bymax-queue.module.spec.ts
```

**Dependencies:** §2.8, §4.1, §4.3.

### 5.2 QueueLifecycle — graceful shutdown

**Goal:** Implement the protocol from spec §10.2 in a single `OnModuleDestroy` service. Coordinate worker drain (with `drainTimeoutMs` timeout), close QueueEvents, optional `Queue.drain()`, close queues, structured shutdown metrics log.

**Files to create:**

```
src/server/lifecycle/queue-lifecycle.service.ts
```

**Skeleton:**

```typescript
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { Worker } from 'bullmq'
import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
import type { ResolvedQueueOptions } from '../config/resolved-options'
import { WorkerRegistry } from '../services/worker-registry.service'
import { QueueEventsRegistry } from '../services/queue-events-registry.service'
import { QueueService } from '../services/queue.service'
import { ConnectionResolver } from '../services/connection-resolver.service'
import { FlowService } from '../services/flow.service'

@Injectable()
export class QueueLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(QueueLifecycle.name)

  constructor(
    private readonly workers: WorkerRegistry,
    private readonly events: QueueEventsRegistry,
    private readonly queues: QueueService,
    private readonly flow: FlowService,
    private readonly connection: ConnectionResolver,
    @Inject(BYMAX_QUEUE_RESOLVED_OPTIONS) private readonly resolved: ResolvedQueueOptions,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const start = Date.now()
    let drained = 0

    // 1. Close workers with timeout (per worker)
    const drainTimeoutMs = this.resolved.shutdown.drainTimeoutMs
    for (const [name, worker] of this.workers.getAll()) {
      try {
        await this.closeWorkerWithTimeout(worker, drainTimeoutMs)
        drained++
      } catch (err) {
        this.logger.warn(`Worker "${name}" did not close within ${drainTimeoutMs}ms — forcing close`)
        await worker.close(true).catch(() => undefined)
      }
    }

    // 2. Close QueueEvents
    for (const [, qe] of this.events.getAll()) await qe.close().catch(() => undefined)

    // 3. Optional drain
    if (this.resolved.shutdown.drainOnShutdown) {
      for (const [name, queue] of this.queues.getCachedQueues()) {
        await queue.drain().catch((err) => this.logger.warn(`drain failed for ${name}: ${(err as Error).message}`))
      }
    }

    // 4. Close FlowProducer (idempotent — also has its own onModuleDestroy)
    await this.flow.onModuleDestroy().catch(() => undefined)

    // 5. Close queues
    for (const [, queue] of this.queues.getCachedQueues()) await queue.close().catch(() => undefined)

    // 6. Disconnect Redis (Mode B only)
    await this.connection.onModuleDestroy().catch(() => undefined)

    this.logger.log(`Queue shutdown complete in ${Date.now() - start}ms (drained ${drained} worker(s))`)
  }

  private async closeWorkerWithTimeout(worker: Worker, timeoutMs: number): Promise<void> {
    await Promise.race([
      worker.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('drain timeout')), timeoutMs)),
    ])
  }
}
```

**Acceptance criteria:**

- [ ] `onModuleDestroy` runs the full sequence: workers → events → drain (optional) → flow → queues → redis
- [ ] A worker exceeding `drainTimeoutMs` is forced via `worker.close(true)` (does not block the rest)
- [ ] `drainOnShutdown: true` calls `queue.drain()` on every queue
- [ ] `drainOnShutdown: false` (default) does **not** call drain
- [ ] Mode B: `connection.onModuleDestroy` (which does `quit()`) is executed
- [ ] Mode A: `connection.onModuleDestroy` is called but is a no-op (consumer manages the connection)
- [ ] Shutdown log emits duration and drained worker count
- [ ] 100% line/branch coverage (covering timeout branch, drainOnShutdown branch, swallowed errors)

**Validation commands:**

```bash
pnpm test src/server/lifecycle/queue-lifecycle.service.spec.ts
```

**Dependencies:** §2.5, §3.2, §3.3, §4.1.

**Risks/Notes:**

- **`worker.close()` already drains and takes NO timeout argument.** It stops fetching new jobs and resolves once the active jobs finish. To bound that wait we `Promise.race([worker.close(), timeout])` and escalate to `worker.close(true)` (force) only on expiry.
- **Graceful shutdown `drainTimeoutMs` behavior:** on timeout — log a structured warning, force `worker.close(true)` which aborts in-flight jobs (BullMQ marks them as `stalled` and re-runs them on another worker at the next lock). Default 30s mirrors typical K8s `terminationGracePeriodSeconds`. When the consumer adjusts `drainTimeoutMs`, they must also adjust `terminationGracePeriodSeconds` to `drainTimeoutMs + 10s` (margin to close QueueEvents/Queues/Redis).
- **At-least-once semantics.** BullMQ (and therefore this lib) guarantees at-least-once delivery, never exactly-once. Handlers must be **idempotent** (idempotency key on writes, upserts over inserts, or an "already-processed" marker keyed by `job.id`). For exhausted jobs, the consumer implements a dead-letter queue via `@OnWorkerEvent('failed')` when `job.attemptsMade >= (job.opts.attempts ?? 1)`, re-enqueuing to a `*-dlq` queue.
- `Promise.race` with `setTimeout` is the idiomatic shape for a timeout without `AbortController` on all Node runtimes still supported.

### 5.3 E2E suite with Testcontainers Redis

**Goal:** Create a `test/e2e/` suite that boots real Redis via `@testcontainers/redis`, instantiates a NestJS fixture app, and validates end-to-end scenarios. Runs only via `pnpm test:e2e`, not `pnpm test`.

**Files to create:**

```
test/e2e/queue.e2e-spec.ts
test/e2e/fixtures/test.module.ts
test/e2e/fixtures/processors/echo.processor.ts
test/e2e/setup/testcontainers.ts
jest.e2e.config.ts (already exists from §2.1 — confirm `rootDir: test/e2e`)
```

**Skeleton — `setup/testcontainers.ts`:**

```typescript
import { GenericContainer, StartedTestContainer } from 'testcontainers'

export interface RedisContainer {
  container: StartedTestContainer
  url: string
  stop: () => Promise<void>
}

export async function startRedisContainer(): Promise<RedisContainer> {
  const container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
  const host = container.getHost()
  const port = container.getMappedPort(6379)
  const url = `redis://${host}:${port}`
  return { container, url, stop: () => container.stop() }
}
```

**Skeleton — `fixtures/processors/echo.processor.ts`:**

```typescript
import { Injectable } from '@nestjs/common'
import { Processor, Process, OnQueueEvent } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

interface EchoData { payload: string }
interface EchoResult { echoed: string }

@Injectable()
@Processor('echo', { concurrency: 2 })
export class EchoProcessor {
  public completedJobs: Array<{ id: string; result: unknown }> = []

  @Process()
  async handle(job: Job<EchoData, EchoResult>): Promise<EchoResult> {
    return { echoed: job.data.payload }
  }

  @OnQueueEvent('completed')
  onCompleted(args: { jobId: string; returnvalue: unknown }): void {
    this.completedJobs.push({ id: args.jobId, result: args.returnvalue })
  }
}
```

**Skeleton — `queue.e2e-spec.ts` (scenarios):**

```typescript
describe('BymaxQueueModule — E2E', () => {
  let redis: RedisContainer
  let app: INestApplicationContext
  let queue: QueueService

  beforeAll(async () => {
    redis = await startRedisContainer()
    app = await NestFactory.createApplicationContext(buildTestModule(redis.url))
    queue = app.get(QueueService)
  }, 60_000)

  afterAll(async () => {
    await app.close()
    await redis.stop()
  })

  describe('Scenario 1 — enqueue → process → completed', () => {
    it('should process a job and emit a completed event', async () => {
      const job = await queue.enqueue<EchoData, EchoResult>('echo', 'do', { payload: 'hi' })
      await waitForCompletion(job.id!)
      // assert via processor.completedJobs
    })
  })

  describe('Scenario 2 — graceful shutdown', () => {
    it('should wait for an in-flight job before closing', async () => { /* enqueue slow job, trigger app.close, assert job completed */ })
  })

  describe('Scenario 3 — flow with 3 levels', () => {
    it('should complete all descendants before root', async () => { /* flowService.add tree, await, assert order */ })
  })

  describe('Scenario 4 — Job Scheduler fires twice in 10s; re-upsert is idempotent', () => {
    it('should fire an interval scheduler twice', async () => { /* upsertJobScheduler every: 4000, wait 10s, assert >= 2 completions; re-upsert same schedulerId → still one scheduler */ })
  })

  describe('Scenario 5 — failure → exponential retry → eventual success', () => {
    it('should retry failed jobs up to attempts', async () => { /* counter handler fails twice then succeeds, assert 3 attempts */ })
  })

  describe('Scenario 6 — deduplication collapses rapid enqueues', () => {
    it('should process only one job for N duplicate enqueues', async () => { /* enqueue N with same deduplication.id, assert one processed */ })
  })

  describe('Scenario 7 — connection-role policy', () => {
    it('should coerce the Mode-A worker connection to maxRetriesPerRequest:null while the Queue connection keeps defaults', async () => { /* inspect duplicated worker conn vs Queue conn */ })
  })
})
```

**Acceptance criteria:**

- [ ] All 7 scenarios pass
- [ ] `pnpm test:e2e` completes in < 90s (60s timeout for Testcontainers boot)
- [ ] The suite cleans all jobs/queues between scenarios (`queue.obliterate()` in afterEach)
- [ ] BullMQ logs are silenced (`logger: false` in Nest)

**Validation commands:**

```bash
pnpm test:e2e
```

**Dependencies:** §5.1, §5.2.

**Risks/Notes:**

- `testcontainers` requires Docker available — add the prerequisite to the `README.md` (Phase 5)
- CI: the `ci.yml` workflow (Phase 5) needs a runner with Docker (`ubuntu-latest` is fine)

### 5.4 Mutation testing baseline

**Goal:** Run Stryker once to generate a baseline mutation score per critical file. Save the result in `docs/mutation_testing_results.md` and a plan in `docs/mutation_testing_plan.md`.

**Files to create/update:**

```
docs/mutation_testing_plan.md      # strategy (targets, exclusions, thresholds)
docs/mutation_testing_results.md   # first run output (manual)
stryker.config.json                # confirm thresholds: high 99, low 95, break 95 (target 100%)
```

**Minimal content — `mutation_testing_plan.md`:**

- **Targets** (unacceptable survivors): `connection-resolver`, `queue.service`, `worker-registry`, `processor-discovery`, `validate-options`, `validate-connection`, `validate-repeat-options`, `metrics.service`, `queue-lifecycle`.
- **Accepted exclusions**: barrel exports, metadata-only NestJS decorators (already covered by integration).
- **Thresholds**: high 99, low 95, break 95 — targeting 100%.

**Acceptance criteria:**

- [ ] `pnpm mutation:dry-run` completes with no config error
- [ ] `pnpm mutation` (full run) yields a score ≥ 95% on critical paths (break 95), targeting 100%
- [ ] The result is documented in `mutation_testing_results.md` with a date
- [ ] Unacceptable survivors become TODOs in `mutation_testing_plan.md`

**Validation commands:**

```bash
pnpm mutation:dry-run
pnpm mutation
```

### 5.5 Phase 4 — index + tests + validation

**Files to modify:**

```
src/server/index.ts                                # export QueueLifecycle (as type only for advanced consumers)
src/server/lifecycle/queue-lifecycle.service.spec.ts
```

**Done criteria:**

- [ ] `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm test:e2e && pnpm build` pass
- [ ] 100% line/branch coverage on every implemented file (`jest.coverage.config.ts` → `100/100/100/100`)
- [ ] Mutation score ≥ 95% on critical paths (Stryker `break 95`), targeting 100%
- [ ] PR `phase-4` with `/bymax-quality:code-review` applied

### 5.6 Phase 4 validation

```bash
pnpm typecheck && pnpm lint && pnpm test:cov && pnpm test:e2e && pnpm build && pnpm size
pnpm mutation  # optional (pre-release gate)
```

---

## 6. Phase 5 — Release v0.1.0

> **Phase goal:** Finalize public documentation and repo-as-config (README, CHANGELOG, SECURITY, CLAUDE, AGENTS, `commitlint.config.cjs`, and the four Copilot review files), **finalize and harden** the CI workflows (`ci.yml`, `codeql.yml`, `release.yml`, `scorecard.yml`, `osv-scanner.yml` — scaffolded incremental-safe in Phase 1 §2.1), validate bundle budgets, and publish `0.1.0` on npm with provenance (OIDC trusted publishing).
>
> **Complexity:** LOW — no new runtime logic, only docs + CI + release.

### 6.1 README.md

**Goal:** README with badges, quick start, Mode A and Mode B examples, subpath table, link to spec/plan, troubleshooting.

**File:** `README.md`

**Minimum structure:**

```markdown
# @bymax-one/nest-queue

[![npm](https://img.shields.io/npm/v/@bymax-one/nest-queue)](...)  [![CI](...)](...)  [![Coverage](...)](...)  [![License: MIT](...)](...)

NestJS dynamic module wrapping BullMQ — typed jobs, flows, job schedulers, deduplication, OpenTelemetry, graceful shutdown.

## Quick Start
## Mode A — Bring Your Own Connection (recommended with nest-cache)
## Mode B — Own Connection
## API Reference
  - QueueService
  - WorkerRegistry (incl. registerSandboxed)
  - FlowService (opt-in)
  - MetricsService (opt-in)
## Decorators (@Processor, @Process, @OnWorkerEvent, @OnQueueEvent)
## Job Schedulers (cron / interval)
## Deduplication & Telemetry
## Graceful Shutdown (at-least-once semantics, idempotency, DLQ)
## Subpaths
| `.` (server) | …
| `./shared`   | …
## Troubleshooting
  - `CONNECTION_REQUIRES_NULL_RETRIES` → cache config
  - jobs get stuck → drainTimeoutMs
## Limitations (link to spec §16)
## Contributing
## License
```

**Acceptance criteria:**

- [ ] README ≥ 200 lines with compilable examples (extracted from spec §17)
- [ ] Badges resolve (the CI workflow must exist first — order matters)
- [ ] Link to `docs/technical_specification.md` and `docs/development_plan.md`

### 6.2 CHANGELOG, SECURITY, CLAUDE, AGENTS

**Files:**

```
CHANGELOG.md
SECURITY.md
CLAUDE.md
AGENTS.md
commitlint.config.cjs
.github/copilot-instructions.md
.github/instructions/code.instructions.md
.github/instructions/tests.instructions.md
.github/agents/agent-code-reviewer.agent.md
```

**`CHANGELOG.md` (initial entry):**

```markdown
## [0.1.0] — 2026-XX-XX

### Added
- `BymaxQueueModule.forRoot()` and `.forRootAsync()` dynamic module (built on `ConfigurableModuleBuilder`; `isGlobal` mapped to `DynamicModule.global` via `setExtras`)
- `QueueService` with typed `enqueue` (native `deduplication` options), `enqueueBulk`, `getJob`, `getJobs`, `getMetrics`, `pauseQueue/resumeQueue/cleanQueue`, and Job Schedulers `upsertJobScheduler/removeJobScheduler/getJobSchedulers`
- `@Processor`, `@Process`, `@OnWorkerEvent` (worker-local, full `Job`), `@OnQueueEvent` (global) decorators + automatic discovery via `DiscoveryService`; `job.updateProgress()` + progress event
- `WorkerRegistry` programmatic API, including `registerSandboxed` for file-based out-of-process processors
- `FlowService` (opt-in via `options.flows.enabled`)
- `MetricsService` with TTL cache (opt-in via `options.metrics.enabled`)
- Optional OpenTelemetry `telemetry` passthrough (via `bullmq-otel`, an optional peer dep)
- `QueueLifecycle` graceful shutdown protocol (bounded drain via `Promise.race` + `worker.close(true)`, optional drain, redis disconnect on Mode B); at-least-once semantics documented
- Dual-mode connection (Mode A: bring-your-own ioredis / Mode B: lib-owned), with per-role `maxRetriesPerRequest` policy
- Subpaths: `.` (server), `./shared` (zero-dep types & constants)
- Peer deps: `@nestjs/common ^11`, `@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata ^0.2`; optional `bullmq-otel ^1`
- E2E tests with Testcontainers Redis
```

**`SECURITY.md`:** follow the OpenSSF template — email security@bymax.one, 90-day disclosure policy, scope (peer deps out of scope).

**`CLAUDE.md` / `AGENTS.md`:** point to `docs/technical_specification.md` + `docs/development_plan.md` + `docs/tasks/` as required reading; reinforce universal rules (TypeScript strict, English, JSDoc, no `any`, no eslint-disable).

**Copilot review files:** `.github/copilot-instructions.md` (repo-wide review config), `.github/instructions/code.instructions.md`, `.github/instructions/tests.instructions.md`, `.github/agents/agent-code-reviewer.agent.md`. **`commitlint.config.cjs`:** Conventional Commits, drives the changelog/semver bump.

**Acceptance criteria:**

- [ ] All files above created (docs + `commitlint.config.cjs` + the four Copilot review files)
- [ ] CHANGELOG follows Keep-a-Changelog
- [ ] SECURITY references OpenSSF Scorecard
- [ ] CLAUDE.md / AGENTS.md mirror the structure of `nest-auth` / `nest-logger`

### 6.3 CI workflows — finalize & harden

> The five workflows are **created in Phase 1 §2.1** (incremental-safe, green from the first PR — `release.yml` inert until tag). This step **finalizes and hardens** them now that the full suite exists: enable the real coverage/e2e/mutation gates, confirm SHA-pinning and least-privilege permissions, and prove every workflow green before the publish.

**Files (created in Phase 1; hardened here):**

```
.github/workflows/ci.yml
.github/workflows/codeql.yml
.github/workflows/release.yml
.github/workflows/scorecard.yml
.github/workflows/osv-scanner.yml
```

**`ci.yml` (final form):** matrix Node 24, pnpm 11, steps — `install` (`--frozen-lockfile`), `typecheck`, `lint`, `test:cov:all` (100% line/branch), `build`, `size`, `test:e2e` (with Docker service for Redis testcontainer), **TruffleHog OSS** secret scan, upload coverage to Codecov. (The incremental-safe `--passWithNoTests` shims from Phase 1 are removed once real specs exist.)

**`codeql.yml`:** JavaScript/TypeScript static analysis, scheduled weekly + push on `main`.

**`release.yml`:** trigger on `v*.*.*` tag, runs `pnpm prepublishOnly` + the mutation gate + `pnpm publish --provenance` (OIDC trusted publishing), creates a GitHub Release with changelog.

**`scorecard.yml`:** OpenSSF Scorecard scheduled (target ≥ 7.0).

**`osv-scanner.yml`:** OSV-Scanner dependency vulnerability scan (PR + weekly).

**Hardening:** all third-party actions **pinned by commit SHA**, least-privilege `permissions:` per workflow, secret scanning via TruffleHog OSS, and npm publish with **provenance** (OIDC).

**Acceptance criteria:**

- [ ] `ci.yml` green on PR against `main` (incl. TruffleHog secret scan)
- [ ] `codeql.yml` reports 0 alerts (or info only)
- [ ] `osv-scanner.yml` clean
- [ ] `release.yml` tested on pre-release `0.1.0-alpha.0` (publish dry-run, provenance/OIDC)
- [ ] OpenSSF Scorecard ≥ 7.0; all Actions pinned by commit SHA

### 6.4 Bundle budgets + size gate

**File:** `scripts/check-size.mjs`

**Implementation:** read `dist/server/index.mjs` + `dist/shared/index.mjs`, compress via `brotli` (Node builtin), compare to budgets (`server: 18_432` = 18 KiB, `shared: 2_500`), exit 1 if exceeded.

**Acceptance criteria:**

- [ ] `pnpm size` passes with the current bundle
- [ ] A deliberate failure (add 500 LoC of garbage strings) is detected
- [ ] Output formatted: `server: 8,432 B brotli (budget 18,432 = 18 KiB) — OK`

### 6.5 BullMQ v6 promotion strategy (release notes)

**Decision documented in CHANGELOG and SECURITY:**

- `0.1.x` floors `peerDependencies.bullmq = "^5.16.0"` (where the Job Schedulers API landed; current release `5.79.1`). Because the lib already builds exclusively on Job Schedulers (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`) and never on the removed `addRepeatable`/`removeRepeatable` API, it is **forward-compatible with v6 by design** — no public-API break is expected.
- Trigger for `^5.16.0 || ^6.0.0` promotion: green lib E2E suite on the v5 + v6 matrix; promotion is additive (no adapter needed since the recurring-jobs surface is unchanged).
- If some other API we use breaks in v6 without a trivial adapter, create a parallel `v6` branch and keep `0.1.x`/`0.2.x` on `^5.16` only.

**Acceptance criteria:**

- [ ] CHANGELOG includes a "BullMQ version policy" section referencing this decision (floor `^5.16.0`, forward-compatible with v6)
- [ ] README "Limitations" mentions the v5→v6 promotion plan — see CHANGELOG

### 6.6 Publish v0.1.0

**Sequence:**

```bash
# 1. Verify pristine state
git status                          # clean
pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm test:e2e && pnpm build && pnpm size

# 2. Bump version
npm version 0.1.0 --no-git-tag-version
git add package.json CHANGELOG.md
git commit -m "chore(release): v0.1.0"

# 3. Tag and push
git tag v0.1.0
git push origin main --tags

# 4. release.yml takes over and publishes with --provenance
```

**Acceptance criteria:**

- [ ] `npm view @bymax-one/nest-queue@0.1.0` returns metadata
- [ ] Provenance badge appears on the npm package page
- [ ] GitHub Release `v0.1.0` created with changelog
- [ ] Tag `v0.1.0` in the repo

**Done criteria — Phase 5 (release ready):**

- [ ] All files in §6.1 through §6.6 created/configured
- [ ] CI workflows green
- [ ] Bundle within budgets
- [ ] Mutation score documented in `docs/mutation_testing_results.md`
- [ ] PR `phase-5` merged with `/bymax-quality:code-review` applied
- [ ] Tag `v0.1.0` published and the package visible on npm

---

## Appendix A — Dependency Graph

ASCII graph of sub-steps (read as "X depends on Y"):

```
Phase 1 — Foundation
  §2.1 scaffold ────────────────────────────────────────────────────────────────┐
       │                                                                        │
       ▼                                                                        │
  §2.2 shared types ──┐                                                          │
                      │                                                          │
                      ▼                                                          │
  §2.3 interfaces ────┼──┐                                                       │
                      │  │                                                       │
                      ▼  ▼                                                       │
  §2.4 constants/tokens                                                          │
       │                                                                        │
       ▼                                                                        │
  §2.5 ConnectionResolver ──────┐                                                │
       │                        │                                                │
       ▼                        │                                                │
  §2.6 resolved options + validate                                                │
       │                                                                        │
       ▼                                                                        │
  §2.7 QueueService base ──┐                                                     │
       │                   │                                                     │
       ▼                   │                                                     │
  §2.8 forRoot + index + tests + validation                                       │
                                                                                │
Phase 2 — Workers                                                                │
  §3.1 decorators                                                                │
       │                                                                        │
       ▼                                                                        │
  §3.2 WorkerRegistry ──┐    (depends on §2.5)                                   │
                        │                                                       │
                        ▼                                                       │
  §3.3 discovery + QueueEventsRegistry                                            │
                        │                                                       │
                        ▼                                                       │
  §3.4 module integration                                                        │
                        │                                                       │
                        ▼                                                       │
  §3.5 concurrency warning  →  §3.6 tests  →  §3.7 phase validation              │
                                                                                │
Phase 3 — Flows / Job Schedulers / Metrics                                       │
  §4.1 FlowService ──┐         (depends on §2.5)                                 │
                     │                                                          │
                     ▼                                                          │
  §4.2 Job Scheduler methods in QueueService (depends on §2.7)                  │
                     │                                                          │
                     ▼                                                          │
  §4.3 MetricsService (depends on §2.7)                                         │
                     │                                                          │
                     ▼                                                          │
  §4.4 health pattern docs  →  §4.5 index + tests  →  §4.6 phase validation     │
                                                                                │
Phase 4 — forRootAsync + E2E + Shutdown                                          │
  §5.1 forRootAsync (depends on §2.8, §4.1, §4.3)                                │
       │                                                                        │
       ▼                                                                        │
  §5.2 QueueLifecycle (depends on §2.5, §3.2, §3.3, §4.1)                        │
       │                                                                        │
       ▼                                                                        │
  §5.3 E2E suite (depends on §5.1, §5.2)                                         │
       │                                                                        │
       ▼                                                                        │
  §5.4 mutation baseline  →  §5.5 index + tests  →  §5.6 phase validation        │
                                                                                │
Phase 5 — Release                                                                │
  §6.1 README ─→ §6.2 CHANGELOG/SECURITY/CLAUDE/AGENTS ─→ §6.3 CI workflows ─→  ▼
  §6.4 bundle budgets ─→ §6.5 v6 strategy notes ─→ §6.6 publish v0.1.0
```

Parallelization rules:
- **§2.2** and **§2.3** can run in parallel (§2.3 references §2.2 types only in the module options).
- **§3.1** can happen in parallel with **§3.2** (decorators only write metadata; the registry consumes them in §3.3).
- **§4.1** / **§4.2** / **§4.3** are independent — three parallel workstreams once §3.7 closes.
- **§5.1** and **§5.2** can run in parallel (shared use of types, not of execution).
- Each sub-step blocks the closure of its phase, but does not block the start of the next as long as its specific deps are done.

---

## Appendix B — Complexity Matrix

| Sub-step | Complexity | Justification |
|---|---|---|
| §2.1 Scaffold | LOW | Adapted copy of nest-auth/nest-logger; 2 entries instead of 5. |
| §2.2 Shared types/constants | LOW | Pure types without logic. |
| §2.3 Interfaces | MEDIUM | The discriminated union `QueueConnectionConfig` needs care for narrowing to work. |
| §2.4 Constants/DI tokens | LOW | Symbol + constants. |
| §2.5 ConnectionResolver | HIGH | Dual-mode + validation + timeout + listener cleanup — high blast radius, every downstream test depends on this piece. |
| §2.6 Resolved options + validate | MEDIUM | Validating an exclusive union (`client` vs `url`/`options`) with clear messages. |
| §2.7 Base QueueService | MEDIUM | 7 methods + Queue cache; generic typing must propagate through to `Job<TData, TResult>`. |
| §2.8 forRoot + index + tests + Phase 1 validation | MEDIUM | Integration of every provider + smoke test against local Redis. |
| §3.1 Decorators | LOW | Only metadata via `Reflect.defineMetadata`. |
| §3.2 WorkerRegistry | MEDIUM | `register/unregister`, options validation, connection `duplicate()`. |
| §3.3 Discovery + QueueEventsRegistry | HIGH | Integration with NestJS `DiscoveryService`; jobName-specific vs catch-all dispatcher; binding listeners at runtime. |
| §3.4 Module integration | LOW | Add providers + imports. |
| §3.5 Concurrency warning | LOW | Flag + log in discovery. |
| §3.6 Phase 2 tests | MEDIUM | Mock `DiscoveryService` + BullMQ Worker. |
| §3.7 Phase 2 validation | LOW | Smoke test against local Redis. |
| §4.1 FlowService | MEDIUM | Always registered but opt-in via an internal flag; ensureEnabled guard. |
| §4.2 Job Schedulers | MEDIUM | Cron validation via `cron-parser` (5- and 6-field); map `JobSchedulerRepeatOptions` → BullMQ `upsertJobScheduler`; idempotent re-upsert. |
| §4.3 MetricsService | MEDIUM | TTL cache + cross-queue aggregation + invalidate. |
| §4.4 Health pattern docs | LOW | JSDoc/README only. |
| §4.5 Phase 3 tests | MEDIUM | `jest.useFakeTimers` for TTL. |
| §4.6 Phase 3 validation | LOW | Smoke test. |
| §5.1 forRootAsync | HIGH | `useFactory` / `useClass` / `useExisting` / `inject`; must replicate sync exports without duplication. |
| §5.2 QueueLifecycle | HIGH | Race conditions on shutdown; forced timeout; order matters (workers → events → drain → flow → queues → redis). |
| §5.3 E2E Testcontainers | HIGH | Container boot, isolation between scenarios (obliterate), timing of async events. |
| §5.4 Mutation baseline | MEDIUM | Configure Stryker + interpret survivors. |
| §5.5 Phase 4 tests | MEDIUM | Lifecycle tests with Worker/QueueEvents mocks. |
| §5.6 Phase 4 validation | LOW | Real `test:e2e`. |
| §6.1 README | LOW | Documentation. |
| §6.2 CHANGELOG/SECURITY/CLAUDE/AGENTS | LOW | Boilerplate copied/adapted from other portfolio libs. |
| §6.3 CI workflows | MEDIUM | Workflows with Docker service + matrix; may break on the first PR. |
| §6.4 Bundle budgets | LOW | Node script + brotli. |
| §6.5 BullMQ v6 strategy notes | LOW | Docs only. |
| §6.6 Publish v0.1.0 | LOW | Validated command sequence. |

> **How to use this matrix:** sub-steps marked **HIGH** demand careful human review before merge and should be broken down into red/green/refactor in the relevant `docs/tasks/phase-NN-*.md` file. **MEDIUM** sub-steps support one task per sub-step with a checklist. **LOW** sub-steps can be grouped if they share context (e.g., all of §6.2 as a single task).

---

## Appendix C — Reference Configs

| File | Source (canonical) | Adaptation for nest-queue |
|---|---|---|
| `tsconfig.json` | `nest-auth/tsconfig.json` | Swap `paths` aliases — 2 subpaths (`@bymax-one/nest-queue`, `@bymax-one/nest-queue/shared`). |
| `tsconfig.build.json` | `nest-auth/tsconfig.build.json` | Identical (extends tsconfig.json, excludes `**/*.spec.ts`, `test/`). |
| `tsconfig.server.json` | `nest-auth/tsconfig.server.json` | `include: ['src/server/**/*']`. |
| `tsconfig.e2e.json` | `nest-auth/tsconfig.e2e.json` | Includes `test/e2e/`; more permissive on `noUnusedParameters` for helpers. |
| `tsconfig.jest.json` | `nest-auth/tsconfig.jest.json` | Identical. |
| `jest.config.ts` | `nest-auth/jest.config.ts` | `moduleNameMapper` points to 2 subpaths; 100% line/branch on implemented files. |
| `jest.coverage.config.ts` | `nest-auth/jest.coverage.config.ts` | Thresholds `100/100/100/100` (line/branch/function/statement). |
| `jest.e2e.config.ts` | `nest-auth/jest.e2e.config.ts` | `rootDir: 'test/e2e'`; setup for Testcontainers boot. |
| `jest.stryker.config.ts` | `nest-auth/jest.stryker.config.ts` | Identical. |
| `stryker.config.json` | `nest-auth/stryker.config.json` | Thresholds: high 99, low 95, break 95 (target 100%). |
| `tsup.config.ts` | (rewrite) | 2 entries (`server`, `shared`); externals: `bullmq`, `ioredis`, `@nestjs/*`, `reflect-metadata`. |
| `eslint.config.mjs` | `nest-auth/eslint.config.mjs` | Copy; remove rules specific to `oauth/`, `crypto/`. |
| `.prettierrc` | `nest-auth/.prettierrc` | Identical (singleQuote, no semicolons, 2-space). |
| `.gitignore` / `.npmignore` | `nest-auth/.*ignore` | Identical. |
| `scripts/check-size.mjs` | (rewrite) | 2 entries: `server` 18_432 (18 KiB) brotli, `shared` 2_500 brotli. |
| `.github/workflows/ci.yml` | `nest-auth/.github/workflows/ci.yml` | Add Docker service for Testcontainers in the `e2e` job. |
| `.github/workflows/codeql.yml` | `nest-auth/.github/workflows/codeql.yml` | Identical. |
| `.github/workflows/release.yml` | `nest-auth/.github/workflows/release.yml` | Identical (publish with `--provenance`). |
| `.github/workflows/scorecard.yml` | `nest-auth/.github/workflows/scorecard.yml` | Identical (OpenSSF Scorecard, target ≥ 7.0). |
| `.github/workflows/osv-scanner.yml` | `nest-auth/.github/workflows/osv-scanner.yml` | OSV-Scanner dependency vulnerability scan (PR + weekly). |
| `commitlint.config.cjs` | `nest-auth/commitlint.config.cjs` | Identical (Conventional Commits). |
| `.github/copilot-instructions.md` + `instructions/*` + `agents/agent-code-reviewer.agent.md` | `nest-auth/.github/...` | Copy; adjust references to `nest-queue` docs. |

---

## Appendix D — Glossary

| Term | Meaning in this lib |
|---|---|
| **Mode A** | Dual-mode connection — caller passes a ready `Redis` (typical: `BYMAX_CACHE_QUEUE_REDIS` from `nest-cache`). The lib does not close it. |
| **Mode B** | Dual-mode connection — caller passes `url` or `options`; the lib opens its own `ioredis` with `maxRetriesPerRequest: null` and closes it on shutdown. |
| **DEFAULT_WORKER_CONCURRENCY** | Constant = 2 — a non-serial starting point vs BullMQ's silent `1`, not a magic optimum. Tune by workload: raise for I/O-bound handlers; for CPU-bound work keep it low and move to a sandboxed processor (§6.8 of the spec). |
| **Drain timeout** | `options.shutdown.drainTimeoutMs` (default 30s) — window for workers to finish in-flight jobs before force-close. |
| **drainOnShutdown** | DEV-ONLY flag that wipes `waiting`/`delayed` jobs on shutdown. Default `false`. |
| **Job Scheduler** | Recurring job — cron (`pattern: '0 3 * * *'`) or interval (`every: 60000`), via `upsertJobScheduler`. Idempotent by `schedulerId`; supersedes the deprecated `addRepeatable` API (removed in BullMQ v6). |
| **Flow** | Tree of jobs with parent/child relations — the parent waits for all children to complete. Opt-in via `flows.enabled`. |
| **Discovery** | Scan of the Nest container (`DiscoveryService`) looking for classes with `PROCESSOR_METADATA_KEY` metadata to register workers on `onModuleInit`. |
| **QueueEvents** | A dedicated BullMQ connection that receives events (`completed`, `failed`, …). One instance per queue, lazily created by `QueueEventsRegistry`. |
| **Testcontainers** | JS lib that boots Docker containers during tests — used in the E2E suite for real Redis. |

---

> **Next step:** the per-phase task files under `docs/tasks/phase-NN-*.md` are derived from this plan applying the rule from §1.6 — one task per sub-step (or sub-divided into red/green/refactor for `HIGH` sub-steps).
</content>
</invoke>