# Development Tasks — @bymax-one/nest-queue

> **Last updated:** 2026-06-27
> **Source roadmap:** [`../development_plan.md`](../development_plan.md) (plan rev 2.0.0) · **Spec:** [`../technical_specification.md`](../technical_specification.md) (rev 2.0.0)

Tasks live **one file per phase** in this folder (`docs/tasks/phase-NN-<slug>.md`), following the Bymax task-doc convention (same pattern as `bymax-one/rust-auth`). Each phase file is self-contained: context, rules-of-phase, reference docs, a task index, the tasks (each with an executable **Agent prompt**), and a completion log.

> **Canonical phase status lives in the plan's [Phase dashboard](../development_plan.md#13-phase-dashboard) (§1.3).** This folder index mirrors it for convenience — when a phase/task changes state, update the plan dashboard first, then this table.

---

## Phase files (folder index)

| Phase | File | Tasks | Status |
|---|---|---|---|
| 1 | [`phase-01-foundation.md`](./phase-01-foundation.md) | 8 / 8 | ✅ Done |
| 2 | [`phase-02-workers.md`](./phase-02-workers.md) | 6 / 6 | ✅ Done |
| 3 | [`phase-03-flows-schedulers-metrics.md`](./phase-03-flows-schedulers-metrics.md) | 6 / 6 | ✅ Done |
| 4 | [`phase-04-async-shutdown-e2e.md`](./phase-04-async-shutdown-e2e.md) | 7 / 7 | ✅ Done |
| 5 | [`phase-05-release.md`](./phase-05-release.md) | 0 / 8 | 📋 ToDo |
| | **Total** | **27 / 35** | ✅ 77% |

---

## Status legend

| Emoji | Status | Meaning |
|---|---|---|
| 📋 | ToDo | Not started |
| 🔄 | In Progress | Being worked on |
| 👀 | Review | Implementation done, under review |
| ✅ | Done | Completed and verified (all acceptance criteria met) |
| ⛔ | Blocked | Blocked by a dependency |
| 🟡 | Partial | Some acceptance criteria unmet — never mark a phase ✅ while a §1.4 Global Done criterion is open |

Task sizes: **XS/S** (< ~100 LoC), **M** (~100–250), **L** (~250+). Priorities: **P0** (blocking), **P1** (important), **P2** (nice-to-have).

---

## Execution guidance for AI agents

> **Read this before executing any task.**

### Token economy

1. **Do not load a whole phase file** — jump to your task's anchor (e.g. `#task-2-3`); use `Read` with `offset`/`limit`. The phase files are large (≈ 700–1000 lines each).
2. **Do not load the plan or spec entirely** — each task lists a scoped **REQUIRED READING** with exact `§` sections; read only those.
3. **Do not load sibling repos** (`nest-auth`/`nest-logger`/`nest-cache`/`nest-notification`) entirely — copy only the specific file a task references.

### Phase execution mode (`/bymax-workflow:task phase <N>`)

- Resolve the phase's tasks in dependency order (the `Depends on` column), execute sequentially, and after each task confirm `Status: ✅` was applied. The phase closes when all its tasks are done and every §1.4 Global Done criterion holds.

### Self-update protocol (mandatory at the end of each task)

Update **three** places in the phase file, then the cross-doc rows:

1. The task block's **Status** emoji + tick its acceptance criteria.
2. The phase file's **Task index** row + the header **Progress** counter (`X / Y tasks`).
3. The phase file's **Completion log** (append `- <id> ✅ <YYYY-MM-DD> — <summary>`).
4. The phase row in the [`../development_plan.md` Phase dashboard (§1.3)](../development_plan.md#13-phase-dashboard) — set **Status** + **Last updated**, bump **Progress**, recompute **Overall progress** (phases / 5, tasks / 35) — and this README's folder index.
5. Commit with Conventional Commits: `<type>(queue): <subject> (<phase>.<task>)` — **no `Co-Authored-By` / attribution trailer**.

### Blocked / review

- Blocked → `Status: ⛔`, add `> **Blocker:** …` under the task header, no destructive commit.
- Acceptance fails after 2 red-green cycles → `Status: 👀` + an inline note.

---

## Project-wide constraints (apply to every task)

- **Zero `dependencies`.** `package.json` ships `"dependencies": {}`. `bullmq ^5.16`, `ioredis ^5`, `@nestjs/common ^11`, `@nestjs/core ^11`, `reflect-metadata ^0.2` are **peer** deps; `bullmq-otel ^1` is an **optional** peer. **`@nestjs/bullmq` is NOT a dependency** — this lib provides that role itself.
- **Current BullMQ API only.** Recurring jobs go through `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` — **never** `addRepeatable`/`removeRepeatable` (removed in v6). `cleanQueue(queueName, grace, limit, status?)` mirrors BullMQ `clean(grace, limit, type)`. Cron parsing is delegated to BullMQ (no hand-rolled regex, no `cron-parser` direct dep).
- **Per-role connection policy.** `maxRetriesPerRequest: null` is applied **only** to the duplicated worker/QueueEvents connections (`duplicate({ maxRetriesPerRequest: null })`); the Queue/FlowProducer connection keeps default retries. Mode A fails fast (`queue.connection_requires_null_retries`) if a worker connection cannot be coerced.
- **No `sandboxed` boolean.** Sandboxed processors are file-based and out-of-process (no NestJS DI) — `WorkerRegistry.registerSandboxed({ queueName, processorFile, options })`.
- **Module via `ConfigurableModuleBuilder`.** `forRoot`/`forRootAsync`; `isGlobal` mapped to `DynamicModule.global` via `setExtras`. No hand-written `@Global()`, no `forFeature` stub.
- **At-least-once delivery.** Handlers must be idempotent; tune `lockDuration` above the worst-case runtime; use `jobId`/`deduplication` to collapse duplicate producers.
- **Code-Craft Standard** — TS strict (no `any`); **100% line/branch coverage** per implemented file; mutation **break 95** (high 99, low 95, driven to 100%) as a pre-release gate; functions ≤ 50 lines, files ≤ 800; `@fileoverview` + `@layer` header per file; official-docs-first (context7) before using any library; English-only, timeless comments (no Phase/Task references in committed code/JSDoc).
- **CI green from the first PR** — the five workflows (`ci`/`codeql`/`scorecard`/`osv-scanner`/`release`) are created in **Phase 1** and every per-PR gate is incremental-safe (jest `--passWithNoTests`, coverage on implemented files, size budgets). Mutation is a pre-release gate only; `release.yml` is tag-driven. Every PR must leave CI green.
- **Bundle budgets** — `dist/server/index.mjs` ≤ 18 KiB brotli; `dist/shared/index.mjs` ≤ 2.5 KiB brotli. `bullmq`/`ioredis`/`@nestjs/*` stay external to the bundle.
