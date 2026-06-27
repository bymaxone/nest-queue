# Phase 3 — Flows, Job Schedulers, Deduplication, Telemetry & Metrics

> **Status**: 🔄 In Progress · **Progress**: 1 / 6 tasks · **Last updated**: 2026-06-27
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § Phase 3
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md)

---

## Context

Phases 1 and 2 are done. The package already ships:

- **Phase 1 (Foundation)** — the project scaffold, the `./shared` subpath (`JobStatus`, `QueueMetrics`, `JobSchedulerRepeatOptions`, `JOB_STATUS`, `QUEUE_ERROR_CODES`), the public interfaces, the DI tokens (`Symbol`), `ConnectionResolver` (dual-mode A/B with the per-role `maxRetriesPerRequest` policy), `applyDefaults`/`validateOptions`, the base `QueueService` (queue cache + `enqueue`/`enqueueBulk`/`getJob`/`getJobs`/`getMetrics`/`pauseQueue`/`resumeQueue`/`cleanQueue`), and `BymaxQueueModule.forRoot()` built on `ConfigurableModuleBuilder`.
- **Phase 2 (Workers)** — the `@Processor`/`@Process`/`@OnWorkerEvent`/`@OnQueueEvent` decorators, the programmatic `WorkerRegistry` (`register`/`registerSandboxed`/`unregister`/`list`), `DiscoveryService` wiring that creates workers for annotated classes on `onModuleInit`, and concurrency/limiter validation.

Phase 3 adds the **opt-in feature surface** and the cross-cutting passthroughs that make the lib production-complete:

1. `FlowService` — a `FlowProducer` wrapper, activated by `options.flows.enabled`.
2. **Job Schedulers** on `QueueService` — `upsertJobScheduler` / `removeJobScheduler` / `getJobSchedulers`, validated with `cron-parser`. This is the **current** BullMQ recurring-jobs API; the deprecated `addRepeatable` surface (removed in BullMQ v6) never appears.
3. Native **deduplication** options surfaced through `enqueue` (Simple / Throttle / Debounce / keep-last-if-active) — no custom deduplication code, BullMQ does the work.
4. Optional **OpenTelemetry** `telemetry` attached to every `Queue` / `Worker` / `FlowProducer`, with `bullmq-otel` as an **optional** peer dependency.
5. `MetricsService` — an in-memory TTL cache over `getJobCounts()`, activated by `options.metrics.enabled`, plus the documented health-check pattern.

By the end of Phase 3 you can compose hierarchical flows, schedule recurring jobs, deduplicate enqueues, propagate trace spans from `enqueue()` into the handler, and read cached metrics — all with 100% line/branch coverage on every implemented file.

---

## Rules-of-phase

1. **TypeScript strict, zero `any`.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on. BullMQ signatures that leak `any` are re-exported on the lib's public API as `unknown`.
2. **JSDoc on every exported symbol** (class, function, interface, constant), with `@example` where it clarifies usage.
3. **English everywhere** — identifiers, comments, JSDoc, error messages, docs.
4. **Timeless comments** — never reference a roadmap phase, task id, or sprint inside any committed file; explain *what* and *why*, never *which stage created it*.
5. **No suppression** — no `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or `// prettier-ignore`. Fix the cause, not the symptom.
6. **Recurring jobs use the current BullMQ Job Schedulers API only** — `upsertJobScheduler` / `removeJobScheduler` / `getJobSchedulers`. The deprecated `addRepeatable` / `removeRepeatable` / `getRepeatableJobs` / `RepeatableJobOptions` surface must not appear anywhere.
7. **Cron is validated with `cron-parser`, never a hand-rolled regex** — a custom cron regex is incorrect for 6-field (seconds) patterns and is a ReDoS risk.
8. **Deduplication and telemetry are passthroughs, never re-implemented** — the lib forwards BullMQ-native options/instances; it does not invent its own deduplication or tracing.
9. **Opt-in providers do not add overhead when disabled** — `FlowService` and `MetricsService` are always registered (so injecting them never throws `UnknownDependenciesException`) but guard every method with `ensureEnabled()`, throwing `FLOW_DISABLED` / `METRICS_DISABLED` (503) when not activated.
10. **100% line/branch coverage** on every file the phase implements (`jest.coverage.config.ts` → `100/100/100/100`). Mutation testing (Stryker `break 95`, target 100%) runs as a **pre-release** gate, not per task.
11. **Official docs first.** Before touching any BullMQ / `cron-parser` API, re-verify the current official documentation (the exact import for `cron-parser` and the `telemetry` constructor option) — do not code from memory.
12. **Conventional Commits** (`feat:`, `test:`, `docs:`, `refactor:`) — drives the semver bump.
13. **Never create `.gitkeep` / `.keep` or empty-directory placeholders** — directories emerge from real files.

---

## Reference docs

- [`docs/technical_specification.md`](../technical_specification.md) — § 5.4 / § 5.4.1 (deduplication), § 5.6 (`upsertJobScheduler`), § 7 (Flows / `FlowService`), § 8 (Job Schedulers — full), § 9 (Metrics & Health), § 4 (`telemetry` option in `BymaxQueueModuleOptions`), § 1.6 (opt-in extensions activation), § 2.4 (init flow), § 3.3 (subpath exports).
- [`docs/development_plan.md`](../development_plan.md) — § Phase 3 (§ 4.1–4.6), § 1.2 (guiding principles), § 1.4 (per-phase Done criteria).
- `/bymax-workflow:standards` skill — universal TypeScript coding rules (type/lint discipline, JSDoc policy, layered architecture, typed errors, English-only).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 3.1 | FlowService — opt-in FlowProducer wrapper | ✅ Done | P0 | M | 1.5, 1.8 |
| 3.2 | Job Schedulers in QueueService + cron validation util | 📋 ToDo | P0 | M | 1.2, 1.7 |
| 3.3 | Native deduplication options on `enqueue` | 📋 ToDo | P1 | S | 1.7 |
| 3.4 | Telemetry passthrough (OpenTelemetry) to Queue/Worker/FlowProducer | 📋 ToDo | P1 | S | 1.7, 2.2, 3.1 |
| 3.5 | MetricsService — cached getJobCounts + getMetrics delegation + health-check docs | 📋 ToDo | P0 | M | 1.7, 1.8 |
| 3.6 | Index exports + Phase 3 integration tests + validation | 📋 ToDo | P0 | S | 3.1, 3.2, 3.3, 3.4, 3.5 |

> Cross-phase dependencies reference **Phase 1** task IDs: `1.2` (shared types/constants), `1.5` (`ConnectionResolver`), `1.7` (base `QueueService`), `1.8` (`forRoot` + server barrel); and **Phase 2** `2.2` (`WorkerRegistry`).

---

## Tasks

### Task 3.1 — FlowService — opt-in FlowProducer wrapper

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.5 (ConnectionResolver), 1.8 (sync module `forRoot`)

#### Description

Implement `FlowService`, a thin wrapper over the BullMQ `FlowProducer` for hierarchical (parent/child) job graphs. The `FlowProducer` runs on the **main** connection (Mode A received client / Mode B lib-owned), keeping default retries like every Queue role. The provider is always registered but guarded: when `options.flows.enabled !== true`, every method throws `QueueException(FLOW_DISABLED, 503)`.

#### Acceptance criteria

- [x] `FlowService` constructs a `FlowProducer` on the main connection (`ConnectionResolver.getClient()`) only when `enabled === true`.
- [x] `add(flow)` calls `producer.add(flow)`; `addBulk(flows)` calls `producer.addBulk(flows)`; `getProducer()` returns the underlying `FlowProducer`.
- [x] When `enabled === false`, `add` / `addBulk` / `getProducer` each throw `QueueException` with code `FLOW_DISABLED` (status 503).
- [x] `onModuleDestroy` closes the producer when active and is a no-op when inactive (no throw if `close()` rejects).
- [x] The module registers `FlowService` via `useFactory` (injecting `ConnectionResolver`) and exports it.
- [x] No `any` in the public surface; JSDoc on every export.
- [x] 100% line/branch coverage on `flow.service.ts`.

#### Files to create / modify

- `src/server/services/flow.service.ts` (create)
- `src/server/services/flow.service.spec.ts` (create)
- `src/server/bymax-queue.module.ts` (modify — register + export `FlowService`)

#### Agent prompt

````
You are a senior NestJS / TypeScript backend engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ that standardizes job
queues (queue creation, workers, flows, Job Schedulers, the Redis connection lifecycle) inside
a dynamic module with end-to-end strong typing. Published to npm. Zero runtime dependencies;
everything (bullmq, ioredis, @nestjs/*) is a peer dependency.

CURRENT PHASE: 3 — Task 3.1 of 6 (FIRST)

PRECONDITIONS
- Phases 1 and 2 are done. `ConnectionResolver` exists with `getClient(): Redis` and resolves
  the dual-mode connection. `BymaxQueueModule.forRoot()` (ConfigurableModuleBuilder) is wired,
  and `ResolvedQueueOptions` exposes `flows: { enabled: boolean }`. `QueueException` and
  `QUEUE_ERROR_CODES` (including `FLOW_DISABLED`) exist.

REQUIRED READING (only these sections — do not load more):
- `docs/technical_specification.md` § 7 "Flows" (what Flows are, the `FlowService` interface,
  the PDF-pipeline example, the FlowProducer lifecycle — created in onModuleInit on the main
  connection, closed in onModuleDestroy before the queues).
- `docs/technical_specification.md` § 1.6 "Feature categorization" (opt-in extensions: FlowService
  is registered only when flows are enabled — and the implementation note that it is registered
  always but guarded so injecting it never throws UnknownDependenciesException).
- `docs/development_plan.md` § 4.1 "FlowService — opt-in FlowProducer wrapper".

TASK
Implement `FlowService` (a guarded FlowProducer wrapper) and register it in the module.

DELIVERABLES

1. `src/server/services/flow.service.ts`:
   ```typescript
   import { Injectable, OnModuleDestroy } from '@nestjs/common'
   import { FlowJob, FlowProducer, JobNode } from 'bullmq'
   import { ConnectionResolver } from './connection-resolver.service'
   import { QueueException } from '../errors/queue-exception'
   import { QUEUE_ERROR_CODES } from '../constants/error-codes'

   /**
    * Wrapper over the BullMQ `FlowProducer` for hierarchical (parent/child) job graphs.
    * Opt-in: registered always, but every method throws `FLOW_DISABLED` (503) unless
    * `flows.enabled` was set. The producer uses the main connection (Mode A / Mode B).
    */
   @Injectable()
   export class FlowService implements OnModuleDestroy {
     private producer?: FlowProducer
     private readonly enabled: boolean

     constructor(connection: ConnectionResolver, enabled: boolean) {
       this.enabled = enabled
       if (this.enabled) {
         this.producer = new FlowProducer({ connection: connection.getClient() })
       }
     }

     /** Adds a flow tree; the root runs only after all descendants complete successfully. */
     async add<TData = unknown>(flow: FlowJob): Promise<JobNode> { /* ensureEnabled + producer.add */ }

     /** Bulk add — single Redis roundtrip. */
     async addBulk(flows: ReadonlyArray<FlowJob>): Promise<JobNode[]> { /* ensureEnabled + addBulk */ }

     /** Escape hatch — the underlying FlowProducer. */
     getProducer(): FlowProducer { /* ensureEnabled, return producer */ }

     async onModuleDestroy(): Promise<void> { /* if enabled && producer: close().catch(noop) */ }

     private ensureEnabled(): void {
       if (!this.enabled) throw new QueueException(QUEUE_ERROR_CODES.FLOW_DISABLED, 503)
     }
   }
   ```
   Note: store `producer` as optional and narrow it after `ensureEnabled()` (or assert it is set,
   since `ensureEnabled()` guarantees it). Do NOT use a non-null `!` that bypasses strict checks
   in a way the linter rejects — prefer a private getter that throws if unset.

2. `src/server/bymax-queue.module.ts` — register `FlowService` (always, guarded) and export it:
   ```typescript
   providers.push({
     provide: FlowService,
     useFactory: (conn: ConnectionResolver) => new FlowService(conn, resolved.flows.enabled),
     inject: [ConnectionResolver],
   })
   exports.push(FlowService)
   ```

3. `src/server/services/flow.service.spec.ts` — cover: enabled path (`add`/`addBulk`/`getProducer`
   delegate to a mocked FlowProducer), disabled path (every method throws `FLOW_DISABLED`),
   `onModuleDestroy` closes when active and is a no-op when inactive, and `close()` rejection is
   swallowed. Mock `FlowProducer` (e.g. `jest.mock('bullmq')`) so no real Redis is needed.

Constraints:
- TypeScript strict, zero `any`. JSDoc on every export. English-only, timeless comments.
- No suppression comments (`@ts-ignore` / `eslint-disable`). Fix causes.
- Follow `/bymax-workflow:standards` (layered architecture, typed errors, SRP).

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm test src/server/services/flow.service.spec.ts` — expected: green, 100% line/branch.
- `pnpm lint` — expected: no warnings.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `1/6` in the header.
5. Update the Phase 3 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 3.1 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 3.2 — Job Schedulers in QueueService + cron validation util

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.2 (`JobSchedulerRepeatOptions` in `./shared`), 1.7 (base `QueueService`)

#### Description

Add the current BullMQ Job Schedulers API to `QueueService`: `upsertJobScheduler(queueName, schedulerId, repeat, template?)` (idempotent by `schedulerId` via BullMQ's atomic `override: true` upsert), `removeJobScheduler`, and `getJobSchedulers`. Add a validation utility that parses cron with **`cron-parser`** (5- and 6-field) and rejects the invalid `JobSchedulerRepeatOptions` shapes before delegating to BullMQ. The deprecated `addRepeatable` / `removeRepeatable` / `RepeatableJobOptions` surface must not appear.

#### Acceptance criteria

- [ ] `upsertJobScheduler` with a valid **5-field** cron creates a recurring scheduler.
- [ ] `upsertJobScheduler` with a **6-field** (seconds) cron (e.g. `*/30 * * * * *`) is accepted.
- [ ] `upsertJobScheduler` with `{ every: 5000 }` creates an interval scheduler.
- [ ] Calling `upsertJobScheduler` twice with the same `schedulerId` is idempotent (updates in place, no duplicate).
- [ ] `template.name` defaults to `schedulerId`; `template.data` defaults to `{}`.
- [ ] Invalid cron → `QueueException(INVALID_REPEAT_OPTIONS, 400)` with a `reason` (validated via `cron-parser`, never a regex).
- [ ] Both `pattern` and `every`, or neither → error; `every <= 0` → error; past `endDate` → error — all `INVALID_REPEAT_OPTIONS` (400).
- [ ] `removeJobScheduler` returns `true` for an existing scheduler, `false` otherwise.
- [ ] `getJobSchedulers` returns the registered schedulers (paginated `start`/`end`/`asc`).
- [ ] No deprecated repeatable-jobs method appears in the source.
- [ ] 100% line/branch coverage on the validation util and the new `QueueService` methods.

#### Files to create / modify

- `src/server/utils/validate-job-scheduler-options.ts` (create — cron via `cron-parser`)
- `src/server/utils/validate-job-scheduler-options.spec.ts` (create)
- `src/server/services/queue.service.ts` (modify — add the three scheduler methods)
- `src/server/services/queue.service.spec.ts` (modify — scheduler cases)

#### Agent prompt

````
You are a senior NestJS / TypeScript backend engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ that standardizes job queues
inside a dynamic module with end-to-end strong typing. Published to npm. Recurring jobs use the
CURRENT BullMQ Job Schedulers API — the legacy `addRepeatable` API is removed in BullMQ v6 and
must never appear on the public surface.

CURRENT PHASE: 3 — Task 3.2 of 6 (MIDDLE)

PRECONDITIONS
- Phase 1 is done. `QueueService` exists with `getOrCreateQueue<TData, TResult>()` and the queue
  cache. `JobSchedulerRepeatOptions` (a discriminated union: `{ pattern, tz?, limit?, startDate?,
  endDate?, immediately? }` OR `{ every, limit?, offset?, startDate?, endDate? }`) is exported from
  `./shared`. `QueueException` + `QUEUE_ERROR_CODES.INVALID_REPEAT_OPTIONS` (`queue.invalid_repeat_options`)
  exist.

REQUIRED READING (only these sections — do not load more):
- `docs/technical_specification.md` § 8 "Job Schedulers" (FULL: 8.1 supported schedules, 8.2 the
  `JobSchedulerRepeatOptions` interface, 8.3 usage, 8.4 idempotency/listing/removal, 8.5 validation
  rules, 8.6 best practice — register in OnApplicationBootstrap).
- `docs/technical_specification.md` § 5.6 "upsertJobScheduler<TData>() method" (the public signature).
- `docs/development_plan.md` § 4.2 "Job Schedulers ... in QueueService".

OFFICIAL-DOCS-FIRST (mandatory before coding):
- Re-verify the exact `cron-parser` import for the installed version (BullMQ v5 uses
  `CronExpressionParser.parse(pattern, options)`). Use context7 (resolve-library-id → query-docs)
  or the official cron-parser docs. If you do not want to rely on the transitive copy bundled by
  bullmq, add `cron-parser` as a direct dependency at the version bullmq itself uses.
- Re-verify the BullMQ `Queue.upsertJobScheduler` / `removeJobScheduler` / `getJobSchedulers`
  signatures and return types.

TASK
Add the validation utility and the three Job Scheduler methods to `QueueService`.

DELIVERABLES

1. `src/server/utils/validate-job-scheduler-options.ts`:
   ```typescript
   import { CronExpressionParser } from 'cron-parser' // confirm against the installed version
   import type { JobSchedulerRepeatOptions } from '../../shared/types/job-scheduler-options.types'
   import { QueueException } from '../errors/queue-exception'
   import { QUEUE_ERROR_CODES } from '../constants/error-codes'

   /**
    * Validates a Job Scheduler schedule before delegating to BullMQ. Cron patterns are parsed
    * with `cron-parser` (accepts 5-field AND 6-field/seconds expressions) — never a hand-rolled
    * regex, which is incorrect for 6-field patterns and a ReDoS risk.
    * @throws QueueException(INVALID_REPEAT_OPTIONS, 400) when invalid.
    */
   export function validateJobSchedulerOptions(repeat: JobSchedulerRepeatOptions): void {
     // 1. exactly one of `pattern` | `every` (both or neither → error)
     // 2. if pattern: CronExpressionParser.parse(pattern, tz ? { tz } : {}) — catch → error
     // 3. else: every must be > 0
     // 4. if endDate present and <= Date.now() → error (BullMQ rejects a past endDate)
   }
   ```
   Each throw carries `{ reason: '...' }` details, e.g.
   `'exactly one of pattern | every is required'`,
   `'pattern must be a valid cron expression (5- or 6-field)'`,
   `'every must be > 0'`, `'endDate must be in the future'`.

2. `src/server/services/queue.service.ts` — add (import `JobSchedulerRepeatOptions` from
   `../../shared/types/job-scheduler-options.types` and `validateJobSchedulerOptions`):
   ```typescript
   /**
    * Creates or updates a Job Scheduler. Idempotent by `schedulerId` (BullMQ performs an atomic
    * `override: true` upsert), so re-registering on every boot never duplicates the scheduler.
    * Supersedes the deprecated `addRepeatable` API (removed in BullMQ v6).
    * @returns The first scheduled (delayed) Job, or undefined.
    */
   async upsertJobScheduler<TData = unknown, TResult = unknown>(
     queueName: string,
     schedulerId: string,
     repeat: JobSchedulerRepeatOptions,
     template?: { name?: string; data?: TData; opts?: JobsOptions },
   ): Promise<Job<TData, TResult, string> | undefined> {
     validateJobSchedulerOptions(repeat)
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

3. `src/server/utils/validate-job-scheduler-options.spec.ts` — table-driven: valid 5-field,
   valid 6-field/seconds, valid `every`, both pattern+every (error), neither (error), `every <= 0`
   (error), invalid cron string (error), past `endDate` (error), future `endDate` (ok). Assert the
   thrown code is `INVALID_REPEAT_OPTIONS` and the status is 400.

4. `src/server/services/queue.service.spec.ts` — add cases: `upsertJobScheduler` calls
   `queue.upsertJobScheduler` with the resolved template (name default = schedulerId, data default
   = `{}`); idempotent second call hits the same mocked queue; invalid `repeat` throws before any
   queue call; `removeJobScheduler` returns the mocked boolean; `getJobSchedulers` forwards
   pagination args. Mock the BullMQ `Queue`.

Constraints:
- Recurring jobs ONLY via `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` — never
  `addRepeatable`/`removeRepeatable`/`getRepeatableJobs`/`RepeatableJobOptions`.
- Cron via `cron-parser`, NEVER a regex.
- TypeScript strict, zero `any`. JSDoc on every export. English-only, timeless comments.
- No suppression comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm test src/server/utils/validate-job-scheduler-options.spec.ts` — expected: green, 100%.
- `pnpm test src/server/services/queue.service.spec.ts` — expected: green, 100% on new methods.
- `grep -rn "addRepeatable\|removeRepeatable\|getRepeatableJobs\|RepeatableJobOptions" src/` —
  expected: no output (the deprecated API is absent).
- `pnpm lint` — expected: no warnings.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `2/6` in the header.
5. Update the Phase 3 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 3.2 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 3.3 — Native deduplication options on `enqueue`

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: S
- **Depends on**: 1.7 (base `QueueService`)

#### Description

`QueueService.enqueue` already forwards BullMQ's per-job `options` (including `jobId` and `deduplication`). This task makes deduplication a **documented, tested first-class feature**: enrich the `enqueue` JSDoc with the four deduplication modes, and add tests proving each mode collapses duplicate enqueues. No custom deduplication code is written — BullMQ owns the behavior; the deduplication key is independent of `jobId`.

#### Acceptance criteria

- [ ] `enqueue` JSDoc documents the four BullMQ deduplication modes and the `{ id, ttl?, extend?, replace?, keepLastIfActive? }` option shape, with an `@example`.
- [ ] Test: **Simple** `{ id }` — a second enqueue while the first is in-flight does not create a second job.
- [ ] Test: **Throttle** `{ id, ttl }` — duplicates within `ttl` are ignored.
- [ ] Test: **Debounce** `{ id, ttl, extend: true, replace: true }` — only the latest data is kept; the TTL resets per duplicate.
- [ ] Test: **keep-last-if-active** `{ id, keepLastIfActive: true }` — the latest data is stored while a job is active.
- [ ] Tests assert that `enqueue` forwards `options.deduplication` to `Queue.add` unchanged (no transformation by the lib).
- [ ] The deduplication key is shown to be independent of `jobId` (a test sets one without the other).
- [ ] No custom deduplication logic exists in the lib (verified by inspection).

#### Files to create / modify

- `src/server/services/queue.service.ts` (modify — `enqueue` JSDoc only; no behavior change)
- `src/server/services/queue.service.spec.ts` (modify — deduplication passthrough cases)

#### Agent prompt

````
You are a senior NestJS / TypeScript backend engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. Deduplication is a
first-class, documented passthrough: the lib surfaces BullMQ's native `deduplication` option on
`enqueue` and never re-implements deduplication.

CURRENT PHASE: 3 — Task 3.3 of 6 (MIDDLE)

PRECONDITIONS
- Phase 1 is done. `QueueService.enqueue(queueName, jobName, data, options?)` already forwards
  `options` straight to `Queue.add(jobName, data, options)`. No code change to behavior is needed —
  this task adds documentation and tests only.

REQUIRED READING (only these sections — do not load more):
- `docs/technical_specification.md` § 5.4 "enqueue<TData, TResult>() method" and § 5.4.1
  "Idempotency and deduplication" (the four modes table: Simple `{ id }`, Throttle `{ id, ttl }`,
  Debounce `{ id, ttl, extend: true, replace: true }`, keep-last-if-active `{ id, keepLastIfActive:
  true }`; the deduplication key is independent of `jobId`; inspect/clear with native
  `getDeduplicationJobId` / `removeDeduplicationKey`).
- `docs/development_plan.md` § 4.5 "Deduplication ... (native, no custom code)".

TASK
Document the deduplication modes on `enqueue` and prove each one with tests. Do NOT add any custom
deduplication logic.

DELIVERABLES

1. `src/server/services/queue.service.ts` — enrich the `enqueue` JSDoc to document the four modes
   and the option shape `{ id, ttl?, extend?, replace?, keepLastIfActive? }`, with an `@example`:
   ```typescript
   /**
    * Adds a job to the queue. `options` surfaces BullMQ natives directly — including `jobId`
    * (idempotent insert) and `deduplication` (windowed deduplication). The lib writes no deduplication code;
    * BullMQ owns the behavior. The deduplication key is independent of `jobId`.
    *
    * Deduplication modes (BullMQ `deduplication: { id, ttl?, extend?, replace?, keepLastIfActive? }`):
    *  - Simple `{ id }` — collapse until the in-flight job completes/fails.
    *  - Throttle `{ id, ttl }` — ignore duplicates for `ttl` ms.
    *  - Debounce `{ id, ttl, extend: true, replace: true }` — keep latest data, reset TTL per dup.
    *  - keep-last-if-active `{ id, keepLastIfActive: true }` — store latest while active, then run once.
    *
    * @example Throttle: at most one reindex per term every 5s
    *   await queueService.enqueue('search', 'reindex', { term }, {
    *     deduplication: { id: `reindex:${term}`, ttl: 5_000 },
    *   })
    */
   ```
   Behavior stays exactly `return this.getOrCreateQueue<...>(queueName).add(jobName, data, options)`.

2. `src/server/services/queue.service.spec.ts` — add a `describe('deduplication')` block that
   mocks `Queue.add` and asserts, for each of the four modes, that `enqueue` forwards the exact
   `deduplication` object (and that `jobId` and `deduplication` can be set independently). You do
   NOT need a real Redis for the forwarding assertions; if you also want a behavioral check of
   collapsing, gate it behind the E2E suite (Phase 4) — for THIS unit task, assert passthrough.

Constraints:
- No custom deduplication logic — passthrough only. Do not transform `options`.
- TypeScript strict, zero `any`. JSDoc updated as above. English-only, timeless comments.
- No suppression comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm test src/server/services/queue.service.spec.ts` — expected: green; the deduplication block covers
  all four modes; overall file coverage stays 100%.
- `pnpm lint` — expected: no warnings.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `3/6` in the header.
5. Update the Phase 3 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 3.3 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 3.4 — Telemetry passthrough (OpenTelemetry) to Queue/Worker/FlowProducer

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: S
- **Depends on**: 1.7 (Queue construction in `QueueService`), 2.2 (Worker construction in `WorkerRegistry`), 3.1 (`FlowService`)

#### Description

When `options.telemetry` (a BullMQ `Telemetry`, typically `new BullMQOtel(...)` from the **optional** peer dependency `bullmq-otel`) is configured, attach it to every `Queue`, `Worker`, and `FlowProducer` the lib constructs, so trace context propagates from `enqueue()` into the handler and on to flow children. The instance is read from `ResolvedQueueOptions.telemetry`. `bullmq-otel` stays an optional peer dependency — only required when telemetry is set.

#### Acceptance criteria

- [ ] `QueueService.getOrCreateQueue` passes `telemetry` into the `Queue` constructor when `ResolvedQueueOptions.telemetry` is present, and omits the key when absent.
- [ ] `WorkerRegistry` passes `telemetry` into every `Worker` it constructs when present.
- [ ] `FlowService` passes `telemetry` into the `FlowProducer` when present.
- [ ] When `telemetry` is undefined, no `telemetry` key is set on any constructor options (verified by the constructed-options assertion).
- [ ] `bullmq-otel` remains an **optional** peer dependency in `package.json` (`peerDependenciesMeta.bullmq-otel.optional = true`) and is never imported by the lib.
- [ ] Tests assert the telemetry instance is forwarded to Queue / Worker / FlowProducer constructors.
- [ ] 100% line/branch coverage on the touched branches.

#### Files to create / modify

- `src/server/services/queue.service.ts` (modify — telemetry into `Queue`)
- `src/server/services/worker-registry.service.ts` (modify — telemetry into `Worker`)
- `src/server/services/flow.service.ts` (modify — telemetry into `FlowProducer`)
- `src/server/services/queue.service.spec.ts`, `worker-registry.service.spec.ts`, `flow.service.spec.ts` (modify — passthrough cases)

#### Agent prompt

````
You are a senior NestJS / TypeScript observability engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. Observability is first-class:
the module accepts a BullMQ `Telemetry` instance (OpenTelemetry via `bullmq-otel`) and attaches it
to every Queue/Worker/FlowProducer so spans propagate from enqueue() into the handler. The lib
never imports `bullmq-otel` itself — it is an OPTIONAL peer dependency the consumer installs only
when they configure telemetry.

CURRENT PHASE: 3 — Task 3.4 of 6 (MIDDLE)

PRECONDITIONS
- Phase 1 is done: `QueueService.getOrCreateQueue` builds each `Queue`; `ResolvedQueueOptions`
  carries an optional `telemetry?: Telemetry` (from `BymaxQueueModuleOptions.telemetry`).
- Phase 2 is done: `WorkerRegistry` builds each `Worker`.
- Task 3.1 is done: `FlowService` builds the `FlowProducer`.
- `package.json` already declares `bullmq-otel` as an optional peer dependency.

REQUIRED READING (only these sections — do not load more):
- `docs/technical_specification.md` § 4 "Configuration API" — the `telemetry?: Telemetry` field on
  `BymaxQueueModuleOptions` (opt-in; attached to every Queue and Worker; bullmq-otel is an OPTIONAL
  peer dep) and § 2.4 init flow item 6 ("If a telemetry instance is configured, it is passed to
  every Queue/Worker constructed").
- `docs/development_plan.md` § 4.5 "Telemetry (opt-in OpenTelemetry)" — passed to every
  Queue/Worker/FlowProducer it constructs, read from `ResolvedQueueOptions.telemetry`.

OFFICIAL-DOCS-FIRST (mandatory before coding):
- Re-verify that BullMQ's `QueueOptions`, `WorkerOptions`, and `FlowProducerOptions` accept a
  `telemetry` field and its exact type. Use context7 or the official BullMQ telemetry docs.

TASK
Thread the configured `telemetry` instance into every Queue / Worker / FlowProducer constructor.

DELIVERABLES

1. `src/server/services/queue.service.ts` — in `getOrCreateQueue`, include `telemetry` in the
   `Queue` options only when present (use conditional spread so the key is absent when undefined):
   ```typescript
   const queue = new Queue<TData, TResult>(queueName, {
     connection: this.connection.getClient(),
     prefix: this.options.prefix,
     defaultJobOptions: this.options.defaultJobOptions,
     ...this.options.queueOptions,
     ...(this.options.telemetry ? { telemetry: this.options.telemetry } : {}),
     ...overrides,
   })
   ```

2. `src/server/services/worker-registry.service.ts` — when constructing each `Worker`, include
   `telemetry` from the resolved options the registry already holds, with the same conditional
   spread (key omitted when undefined).

3. `src/server/services/flow.service.ts` — when constructing the `FlowProducer`, include
   `telemetry` when present:
   ```typescript
   this.producer = new FlowProducer({
     connection: connection.getClient(),
     ...(telemetry ? { telemetry } : {}),
   })
   ```
   Pass the telemetry instance into `FlowService` (e.g. an extra constructor arg wired from
   `resolved.telemetry` in the module factory) — keep it optional.

4. Specs — assert, with a mocked BullMQ, that the telemetry instance reaches the Queue / Worker /
   FlowProducer constructor when set, and that no `telemetry` key is present when unset. Use a
   sentinel object as the fake `Telemetry`.

Constraints:
- Passthrough only — never import `bullmq-otel`, never construct a Telemetry yourself.
- Conditional spread so undefined telemetry never sets the key (respects `exactOptionalPropertyTypes`).
- TypeScript strict, zero `any`. JSDoc on changed public behavior. English-only, timeless comments.
- No suppression comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm test src/server/services/queue.service.spec.ts src/server/services/worker-registry.service.spec.ts src/server/services/flow.service.spec.ts`
  — expected: green, 100% on touched branches.
- `grep -rn "bullmq-otel" src/` — expected: no output (the lib never imports it).
- `pnpm lint` — expected: no warnings.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `4/6` in the header.
5. Update the Phase 3 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 3.4 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 3.5 — MetricsService — cached getJobCounts + getMetrics delegation + health-check docs

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.7 (`QueueService.getMetrics` + queue cache), 1.8 (sync module `forRoot`)

#### Description

Implement `MetricsService`: an in-memory TTL cache over `QueueService.getMetrics` (the no-cache base that calls `Queue.getJobCounts`). The service exposes `get(queueName)`, `getAll()`, and `invalidate(queueName?)`, is registered always but guarded (`METRICS_DISABLED`, 503, when `metrics.enabled !== true`), and reads its TTL from `metrics.cacheTtlMs`. `MetricsService` **delegates to** `QueueService.getMetrics` (one direction — no circular dependency). Document the `@nestjs/terminus` health-check pattern in JSDoc (terminus is **not** a dependency).

#### Acceptance criteria

- [ ] `get(queueName)` on a cache miss calls `QueueService.getMetrics` and stores the result with `expiresAt = now + ttlMs`.
- [ ] `get(queueName)` on a cache hit returns the cached value without calling `QueueService`.
- [ ] After `ttlMs` elapses, the next `get` performs a fresh fetch (validated with fake timers).
- [ ] `getAll()` returns metrics for every queue currently cached in `QueueService` (via a `getCachedQueues()` accessor on `QueueService`, added if missing).
- [ ] `invalidate(name)` removes only that entry; `invalidate()` clears the whole cache.
- [ ] When `enabled === false`, every operation throws `QueueException(METRICS_DISABLED, 503)`.
- [ ] `QueueService.getMetrics` remains the no-cache source of truth (no circular dependency on `MetricsService`).
- [ ] `MetricsService` JSDoc includes an `@example` of the consumer-side `HealthIndicator` pattern; `@nestjs/terminus` is not added as a dependency.
- [ ] The module registers `MetricsService` via `useFactory` (injecting `QueueService`) and exports it.
- [ ] 100% line/branch coverage on `metrics.service.ts`.

#### Files to create / modify

- `src/server/services/metrics.service.ts` (create)
- `src/server/services/metrics.service.spec.ts` (create)
- `src/server/services/queue.service.ts` (modify — add `getCachedQueues()` accessor if absent)
- `src/server/bymax-queue.module.ts` (modify — register + export `MetricsService`)

#### Agent prompt

````
You are a senior NestJS / TypeScript backend engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. It exposes basic queue
metrics (job counts) suitable for health checks, with an opt-in TTL cache so a per-second
`/health` poll does not hammer Redis. It does NOT provide history, alerting, or SLA tracking —
that is the consumer's job.

CURRENT PHASE: 3 — Task 3.5 of 6 (MIDDLE)

PRECONDITIONS
- Phase 1 is done. `QueueService.getMetrics(queueName)` is the no-cache implementation that calls
  `Queue.getJobCounts('waiting','active','completed','failed','delayed','paused')` and returns a
  `QueueMetrics` (`{ queue, counts, collectedAt }`). The queue cache (`Map<string, Queue>`) exists.
  `ResolvedQueueOptions` carries `metrics: { enabled: boolean; cacheTtlMs: number }`. `QueueException`
  + `QUEUE_ERROR_CODES.METRICS_DISABLED` exist.

REQUIRED READING (only these sections — do not load more):
- `docs/technical_specification.md` § 9 "Metrics and Health Check" (FULL: 9.1 philosophy, 9.2
  `QueueMetrics`, 9.3 `QueueService.getMetrics` is the no-cache base, 9.4 `MetricsService`
  get/getAll/invalidate with the TTL cache, 9.5 the documented HealthIndicator pattern — terminus
  is NOT a dependency).
- `docs/development_plan.md` § 4.3 "MetricsService — cached getJobCounts" and § 4.4 "Health check
  pattern — documentation".

TASK
Implement `MetricsService` (guarded, TTL-cached), add a `getCachedQueues()` accessor to
`QueueService` if it is not already present, register the service in the module, and document the
health-check pattern in JSDoc.

DELIVERABLES

1. `src/server/services/metrics.service.ts`:
   ```typescript
   import { Injectable } from '@nestjs/common'
   import type { QueueMetrics } from '../../shared/types/queue-metrics.types'
   import { QueueService } from './queue.service'
   import { QueueException } from '../errors/queue-exception'
   import { QUEUE_ERROR_CODES } from '../constants/error-codes'

   interface CacheEntry { metrics: QueueMetrics; expiresAt: number }

   /**
    * Opt-in in-memory TTL cache over `QueueService.getMetrics`. Delegates to QueueService
    * (one direction — no circular dependency). Throws `METRICS_DISABLED` (503) when not enabled.
    *
    * @example Health check pattern (consumer side — @nestjs/terminus, NOT a dependency here)
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
   @Injectable()
   export class MetricsService {
     private readonly cache = new Map<string, CacheEntry>()
     constructor(
       private readonly queueService: QueueService,
       private readonly enabled: boolean,
       private readonly ttlMs: number,
     ) {}

     /** Returns cached metrics or fetches fresh (and caches) on miss/expiry. */
     async get(queueName: string): Promise<QueueMetrics> { /* ensureEnabled; hit/miss logic */ }

     /** Aggregate snapshot across all queues currently cached in QueueService. */
     async getAll(): Promise<readonly QueueMetrics[]> {
       this.ensureEnabled()
       const names = Array.from(this.queueService.getCachedQueues().keys())
       return Promise.all(names.map((n) => this.get(n)))
     }

     /** Force cache invalidation for `queueName`, or all when omitted. */
     invalidate(queueName?: string): void { /* delete or clear */ }

     private ensureEnabled(): void {
       if (!this.enabled) throw new QueueException(QUEUE_ERROR_CODES.METRICS_DISABLED, 503)
     }
   }
   ```

2. `src/server/services/queue.service.ts` — add a read-only accessor if it does not already exist:
   ```typescript
   /** Read-only view of the cached queues (used by MetricsService.getAll). */
   getCachedQueues(): ReadonlyMap<string, Queue> { return this.queues }
   ```

3. `src/server/bymax-queue.module.ts` — register and export:
   ```typescript
   providers.push({
     provide: MetricsService,
     useFactory: (qs: QueueService) =>
       new MetricsService(qs, resolved.metrics.enabled, resolved.metrics.cacheTtlMs),
     inject: [QueueService],
   })
   exports.push(MetricsService)
   ```

4. `src/server/services/metrics.service.spec.ts` — use `jest.useFakeTimers()`: cache miss fetches
   and stores; hit does not re-fetch; expiry triggers a fresh fetch; `getAll` maps over cached
   queue names; `invalidate(name)` removes one; `invalidate()` clears all; disabled → every method
   throws `METRICS_DISABLED`. Mock `QueueService` (`getMetrics`, `getCachedQueues`).

Constraints:
- One-direction delegation: MetricsService → QueueService.getMetrics. Do NOT make QueueService
  depend on MetricsService (avoid a circular dependency).
- Do NOT add `@nestjs/terminus` — the health pattern is documentation only.
- TypeScript strict, zero `any`. JSDoc on every export. English-only, timeless comments.
- No suppression comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm test src/server/services/metrics.service.spec.ts` — expected: green, 100% line/branch.
- `grep -rn "@nestjs/terminus" package.json src/` — expected: no dependency entry (docs only).
- `pnpm lint` — expected: no warnings.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `5/6` in the header.
5. Update the Phase 3 row in `docs/development_plan.md` (status + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 3.5 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 3.6 — Index exports + Phase 3 integration tests + validation

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: S
- **Depends on**: 3.1, 3.2, 3.3, 3.4, 3.5

#### Description

Wire the new opt-in services into the public surface and close the phase: export `FlowService` and `MetricsService` from `src/server/index.ts`, add a small cross-feature smoke test (cron Job Scheduler + cached metrics), and run the full Phase 3 validation gate (typecheck, lint, 100% coverage, build, bundle budget).

#### Acceptance criteria

- [ ] `src/server/index.ts` exports `FlowService` and `MetricsService` (explicit named exports, no deep barrels).
- [ ] `dist/server/index.mjs` exposes `FlowService` and `MetricsService` after `pnpm build`.
- [ ] A smoke test exercises `upsertJobScheduler` (cron, idempotent by `schedulerId`) followed by `MetricsService.get`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size` all pass.
- [ ] 100% line/branch coverage across every file implemented in Phase 3 (`jest.coverage.config.ts` → `100/100/100/100`).
- [ ] Bundle stays ≤ 18 KiB brotli (`scripts/check-size.mjs`).

#### Files to create / modify

- `src/server/index.ts` (modify — export `FlowService`, `MetricsService`)
- `src/server/services/queue.service.spec.ts` / a smoke spec (modify/create — cron scheduler + metrics)

#### Agent prompt

````
You are a senior NestJS / TypeScript backend engineer working on the nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. Two subpaths: `.` (server)
and `./shared`. Exports are explicit (no deep barrel re-exports) for tree-shaking, and the server
bundle budget is ≤ 18 KiB brotli, measured by `scripts/check-size.mjs`.

CURRENT PHASE: 3 — Task 3.6 of 6 (LAST)

PRECONDITIONS
- Tasks 3.1–3.5 are done: `FlowService`, the Job Scheduler methods on `QueueService`, the
  deduplication docs/tests, the telemetry passthrough, and `MetricsService` all exist and are
  registered in the module. `QueueService.upsertJobScheduler` and `MetricsService.get` work.

REQUIRED READING (only these sections — do not load more):
- `docs/technical_specification.md` § 3.3 "Exports per subpath" (the server export list — confirm
  FlowService and MetricsService belong on the public surface; WorkerRegistry is advanced; no deep
  barrels).
- `docs/development_plan.md` § 4.5 "Deduplication, telemetry, index + tests + validation" and
  § 4.6 "Phase 3 validation".

TASK
Export the new opt-in services, add a cross-feature smoke test, and run the full Phase 3 gate.

DELIVERABLES

1. `src/server/index.ts` — add explicit named exports alongside the existing ones:
   ```typescript
   export { FlowService } from './services/flow.service'
   export { MetricsService } from './services/metrics.service'
   ```
   Keep the file barrel-free (explicit re-exports only).

2. A smoke test (extend `queue.service.spec.ts` or add a focused spec) that, against a mocked
   BullMQ, registers a cron Job Scheduler idempotently and then reads cached metrics:
   ```typescript
   // Cron Job Scheduler + metrics (idempotent by schedulerId)
   await queueService.upsertJobScheduler(
     'cleanup', 'nightly',
     { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
     { name: 'cleanup', data: { mode: 'soft' } },
   )
   const metrics = await metricsService.get('cleanup')
   // expect: { queue: 'cleanup', counts: {...}, collectedAt: <ISO> }
   ```

3. Run the full validation gate and fix any gap.

Constraints:
- Explicit exports only — no `export *` deep barrels.
- TypeScript strict, zero `any`. English-only, timeless comments.
- No suppression comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: no warnings.
- `pnpm test:cov:all` — expected: green, 100/100/100/100 on every Phase 3 file.
- `pnpm build` — expected: emits `dist/server/index.{mjs,cjs,d.ts}` and `dist/shared/...`.
- `node -e "import('./dist/server/index.mjs').then(m => { if (!m.FlowService || !m.MetricsService) process.exit(1) })"`
  — expected: exit 0 (both exported).
- `pnpm size` — expected: server bundle ≤ 18 KiB brotli.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `6/6` in the header.
5. Update the Phase 3 row in `docs/development_plan.md` (mark ✅ when all six tasks are done) + Last updated.
6. Recompute the overall progress percentage in `docs/development_plan.md`.
7. Append a completion-log entry: `- 3.6 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

## Completion log

> Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`.

<!-- entries are appended here as tasks complete -->

- 3.1 ✅ 2026-06-27 — FlowService guarded FlowProducer wrapper, registered/exported by the module; 100% coverage.
