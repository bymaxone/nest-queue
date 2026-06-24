# Phase 5 — Release v0.1.0: docs, CI/CD, supply chain & publish

> **Status**: 📋 ToDo · **Progress**: 0 / 8 tasks · **Last updated**: 2026-06-23
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § Phase 5
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md)

---

## Context

Phases 1–4 are complete: the full library is implemented and tested behind a 100% line/branch coverage gate. `BymaxQueueModule.forRoot()`/`forRootAsync()`, the dual-mode `ConnectionResolver`, the typed `QueueService` (`enqueue`/`enqueueBulk`/`getJob`/`getJobs`/`getMetrics`/`pauseQueue`/`resumeQueue`/`cleanQueue` plus the Job Schedulers surface `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`), the `@Processor`/`@Process`/`@OnWorkerEvent`/`@OnQueueEvent` decorators with `DiscoveryService` wiring, the `WorkerRegistry` (including `registerSandboxed`), the opt-in `FlowService` and `MetricsService`, the optional OpenTelemetry passthrough, and the `QueueLifecycle` graceful-shutdown protocol all exist, build for the two subpaths (`.` server / `./shared`), and pass their unit + Testcontainers E2E suites.

Phase 5 ships the library publicly. It adds **no new runtime logic** — only the documentation, the repo-as-config governance files, the CI/CD and supply-chain workflows, the bundle-size gate, the pre-release mutation gate, the dogfood example, and the `0.1.0` publish to npm with provenance. The defining premise is that for a public NestJS/BullMQ library the **supply chain is part of the threat model**: the posture is explicit and verifiable end to end (SHA-pinned actions, least-privilege workflow permissions, TruffleHog secret scanning, OSV-Scanner advisory scanning, OpenSSF Scorecard transparency, committed lockfile, OIDC provenance), so a downstream consumer can trust what shipped and that it was built by this repo's release workflow.

When Phase 5 is done: `README.md`/`CHANGELOG.md`/`SECURITY.md`/`CLAUDE.md`/`AGENTS.md` and the four Copilot review files are in place; `commitlint.config.cjs` enforces Conventional Commits; `ci.yml`/`codeql.yml`/`scorecard.yml`/`osv-scanner.yml`/`release.yml` are green and hardened; the `server` bundle is ≤ 18 KiB brotli and `shared` ≤ 2.5 KiB; the Stryker mutation score meets `break 95` and is recorded in `docs/mutation_testing_results.md`; the `nest-queue-example` dogfood app consumes the published surface; and `@bymax-one/nest-queue@0.1.0` is live on npm with an OIDC provenance attestation. **The public API surface is frozen at what `src/server/index.ts` and `src/shared/index.ts` already export.**

---

## Rules-of-phase

1. **No new runtime logic.** Phase 5 is docs + CI + release only; the public surface is exactly what `src/server/index.ts` + `src/shared/index.ts` export and must not change. Re-exported BullMQ types are passthroughs and follow BullMQ.
2. **Zero `dependencies`.** `package.json` ships `"dependencies": {}`; `bullmq ^5.16`, `ioredis ^5`, `@nestjs/common ^11`, `@nestjs/core ^11`, and `reflect-metadata ^0.2` stay **peer** deps; `bullmq-otel ^1` is an **optional** peer. `@nestjs/bullmq` is NOT a dependency of this library.
3. **OIDC Trusted Publishing only.** npm publish runs with `--provenance` from a `v*.*.*` tag; no long-lived `NPM_TOKEN` is baked into the repo. The publish token (where present) is 2FA / granular-scoped.
4. **The supply chain is part of the threat model.** Every third-party GitHub Action is **pinned by commit SHA**; each workflow declares **least-privilege `permissions:`**; CI runs a **TruffleHog OSS** secret scan; **OSV-Scanner** scans dependencies; **OpenSSF Scorecard ≥ 7.0**; the lockfile is committed.
5. **Coverage is the per-PR gate; mutation is the pre-release gate.** 100% line/branch on implemented files on every PR; Stryker `break 95` (high 99, low 95, target 100%) only before a release — never per-commit.
6. **Bundle budgets are enforced.** `dist/server/index.mjs` ≤ 18 KiB brotli (`18_432` bytes); `dist/shared/index.mjs` ≤ 2.5 KiB brotli (`2_500` bytes). `bullmq`/`ioredis`/`@nestjs/*` stay external to the bundle.
7. **BullMQ floor `^5.16.0` (Job Schedulers).** Recurring jobs go through `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`; the library never uses the removed `addRepeatable`/`removeRepeatable` API, so it is **forward-compatible with v6 by design** — no public-API break is expected on promotion.
8. **English-only and timeless content.** No `Phase N`/`Task`/roadmap references inside any committed file (README, CHANGELOG, SECURITY, CLAUDE, AGENTS, the Copilot review files, or the workflows). No statement that the library exists to demonstrate any author's or company's seniority/authority — keep every doc strictly product-focused.
9. **Conventional Commits**, enforced by `commitlint.config.cjs`; the changelog and the semver bump derive from commit history.
10. **Never create `.gitkeep`/`.keep` or empty-directory placeholders** — directories emerge from real files only.

---

## Reference docs

- [`docs/technical_specification.md`](../technical_specification.md) — § 14 Dependencies (peer/optional/`package.json`, the v5→v6 decision §14.5), § 18 Testing Strategy & Quality Gates, § 19 CI/CD & Release Engineering (§19.1 workflows, §19.2 hardening, §19.3 repo-as-config, §19.4 dogfood), § 20 Versioning & Migration Policy, § 21 Comparison with `@nestjs/bullmq`, Appendix B Security checklist.
- [`docs/development_plan.md`](../development_plan.md) — § 1.4 Global Done criteria per phase, § 6 "Phase 5 — Release v0.1.0" (§6.1–§6.6).
- `/bymax-workflow:standards` skill — universal coding/docs rules (TypeScript track): TS strict, English-only, JSDoc on exports, no `any`, no `eslint-disable`, Conventional Commits, timeless comments.

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 5.1 | `README.md` — the public front door | 📋 ToDo | P0 | M | 4.7 |
| 5.2 | Governance & repo-as-config (CHANGELOG, SECURITY, CLAUDE, AGENTS, commitlint + 4 Copilot files) | 📋 ToDo | P0 | M | 4.7 |
| 5.3 | CI/CD + supply-chain workflows (ci/codeql/scorecard/osv-scanner/release) | 📋 ToDo | P0 | L | 5.2 |
| 5.4 | Bundle budget + size gate (`scripts/check-size.mjs`) | 📋 ToDo | P0 | S | 4.7 |
| 5.5 | Mutation gate run (Stryker `break 95`) + mutation docs | 📋 ToDo | P0 | M | 4.7 |
| 5.6 | `nest-queue-example` dogfood app | 📋 ToDo | P1 | L | 5.1, 5.3 |
| 5.7 | BullMQ v6 promotion notes (CHANGELOG version policy + README limitations) | 📋 ToDo | P1 | S | 5.1, 5.2 |
| 5.8 | Publish `v0.1.0` (tag → release workflow → verify npm) | 📋 ToDo | P0 | M | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7 |

> Cross-phase dependencies reference **Phase 4** `4.7` (Phase 4 close/validation task, which transitively proves Phases 1–4 are complete).

---

## Tasks

### Task 5.1 — `README.md` — the public front door

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 4.7

#### Description

Author the public `README.md`: badge row, a runnable quick start, the two connection modes (A — bring-your-own client; B — lib-owned), the API reference (`QueueService`, `WorkerRegistry`, `FlowService`, `MetricsService`), the decorators, Job Schedulers, deduplication & telemetry, the graceful-shutdown semantics, the subpath table, a "why over `@nestjs/bullmq`" section condensed from § 21, troubleshooting, and a link to the limitations.

#### Acceptance criteria

- [ ] README ≥ 200 lines with **compilable** examples drawn from the spec's worked examples.
- [ ] Badge row present: npm version, CI, coverage, License (MIT), OpenSSF Scorecard, provenance (badges are placeholders until the CI/release workflows land in Task 5.3 — order is documented).
- [ ] Quick Start plus **Mode A** (bring-your-own `ioredis`, recommended with `@bymax-one/nest-cache`) and **Mode B** (lib-owned via `url`/`options`) sections, each with a copy-pasteable `forRoot`/`forRootAsync` snippet.
- [ ] API Reference covers `QueueService` (`enqueue`/`enqueueBulk`/`getJob`/`getJobs`/`getMetrics`/`pauseQueue`/`resumeQueue`/`cleanQueue` + `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`), `WorkerRegistry` (incl. `registerSandboxed`), opt-in `FlowService`, opt-in `MetricsService`.
- [ ] Sections for the decorators (`@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`), Job Schedulers (cron / interval via `upsertJobScheduler`), Deduplication & Telemetry (native BullMQ `deduplication` + optional `bullmq-otel`), and Graceful Shutdown (at-least-once semantics, idempotency, DLQ note).
- [ ] Subpath table for `.` (server) and `./shared` (zero peer-dep types & constants); peer-dependency matrix per subpath.
- [ ] A "Why over `@nestjs/bullmq`" section condensed from § 21 (single `forRoot`, dual-mode connection, enforced defaults, tested shutdown).
- [ ] Troubleshooting (`CONNECTION_REQUIRES_NULL_RETRIES` → cache config; stuck jobs → `drainTimeoutMs`) and a "Limitations" section linking to the spec's limitations.
- [ ] Links to `docs/technical_specification.md` and `docs/development_plan.md`; no `eslint-disable`, no marketing about author/company seniority.

#### Files to create / modify

- `README.md`

#### Agent prompt

````
You are a senior NestJS/TypeScript developer-experience engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS dynamic module wrapping BullMQ: typed jobs, flows,
Job Schedulers, native deduplication, optional OpenTelemetry, and a bounded graceful-shutdown
protocol. Published to npm. Peer deps: @nestjs/common ^11, @nestjs/core ^11, bullmq ^5.16
(current 5.79.1), ioredis ^5.11, reflect-metadata ^0.2; optional peer bullmq-otel ^1.
Zero runtime dependencies. Node >= 24, pnpm 11. @nestjs/bullmq is NOT a dependency.

CURRENT PHASE: 5 (Release) — Task 5.1 of 8 (FIRST)

PRECONDITIONS
- Phases 1–4 are done: the full library (module, ConnectionResolver, QueueService, decorators +
  WorkerRegistry, FlowService, MetricsService, QueueLifecycle) builds for both subpaths and passes
  its unit + E2E suites. README is the front door for the public package.

REQUIRED READING (only these sections — do not load more):
- `docs/development_plan.md` § 6.1 (the README minimum structure + acceptance criteria).
- `docs/technical_specification.md` § 21 "Comparison with @nestjs/bullmq" (the differentiators table
  to condense into the "Why over @nestjs/bullmq" section).
- `docs/technical_specification.md` § 14 "Dependencies" (peer/optional deps, subpath matrix, the
  package.json shape) — for the subpath + peer-dependency tables.
- `docs/technical_specification.md` § 10 "Delivery Semantics and Shutdown Strategy" (at-least-once,
  bounded drain) — for the Graceful Shutdown section.
- `docs/technical_specification.md` § 16 (Limitations) — for the "Limitations" link target.

TASK
Author a complete, professional `README.md` for the published package.

DELIVERABLES

1. `README.md` (≥ 200 lines), in this order:
   - Title `# @bymax-one/nest-queue` and a one-line value statement, e.g.:

     ```markdown
     NestJS dynamic module wrapping BullMQ — typed jobs, flows, Job Schedulers,
     deduplication, OpenTelemetry, and a bounded graceful shutdown.
     ```

   - A badge row (placeholders that resolve once Task 5.3 lands the workflows):

     ```markdown
     [![npm](https://img.shields.io/npm/v/@bymax-one/nest-queue)](https://www.npmjs.com/package/@bymax-one/nest-queue)
     [![CI](https://github.com/bymaxone/nest-queue/actions/workflows/ci.yml/badge.svg)](...)
     [![Coverage](...)](...)  [![License: MIT](...)](...)  [![OpenSSF Scorecard](...)](...)  [![provenance](...)](...)
     ```

   - `## Quick Start` — install line (`pnpm add @bymax-one/nest-queue bullmq ioredis`), a minimal
     `forRoot` wiring, an `enqueue` call, and a `@Processor`/`@Process` handler.
   - `## Mode A — Bring Your Own Connection (recommended with @bymax-one/nest-cache)` and
     `## Mode B — Lib-Owned Connection` — each a copy-pasteable snippet (Mode A: `{ client: queueRedis }`;
     Mode B: `{ url: process.env.REDIS_URL }` or `{ options: {...} }`). State that Worker/QueueEvents
     connections are duplicated with `maxRetriesPerRequest: null` while the Queue connection keeps
     ioredis defaults.
   - `## API Reference` — `QueueService`, `WorkerRegistry` (incl. `registerSandboxed`), `FlowService`
     (opt-in), `MetricsService` (opt-in) with short typed examples.
   - `## Decorators` — `@Processor`, `@Process(jobName?)`, `@OnWorkerEvent`, `@OnQueueEvent`.
   - `## Job Schedulers` — cron and interval via `upsertJobScheduler` (and `removeJobScheduler`/
     `getJobSchedulers`); note this is the current recurring-jobs API (not the removed `addRepeatable`).
   - `## Deduplication & Telemetry` — native BullMQ `deduplication` options surfaced on `enqueue`;
     OpenTelemetry via the optional `bullmq-otel` peer.
   - `## Graceful Shutdown` — at-least-once semantics, idempotency, DLQ guidance, `drainTimeoutMs`.
   - `## Subpaths` — a table: `.` (server) and `./shared` (zero peer-dep types & constants) + the
     per-subpath peer-dependency matrix.
   - `## Why over @nestjs/bullmq` — condensed from § 21 (single `forRoot`, dual-mode connection,
     enforced defaults, tested shutdown, typed producer API).
   - `## Troubleshooting` — `CONNECTION_REQUIRES_NULL_RETRIES` → cache config; stuck jobs → `drainTimeoutMs`.
   - `## Limitations` — short note + link to the spec's limitations section.
   - `## Contributing` and `## License` (MIT) plus links to `docs/technical_specification.md` and
     `docs/development_plan.md`.

Constraints:
- English-only; neutral, professional tone. Do NOT claim the library exists to demonstrate any
  author's or company's seniority/authority — keep it product-focused.
- Timeless content — no roadmap/phase/task references anywhere in the README.
- Examples must be compilable against the real public API; no `any`, no `eslint-disable`.
- Follow `/bymax-workflow:standards` (TypeScript track) for code in fenced examples.

Verification:
- `wc -l README.md` — expected: ≥ 200.
- `grep -qi 'Mode A' README.md && grep -qi 'Mode B' README.md` — expected: both match.
- `grep -q 'upsertJobScheduler' README.md` — expected: match (Job Schedulers section present).
- `grep -qi '@nestjs/bullmq' README.md` — expected: match (the comparison section).
- `grep -q 'technical_specification.md' README.md` — expected: match (spec link).

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `1/8` in the header.
5. Update the Phase 5 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 5.1 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 5.2 — Governance & repo-as-config (CHANGELOG, SECURITY, CLAUDE, AGENTS, commitlint + 4 Copilot files)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 4.7

#### Description

Create the governance and repo-as-config deliverables: `CHANGELOG.md` (Keep-a-Changelog, the `0.1.0` entry), `SECURITY.md` (OpenSSF-style disclosure policy), `CLAUDE.md` and `AGENTS.md` (agent guidance pointing to the canonical docs), `commitlint.config.cjs` (Conventional Commits), and the four Copilot review files.

#### Acceptance criteria

- [ ] `CHANGELOG.md` follows Keep-a-Changelog + SemVer with a complete `## [0.1.0]` `### Added` entry enumerating the shipped surface (module + `forRoot`/`forRootAsync`, `QueueService` incl. Job Schedulers, decorators + discovery, `WorkerRegistry`/`registerSandboxed`, opt-in `FlowService`/`MetricsService`, telemetry passthrough, `QueueLifecycle`, dual-mode connection, the two subpaths, the peer-dep set).
- [ ] `SECURITY.md` follows the OpenSSF template: security contact `security@bymax.one`, a 90-day coordinated-disclosure policy, supported-versions table, scope (peer deps out of scope), and a reference to OpenSSF Scorecard; reporters asked not to open public issues for vulnerabilities.
- [ ] `CLAUDE.md` and `AGENTS.md` point to `docs/technical_specification.md` + `docs/development_plan.md` + `docs/tasks/` as required reading and reinforce the universal rules (TS strict, English, JSDoc on exports, no `any`, no `eslint-disable`, Conventional Commits, timeless comments); they mirror the structure of the portfolio's `nest-auth` / `nest-logger`.
- [ ] `commitlint.config.cjs` extends `@commitlint/config-conventional` and documents the project's commit scopes.
- [ ] The four Copilot review files exist: `.github/copilot-instructions.md` (repo-wide review config), `.github/instructions/code.instructions.md`, `.github/instructions/tests.instructions.md`, `.github/agents/agent-code-reviewer.agent.md`.
- [ ] No phase/task/roadmap references in any committed file; no claim that the library demonstrates author/company seniority.

#### Files to create / modify

- `CHANGELOG.md`, `SECURITY.md`, `CLAUDE.md`, `AGENTS.md`, `commitlint.config.cjs`
- `.github/copilot-instructions.md`, `.github/instructions/code.instructions.md`, `.github/instructions/tests.instructions.md`, `.github/agents/agent-code-reviewer.agent.md`

#### Agent prompt

````
You are a senior open-source maintainer / DX engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS module wrapping BullMQ (typed jobs, flows, Job
Schedulers, deduplication, optional OpenTelemetry, graceful shutdown). Published to npm. Peer deps:
@nestjs/common ^11, @nestjs/core ^11, bullmq ^5.16, ioredis ^5.11, reflect-metadata ^0.2; optional
peer bullmq-otel ^1. Zero runtime dependencies. Node >= 24, pnpm 11.

CURRENT PHASE: 5 (Release) — Task 5.2 of 8 (MIDDLE)

PRECONDITIONS
- Phases 1–4 are done: the full library is implemented and tested. This task adds the governance and
  repo-as-config files only — no source code.

REQUIRED READING (only these sections):
- `docs/development_plan.md` § 6.2 (the CHANGELOG initial entry, the SECURITY/CLAUDE/AGENTS/Copilot
  file list, the commitlint requirement).
- `docs/technical_specification.md` § 19.2 "Hardening" + § 19.3 "Repo-as-config deliverables" (the
  required files and the Conventional-Commits posture).
- `docs/technical_specification.md` Appendix B "Security checklist" (the disclosure-policy and
  supply-chain items SECURITY.md must reflect).

TASK
Author the governance and repo-as-config files.

DELIVERABLES

1. `CHANGELOG.md` — Keep-a-Changelog header + SemVer note + a `## [0.1.0] — <date>` `### Added`
   section listing the shipped surface, e.g.:

   ```markdown
   ## [0.1.0] — 2026-XX-XX

   ### Added
   - `BymaxQueueModule.forRoot()` / `.forRootAsync()` (ConfigurableModuleBuilder; `isGlobal` via setExtras)
   - `QueueService`: typed `enqueue` (native `deduplication`), `enqueueBulk`, `getJob`, `getJobs`,
     `getMetrics`, `pauseQueue`/`resumeQueue`/`cleanQueue`, and Job Schedulers
     `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`
   - `@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent` + DiscoveryService wiring
   - `WorkerRegistry` programmatic API incl. `registerSandboxed`
   - opt-in `FlowService` and `MetricsService` (TTL cache)
   - optional OpenTelemetry `telemetry` passthrough (via `bullmq-otel`, optional peer)
   - `QueueLifecycle` bounded graceful-shutdown protocol; at-least-once semantics documented
   - dual-mode connection (BYO ioredis / lib-owned) with per-role `maxRetriesPerRequest` policy
   - subpaths `.` (server) and `./shared` (zero-dep types & constants)
   - E2E tests with Testcontainers Redis
   ```

2. `SECURITY.md` — OpenSSF-style: `security@bymax.one`, 90-day coordinated disclosure, a
   supported-versions table, scope (peer deps out of scope), an OpenSSF Scorecard reference; ask
   reporters NOT to open public issues for vulnerabilities.

3. `CLAUDE.md` and `AGENTS.md` — point to `docs/technical_specification.md`, `docs/development_plan.md`,
   and `docs/tasks/` as required reading; reinforce the universal rules (TS strict,
   English-only, JSDoc on exports, no `any`, no `eslint-disable`, Conventional Commits, timeless
   comments); mirror the structure of the portfolio's `nest-auth` / `nest-logger` agent files.

4. `commitlint.config.cjs`:

   ```javascript
   module.exports = { extends: ['@commitlint/config-conventional'] }
   ```

5. The four Copilot review files:
   - `.github/copilot-instructions.md` — repo-wide review configuration.
   - `.github/instructions/code.instructions.md` — code-review rules (TS strict, no `any`, JSDoc,
     small functions, layered architecture, no `eslint-disable`).
   - `.github/instructions/tests.instructions.md` — test rules (100% line/branch on implemented files,
     one assertion-focused `it` per behavior, no fake mocks hiding real branches).
   - `.github/agents/agent-code-reviewer.agent.md` — the reviewer agent definition.

Constraints:
- English-only; neutral, professional tone. NO claim that the library demonstrates any author's or
  company's seniority/authority.
- Timeless content — NO `Phase N`/`Task`/roadmap references in ANY committed file (the Copilot
  instruction files and agent files are committed config and must be timeless too).
- Follow `/bymax-workflow:standards`.

Verification:
- `ls CHANGELOG.md SECURITY.md CLAUDE.md AGENTS.md commitlint.config.cjs .github/copilot-instructions.md
  .github/instructions/code.instructions.md .github/instructions/tests.instructions.md
  .github/agents/agent-code-reviewer.agent.md` — expected: all present.
- `grep -q '\[0.1.0\]' CHANGELOG.md` — expected: match.
- `grep -qi 'security@bymax.one' SECURITY.md` — expected: match.
- `node -e "require('./commitlint.config.cjs')"` — expected: loads without error.

Completion Protocol:
1. Set status ✅ (per-task block + index). 2. Tick the satisfied acceptance criteria. 3. Update the
index row. 4. Set progress to `2/8`. 5. Update the Phase 5 row in `docs/development_plan.md`.
6. Recompute the overall progress percentage in `docs/development_plan.md`. 7. Append `- 5.2 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 5.3 — CI/CD + supply-chain workflows (ci/codeql/scorecard/osv-scanner/release)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 5.2

#### Description

Author the five GitHub Actions workflows — `ci.yml`, `codeql.yml`, `scorecard.yml`, `osv-scanner.yml`, and `release.yml` — with the hardening posture: SHA-pinned actions, least-privilege `permissions:` per workflow, TruffleHog OSS secret scanning, OSV-Scanner advisory scanning, OpenSSF Scorecard (target ≥ 7.0), and npm publish with provenance via OIDC trusted publishing.

#### Acceptance criteria

- [ ] `ci.yml` (PR + push to `main`): Node 24 + pnpm 11, `install` (`--frozen-lockfile`) → `typecheck` → `lint` → `test:cov:all` (100% line/branch) → `build` → `size` → `test:e2e` (Docker service for the Redis Testcontainer) → **TruffleHog OSS** secret scan → upload coverage to Codecov. Workflow-level least-privilege `permissions: contents: read`.
- [ ] `codeql.yml`: JavaScript/TypeScript analysis on push to `main` + weekly cron; `permissions` widen only to `security-events: write`.
- [ ] `scorecard.yml`: OpenSSF Scorecard on push to `main` + weekly cron, `publish_results: true`, SARIF upload, `persist-credentials: false`; targets a score ≥ 7.0.
- [ ] `osv-scanner.yml`: OSV-Scanner dependency vulnerability scan on PR + weekly cron, failing on new advisories.
- [ ] `release.yml`: tag-driven (`v*.*.*`) → runs `pnpm prepublishOnly` + the mutation gate → `pnpm publish --provenance` (OIDC trusted publishing, `id-token: write`) → creates a GitHub Release from the changelog. No long-lived `NPM_TOKEN`.
- [ ] **Every** third-party action is pinned by commit SHA; each workflow declares least-privilege `permissions:`; the workflows are valid YAML and green on the current tree.
- [ ] No phase/task references inside any workflow file.

#### Files to create / modify

- `.github/workflows/ci.yml`
- `.github/workflows/codeql.yml`
- `.github/workflows/scorecard.yml`
- `.github/workflows/osv-scanner.yml`
- `.github/workflows/release.yml`

#### Agent prompt

````
You are a senior CI/CD + supply-chain engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS/BullMQ module published to npm. The supply chain is
part of the threat model: SHA-pinned actions, least-privilege permissions, secret scanning, advisory
scanning, OpenSSF Scorecard transparency, and OIDC provenance on publish. Node >= 24, pnpm 11.
100% line/branch coverage is a hard PR gate; Stryker `break 95` is the pre-release gate.

CURRENT PHASE: 5 (Release) — Task 5.3 of 8 (MIDDLE)

PRECONDITIONS
- Phases 1–4 are done: the library builds, lints, type-checks, and passes its unit + E2E suites.
- Task 5.2 produced `commitlint.config.cjs` and the governance files. The `package.json` scripts
  (`typecheck`, `lint`, `test:cov:all`, `build`, `size`, `test:e2e`, `prepublishOnly`, `release`)
  exist from Phase 1.

REQUIRED READING (only these sections):
- `docs/technical_specification.md` § 19.1 "Workflows" (the five-workflow table + each workflow's
  responsibility) + § 19.2 "Hardening" (SHA-pinning, least-privilege, TruffleHog, provenance/OIDC).
- `docs/development_plan.md` § 6.3 (the per-workflow step detail + acceptance criteria).
- `docs/technical_specification.md` § 18 "Testing Strategy and Quality Gates" (the gates `ci.yml` runs).

TASK
Author the five GitHub Actions workflows with the full hardening posture.

DELIVERABLES

1. `.github/workflows/ci.yml` — triggers `pull_request` + `push` to `main`; workflow-level
   `permissions: { contents: read }`; `concurrency` with `cancel-in-progress: true`; Node 24 + pnpm 11.
   Steps: `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm lint` → `pnpm test:cov:all`
   (100% line/branch) → `pnpm build` → `pnpm size` → `pnpm test:e2e` (a Docker service / Testcontainers
   Redis) → a **TruffleHog OSS** secret-scan step → upload coverage to Codecov. Pin every action by SHA.

2. `.github/workflows/codeql.yml` — JavaScript/TypeScript CodeQL on push to `main` + weekly cron;
   `permissions: { security-events: write, contents: read }`.

3. `.github/workflows/scorecard.yml` — OpenSSF Scorecard on push to `main` + weekly cron;
   `permissions: { security-events: write, id-token: write, contents: read }`; `publish_results: true`;
   SARIF upload; `persist-credentials: false`. Target a score ≥ 7.0.

4. `.github/workflows/osv-scanner.yml` — OSV-Scanner on PR + weekly cron; `permissions: { contents: read }`;
   fail on new advisories.

5. `.github/workflows/release.yml` — tag-driven (`v*.*.*`) + `workflow_dispatch`;
   `concurrency: { group: release, cancel-in-progress: false }`; workflow-level `permissions: contents: read`;
   the publish job widens to `id-token: write` (and `contents: write` for the GitHub Release). Steps:
   `pnpm prepublishOnly` → the Stryker mutation gate (`pnpm mutation`, `break 95`) → `pnpm publish --provenance`
   (OIDC trusted publishing — NO `NPM_TOKEN`) → create a GitHub Release from the matching `CHANGELOG.md` section.

Constraints:
- Pin EVERY third-party action by commit SHA (not a moving tag) — required for the Scorecard
  Pinned-Dependencies check. Least-privilege `permissions:` at workflow level; widen per job only.
- OIDC trusted publishing only — no long-lived `NPM_TOKEN` baked into the repo.
- Timeless content — NO phase/task references in any workflow. English-only.
- Follow `/bymax-workflow:standards`.

Verification:
- `actionlint .github/workflows/*.yml` (or `yamllint`) — expected: valid.
- `grep -RInE 'uses: .*@[0-9a-f]{40}' .github/workflows | wc -l` — expected: ≥ the number of
  third-party action uses (every action SHA-pinned).
- `grep -RIn 'permissions:' .github/workflows/*.yml` — expected: each workflow declares permissions.
- `grep -q 'provenance' .github/workflows/release.yml` — expected: match.
- `grep -qi 'trufflehog' .github/workflows/ci.yml` — expected: match.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick acceptance criteria. 3. Update the index row. 4. Progress `3/8`.
5. Update the Phase 5 row in `docs/development_plan.md`. 6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append `- 5.3 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 5.4 — Bundle budget + size gate (`scripts/check-size.mjs`)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: S
- **Depends on**: 4.7

#### Description

Implement the `scripts/check-size.mjs` bundle-size gate: read the built `dist/server/index.mjs` and `dist/shared/index.mjs`, compress each with Node's built-in brotli, compare to the budgets (`server: 18_432` = 18 KiB; `shared: 2_500`), print a formatted line, and exit non-zero when a budget is exceeded.

#### Acceptance criteria

- [ ] `scripts/check-size.mjs` reads `dist/server/index.mjs` + `dist/shared/index.mjs`, brotli-compresses each via the Node builtin (`zlib.brotliCompressSync`), compares to budgets `server: 18_432` and `shared: 2_500`, and `process.exit(1)` on any overage.
- [ ] `pnpm size` passes on the current bundle (`bullmq`/`ioredis`/`@nestjs/*` are external and not in the bundle).
- [ ] A deliberate failure (e.g. adding ~500 LoC of garbage strings) is detected and fails the gate.
- [ ] Output is formatted, e.g. `server: 8,432 B brotli (budget 18,432 = 18 KiB) — OK`.
- [ ] The script is wired as the `size` npm script and runs in `ci.yml`.

#### Files to create / modify

- `scripts/check-size.mjs`
- `package.json` (confirm the `size` script points at it)

#### Agent prompt

````
You are a senior Node/build engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a small, public NestJS/BullMQ module. Bundle size is a hard gate:
the server subpath must stay ≤ 18 KiB brotli and the shared subpath ≤ 2.5 KiB brotli, with
bullmq/ioredis/@nestjs kept external. Node >= 24, pnpm 11.

CURRENT PHASE: 5 (Release) — Task 5.4 of 8 (MIDDLE)

PRECONDITIONS
- Phase 1 produced `tsup.config.ts` (two entries: `server`, `shared`; externals include bullmq +
  ioredis + @nestjs) and a `size` npm script placeholder. `pnpm build` emits `dist/server/index.mjs`
  and `dist/shared/index.mjs`.

REQUIRED READING (only these sections):
- `docs/development_plan.md` § 6.4 (the size-gate implementation + acceptance criteria) and § 2.1
  (the `check-size.mjs` budgets note: server 18_432 brotli, shared 2_500 brotli).
- `docs/technical_specification.md` § 14 (the externals/subpath model so the script measures the
  right artefacts).

TASK
Implement the `scripts/check-size.mjs` bundle-size gate.

DELIVERABLES

1. `scripts/check-size.mjs` — ESM script that:
   - Defines budgets: `{ server: 18_432, shared: 2_500 }` (bytes, brotli).
   - For each, reads `dist/<name>/index.mjs`, brotli-compresses with `zlib.brotliCompressSync`, and
     compares to the budget.
   - Prints one formatted line per entry, e.g. `server: 8,432 B brotli (budget 18,432 = 18 KiB) — OK`.
   - Exits `1` if any entry exceeds its budget (after printing all results so the report is complete).

   Sketch:

   ```javascript
   import { readFileSync } from 'node:fs'
   import { brotliCompressSync } from 'node:zlib'

   const BUDGETS = { server: 18_432, shared: 2_500 }
   let failed = false
   for (const [name, budget] of Object.entries(BUDGETS)) {
     const raw = readFileSync(`dist/${name}/index.mjs`)
     const size = brotliCompressSync(raw).length
     const ok = size <= budget
     failed ||= !ok
     console.log(`${name}: ${size.toLocaleString()} B brotli (budget ${budget.toLocaleString()}) — ${ok ? 'OK' : 'OVER'}`)
   }
   process.exit(failed ? 1 : 0)
   ```

2. Confirm `package.json` `"size": "node scripts/check-size.mjs"` and that `ci.yml` runs `pnpm size`.

Constraints:
- English-only; timeless comments (no phase/task references). No external dependencies — use Node
  builtins only. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm build && pnpm size` — expected: exits 0 and prints `server: … — OK` and `shared: … — OK`.
- Temporarily appending a large constant string to a source file, rebuilding, and re-running `pnpm size`
  — expected: exit 1 with `OVER` (revert the change afterwards).

Completion Protocol:
1. Status ✅ (block + index). 2. Tick acceptance criteria. 3. Update the index row. 4. Progress `4/8`.
5. Update the Phase 5 row in `docs/development_plan.md`. 6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append `- 5.4 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 5.5 — Mutation gate run (Stryker `break 95`) + mutation docs

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 4.7

#### Description

Run the Stryker mutation gate (`break 95`, high 99, low 95, target 100%) across the core logic and document the methodology in `docs/mutation_testing_plan.md` and the outcome (score, surviving mutants, justifications) in `docs/mutation_testing_results.md`.

#### Acceptance criteria

- [ ] `stryker.config.json` thresholds are `{ high: 99, low: 95, break: 95 }`, using `jest.stryker.config.ts` as the test runner config.
- [ ] `pnpm mutation` runs to completion and meets `break 95` (no surviving mutant drops the score below 95).
- [ ] `docs/mutation_testing_plan.md` documents the methodology: which files are mutated (the logic-bearing services/resolver/validators/decorators), the runner config, the thresholds, the memory caps (`maxWorkers: '50%'`), and the rule that mutation is a pre-release gate (not per-commit).
- [ ] `docs/mutation_testing_results.md` records the achieved score, the surviving mutants (if any) with a justification or follow-up, and the date/commit of the run.
- [ ] The mutation gate is wired into `release.yml` (from Task 5.3) as a pre-publish step.

#### Files to create / modify

- `docs/mutation_testing_plan.md`
- `docs/mutation_testing_results.md`
- `stryker.config.json` (confirm thresholds), `jest.stryker.config.ts` (confirm runner)

#### Agent prompt

````
You are a senior test/quality engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS/BullMQ module with 100% line/branch coverage on
implemented files. Mutation testing (Stryker) is the PRE-RELEASE gate: `break 95` (high 99, low 95),
targeting 100% — it runs in the release pipeline and on demand, never per-commit. Node >= 24, pnpm 11.

CURRENT PHASE: 5 (Release) — Task 5.5 of 8 (MIDDLE)

PRECONDITIONS
- Phases 1–4 are done: every logic-bearing file has unit tests at 100% line/branch coverage; Phase 4
  established the mutation baseline. `stryker.config.json` and `jest.stryker.config.ts` exist.

REQUIRED READING (only these sections):
- `docs/technical_specification.md` § 18.1 / § 18.2 (the mutation tooling, thresholds, and the
  pre-release-gate + memory-safety policy).
- `docs/development_plan.md` § 1.4 (the per-phase Done criteria) and § 6 Done criteria (mutation score
  recorded in `docs/mutation_testing_results.md`).
- `docs/technical_specification.md` Appendix B (the mutation-score security-checklist item).

TASK
Run the Stryker mutation gate and document the methodology + results.

DELIVERABLES

1. Confirm `stryker.config.json` thresholds `{ high: 99, low: 95, break: 95 }` and the Jest runner
   (`jest.stryker.config.ts`) with bounded workers (`maxWorkers: '50%'`); run `pnpm mutation` to
   completion (use `NODE_OPTIONS=--max-old-space-size=4096` as a guard if needed).

2. `docs/mutation_testing_plan.md` — the methodology: the mutated file set (the logic-bearing
   services, `ConnectionResolver`, validators, decorators), the runner config, the thresholds, the
   memory caps, and the rule that mutation is a PRE-RELEASE gate (slow; not per-commit).

3. `docs/mutation_testing_results.md` — the achieved score (overall + per-file if useful), the list of
   surviving mutants with a one-line justification or a follow-up note for each, and the run's
   date/commit SHA.

4. Confirm the mutation gate is wired into `release.yml` (Task 5.3) as a pre-publish step.

Constraints:
- Run the suite SEQUENTIALLY in a single agent with bounded workers — do NOT fan out parallel test
  agents (memory safety with the local library dependency).
- English-only; timeless content (the docs may reference doc sections, never plan phases).
  Follow `/bymax-workflow:standards`.

Verification:
- `pnpm mutation` — expected: completes and reports a score ≥ 95 (gate `break 95` does not trip).
- `grep -q '"break": 95' stryker.config.json` — expected: match.
- `ls docs/mutation_testing_plan.md docs/mutation_testing_results.md` — expected: both present.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick acceptance criteria. 3. Update the index row. 4. Progress `5/8`.
5. Update the Phase 5 row in `docs/development_plan.md`. 6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append `- 5.5 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 5.6 — `nest-queue-example` dogfood app

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: L
- **Depends on**: 5.1, 5.3

#### Description

Build the `nest-queue-example` dogfood application that consumes the published surface end-to-end — Mode A with `@bymax-one/nest-cache`, a `@Processor`, a Job Scheduler, a flow, and a `/health` queue endpoint — and runs in CI before a release is finalized so a contract change that breaks a consumer fails CI.

#### Acceptance criteria

- [ ] The example wires `BymaxQueueModule.forRootAsync()` in **Mode A**, injecting a BullMQ-dedicated `ioredis` client from `@bymax-one/nest-cache` (`{ client: queueRedis }`).
- [ ] It contains at least one `@Processor` + `@Process` handler, one Job Scheduler registered via `upsertJobScheduler` (cron or interval), one flow via the opt-in `FlowService`, and a `/health` endpoint that returns queue metrics.
- [ ] The example builds and (where a Redis service is available) runs register-style enqueue → process happy paths; it is built + linted in a dedicated CI job so it cannot rot.
- [ ] The example consumes the package by its public subpaths (`@bymax-one/nest-queue`, `@bymax-one/nest-queue/shared`), not deep imports.
- [ ] The example is demonstration code (not published); a short README documents how to run it; timeless comments, no phase/task references.

#### Files to create / modify

- `examples/nest-queue-example/` (a runnable NestJS app + `README.md`)
- `.github/workflows/ci.yml` (an example build+lint job)

#### Agent prompt

````
You are a senior NestJS engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS/BullMQ module. The dogfood example consumes the
published surface end-to-end and runs in CI so a contract change that breaks a consumer fails the
build. It mirrors the recommended Mode-A integration with @bymax-one/nest-cache. Node >= 24, pnpm 11.

CURRENT PHASE: 5 (Release) — Task 5.6 of 8 (MIDDLE)

PRECONDITIONS
- Phases 1–4 are done: the full library (module, QueueService, decorators, FlowService, MetricsService)
  is implemented. Task 5.1 produced the README the example mirrors; Task 5.3 produced `ci.yml`.

REQUIRED READING (only these sections):
- `docs/technical_specification.md` § 19.4 "Dogfood example" (the exact consumer shape: Mode A with
  nest-cache, a @Processor, a Job Scheduler, a flow, a /health endpoint).
- `docs/technical_specification.md` § 21 (the differentiators the example demonstrates) and § 14
  (the subpaths the example imports).

TASK
Build the `nest-queue-example` dogfood app and wire its build+lint into CI.

DELIVERABLES

1. `examples/nest-queue-example/` — a runnable NestJS app that:
   - Wires `BymaxQueueModule.forRootAsync()` in Mode A, injecting a BullMQ-dedicated `ioredis` client
     from `@bymax-one/nest-cache` (`useFactory: (queueRedis) => ({ connection: { client: queueRedis } })`).
   - Defines a `@Processor('email')` + `@Process()` handler.
   - Registers one Job Scheduler via `QueueService.upsertJobScheduler` (cron or interval).
   - Defines one flow via the opt-in `FlowService`.
   - Exposes a `/health` endpoint returning `QueueService.getMetrics(...)`.
   - Imports the library by its public subpaths only (`@bymax-one/nest-queue`,
     `@bymax-one/nest-queue/shared`) — no deep imports.
   - Carries a short `README.md` describing how to run it (with a local Redis).

2. `.github/workflows/ci.yml` — add a dedicated job that builds + lints `examples/nest-queue-example`
   so the example cannot rot (a breaking public-API change fails CI).

Constraints:
- The example is demonstration code (NOT published). English-only; timeless comments; NO phase/task
  references; NO marketing about author/company seniority. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm --filter nest-queue-example build` (or `pnpm build` inside the example) — expected: builds.
- `pnpm --filter nest-queue-example lint` — expected: clean.
- `grep -q '@bymax-one/nest-queue' examples/nest-queue-example/package.json` — expected: match.
- `grep -q 'upsertJobScheduler' -r examples/nest-queue-example/src` — expected: match.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick acceptance criteria. 3. Update the index row. 4. Progress `6/8`.
5. Update the Phase 5 row in `docs/development_plan.md`. 6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append `- 5.6 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 5.7 — BullMQ v6 promotion notes (CHANGELOG version policy + README limitations)

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: S
- **Depends on**: 5.1, 5.2

#### Description

Document the BullMQ version policy and the v5 → v6 promotion strategy: a "BullMQ version policy" section in `CHANGELOG.md` and a corresponding note in the README "Limitations" section. The library already builds exclusively on Job Schedulers (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`) and never on the removed `addRepeatable`/`removeRepeatable` API, so it is forward-compatible with v6 by design.

#### Acceptance criteria

- [ ] `CHANGELOG.md` contains a "BullMQ version policy" section stating: the `0.1.x` floor is `bullmq ^5.16.0` (where Job Schedulers landed; current release `5.79.1`); the library is forward-compatible with v6 because it uses Job Schedulers (not the removed repeatable API); promotion to `^5.16.0 || ^6.0.0` is additive once the E2E suite is green on the v5 + v6 matrix.
- [ ] The README "Limitations" section references the v5 → v6 promotion plan and points to the CHANGELOG policy.
- [ ] The note explains the fallback: if some other API breaks in v6 without a trivial adapter, a parallel `v6` branch keeps `0.1.x`/`0.2.x` on `^5.16` only.
- [ ] Timeless content; no phase/task references.

#### Files to create / modify

- `CHANGELOG.md` (add the "BullMQ version policy" section)
- `README.md` (augment the "Limitations" section)

#### Agent prompt

````
You are a senior maintainer / release engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS/BullMQ module. The BullMQ floor is `^5.16.0` (where
the Job Schedulers API landed; current release 5.79.1). Because the library uses Job Schedulers
(`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`) and never the removed
`addRepeatable`/`removeRepeatable` API, it is forward-compatible with BullMQ v6 by design.

CURRENT PHASE: 5 (Release) — Task 5.7 of 8 (MIDDLE)

PRECONDITIONS
- Task 5.1 produced `README.md` (with a "Limitations" section). Task 5.2 produced `CHANGELOG.md`.
  This task augments both — no source code.

REQUIRED READING (only these sections):
- `docs/development_plan.md` § 6.5 "BullMQ v6 promotion strategy (release notes)".
- `docs/technical_specification.md` § 14.5 "Decision on BullMQ version (v5 → v6)" and § 20.2
  "BullMQ engine compatibility".

TASK
Add the BullMQ version policy to the CHANGELOG and the v6 promotion note to the README.

DELIVERABLES

1. `CHANGELOG.md` — a "BullMQ version policy" section:
   - `0.1.x` floors `peerDependencies.bullmq = "^5.16.0"` (Job Schedulers; current release `5.79.1`).
   - The library is forward-compatible with v6 because it uses Job Schedulers, not the removed
     `addRepeatable`/`removeRepeatable` API — no public-API break is expected on promotion.
   - Promotion to `^5.16.0 || ^6.0.0` is additive, triggered once the E2E suite is green on the
     v5 + v6 matrix.
   - Fallback: if some other API breaks in v6 without a trivial adapter, a parallel `v6` branch keeps
     `0.1.x`/`0.2.x` on `^5.16` only.

2. `README.md` — in the "Limitations" section, reference the v5 → v6 promotion plan and point readers
   to the CHANGELOG "BullMQ version policy" section.

Constraints:
- English-only; timeless content (no phase/task references). Factual, neutral tone — no claims about
  author/company seniority. Follow `/bymax-workflow:standards`.

Verification:
- `grep -qi 'BullMQ version policy' CHANGELOG.md` — expected: match.
- `grep -q '\^5.16.0' CHANGELOG.md` — expected: match.
- `grep -qi 'v6' README.md` — expected: match (the promotion note in Limitations).

Completion Protocol:
1. Status ✅ (block + index). 2. Tick acceptance criteria. 3. Update the index row. 4. Progress `7/8`.
5. Update the Phase 5 row in `docs/development_plan.md`. 6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append `- 5.7 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 5.8 — Publish `v0.1.0` (tag → release workflow → verify npm)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7

#### Description

Cut the `0.1.0` release: verify a pristine state with every gate green, bump the version, commit, tag `v0.1.0`, push so `release.yml` publishes with provenance via OIDC, then verify the package on npm (metadata, provenance badge) and the GitHub Release.

#### Acceptance criteria

- [ ] Pre-flight: `git status` clean and `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm test:e2e && pnpm build && pnpm size` all green.
- [ ] Version bumped to `0.1.0` (`npm version 0.1.0 --no-git-tag-version`), `package.json` + `CHANGELOG.md` committed with a `chore(release): v0.1.0` Conventional Commit, tag `v0.1.0` created and pushed.
- [ ] `release.yml` runs on the tag and publishes via `pnpm publish --provenance` (OIDC trusted publishing).
- [ ] `npm view @bymax-one/nest-queue@0.1.0` returns metadata; the provenance attestation/badge appears on the npm package page.
- [ ] A GitHub Release `v0.1.0` is created with the changelog notes; the `v0.1.0` tag exists in the repo.
- [ ] All Phase 5 Done criteria are satisfied (docs + CI green + bundle within budget + mutation score recorded).

#### Files to create / modify

- `package.json` (version bump to `0.1.0`)
- `CHANGELOG.md` (finalize the `0.1.0` date)

#### Agent prompt

````
You are a senior release engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS/BullMQ module published to npm with provenance via
OIDC trusted publishing (no long-lived NPM_TOKEN). Node >= 24, pnpm 11. Conventional Commits drive
the semver bump.

CURRENT PHASE: 5 (Release) — Task 5.8 of 8 (LAST)

PRECONDITIONS
- Tasks 5.1–5.7 are done: README, governance files, the five workflows (incl. `release.yml`), the
  size gate, the mutation gate + docs, the dogfood example, and the BullMQ version policy all exist.
- `release.yml` is tag-driven (`v*.*.*`) and publishes with `--provenance` via OIDC.

REQUIRED READING (only these sections):
- `docs/development_plan.md` § 6.6 "Publish v0.1.0" (the validated command sequence + acceptance
  criteria) and § 6 "Done criteria — Phase 5".
- `docs/technical_specification.md` § 19.1 (`release.yml`) + § 19.2 (provenance/OIDC, publish token).

TASK
Cut and publish the `0.1.0` release, then verify it.

DELIVERABLES (sequence)

1. Verify a pristine state:

   ```bash
   git status                          # clean
   pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm test:e2e && pnpm build && pnpm size
   ```

2. Bump + commit:

   ```bash
   npm version 0.1.0 --no-git-tag-version
   git add package.json CHANGELOG.md
   git commit -m "chore(release): v0.1.0"
   ```

3. Tag + push (branch first if on the default branch; never commit on the default branch directly):

   ```bash
   git tag v0.1.0
   git push origin <branch> --tags
   ```

4. Let `release.yml` publish with `--provenance` (OIDC). Then verify:
   - `npm view @bymax-one/nest-queue@0.1.0` returns metadata.
   - The provenance badge appears on the npm package page.
   - The GitHub Release `v0.1.0` exists with the changelog notes (use the `gh` CLI to inspect).

Constraints:
- OIDC trusted publishing only — no `NPM_TOKEN` in the repo. Conventional Commit for the release.
- Do NOT add a `Co-Authored-By` / AI-attribution trailer to the release commit.
- English-only; timeless content. Follow `/bymax-workflow:standards`.

Verification:
- `git tag --list v0.1.0` — expected: `v0.1.0`.
- `npm view @bymax-one/nest-queue@0.1.0 version` — expected: `0.1.0`.
- `gh release view v0.1.0 --repo bymaxone/nest-queue` — expected: the release with changelog notes.

Completion Protocol:
1. Set status ✅ in the per-task block and the task index. 2. Tick the acceptance criteria.
3. Update the index row. 4. Set progress to `8/8`. 5. Update the Phase 5 row in
`docs/development_plan.md` (mark ✅ when all eight tasks are done). 6. Recompute the overall progress percentage in `docs/development_plan.md` —
and mark the project's release complete. 7. Append `- 5.8 ✅ <YYYY-MM-DD> — <summary>`.
````

---

## Completion log

> Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`.
