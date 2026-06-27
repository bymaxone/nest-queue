# Phase 4 — Async config, graceful shutdown, E2E & mutation baseline

> **Status**: 🔄 In Progress · **Progress**: 3 / 7 tasks · **Last updated**: 2026-06-27
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § Phase 4
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md)

---

## Context

Phases 1–3 are done. The library already has its dynamic module (`BymaxQueueModule.forRoot()` built on `ConfigurableModuleBuilder`), the dual-mode `ConnectionResolver`, the typed `QueueService` (cache + `enqueue`/`enqueueBulk`/`getJob`/`getJobs`/`getMetrics`/`pauseQueue`/`resumeQueue`/`cleanQueue`), the decorator-driven worker layer (`@Processor`/`@Process`/`@OnWorkerEvent`/`@OnQueueEvent` + `WorkerRegistry` + `QueueEventsRegistry` + processor discovery), the opt-in `FlowService` and `MetricsService`, and Job Schedulers (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`) with native deduplication and optional telemetry passthrough. Unit coverage is 100% line/branch on every implemented file.

What is still missing is everything that makes the package **production-safe and proven end-to-end**: factory-based async configuration (`forRootAsync` — required for the canonical `nest-cache` Mode-A integration), an ordered graceful-shutdown service (`QueueLifecycle`) that bounds the in-flight drain and tears down exactly the connections the lib owns, the documented at-least-once / idempotency / dead-letter-queue contract, a real-Redis E2E suite (Testcontainers) covering the seven scenarios from spec §15.5, and a Stryker mutation-testing baseline gating release. This phase delivers all of that and closes with a full quality pass (100% coverage + `break 95` mutation score). **No new public surface is invented beyond what the spec already defines; the work makes the existing surface safe and tested.**

---

## Rules-of-phase

1. **Current BullMQ API only.** Recurring jobs use Job Schedulers (`upsertJobScheduler`); the deprecated `addRepeatable`/`removeRepeatable`/`getRepeatableJobs` API (removed in BullMQ v6) must never appear — not in code, tests, or docs.
2. **`worker.close()` already drains and takes NO timeout argument.** It stops fetching new jobs and resolves once active jobs finish. Bound the wait with `Promise.race([worker.close(), timeout])` and escalate to `worker.close(true)` (force) only on expiry.
3. **At-least-once, never exactly-once.** BullMQ — and therefore this lib — guarantees at-least-once delivery. Handlers must be idempotent; the lib documents this prominently and never implies a stronger guarantee.
4. **Per-role connection policy.** The `Queue`/`FlowProducer` connection keeps ioredis' default retries (so `enqueue` fails fast during a Redis outage); `Worker`/`QueueEvents` connections are duplicated with `maxRetriesPerRequest: null` (required by the blocking commands `BRPOPLPUSH`/`BZPOPMIN`/`BLMOVE`). On shutdown: **Mode B** quits the main client and every duplicated connection; **Mode A** closes only the duplicated worker/QueueEvents connections — never the consumer's shared client.
5. **`ConfigurableModuleBuilder` is the source of truth.** `forRootAsync` extends `super.registerAsync` (the generated async-options provider for `useFactory`/`useClass`/`useExisting`/`inject` under `MODULE_OPTIONS_TOKEN`, with `global` applied by `setExtras`). There is no hand-rolled async-options-provider builder and no hand-written `@Global()` decorator.
6. **Quality floor.** 100% line/branch coverage on every implemented file (`jest.coverage.config.ts` → `100/100/100/100`); Stryker `{ high: 99, low: 95, break: 95 }`, targeting 100%, run as a **pre-release** gate (not per-commit).
7. **Memory-safe tests.** Jest is capped at `maxWorkers: '50%'`; never fan out parallel suites against the local library — a single sequential run only.
8. **TS strict, zero `any`.** No `any` in any signature; BullMQ signatures that use `any` are surfaced as `unknown` on the public API. No suppression comments (`@ts-ignore`, `eslint-disable`).
9. **English-only** and **timeless comments** — no `Phase N`/`Task`/roadmap references inside any committed file (code, config, tests, or docs).
10. **Never create `.gitkeep`/`.keep` or empty-directory placeholders** — `test/e2e/` and its sub-dirs emerge from the real spec/fixture files.
11. **Conventional Commits** for every commit; `/bymax-quality:code-review` run and findings applied before a phase is marked done.

---

## Reference docs

- [`docs/technical_specification.md`](../technical_specification.md) — § 4.2–4.3 (async options + `ConfigurableModuleBuilder` registration), § 10 (Delivery Semantics + Shutdown protocol), § 15.5 (Phase 4 E2E scenarios), § 18 (Testing Strategy & Quality Gates).
- [`docs/development_plan.md`](../development_plan.md) — § 5 "Phase 4" (§5.1–§5.6), § 1.3 Phase summary, § 1.4 Global Done criteria per phase.
- `/bymax-workflow:standards` skill — universal TypeScript coding rules (type/lint discipline, JSDoc policy, layered architecture, typed errors, English-only).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 4.1 | `forRootAsync()` — factory/class/existing async configuration | ✅ Done | P0 | M | 1.8, 3.1, 3.5 |
| 4.2 | `QueueLifecycle` — bounded graceful shutdown | ✅ Done | P0 | L | 1.5, 2.2, 2.3, 3.1 |
| 4.3 | At-least-once semantics & handler idempotency documentation | ✅ Done | P1 | S | 4.2 |
| 4.4 | Dead-letter-queue (DLQ) pattern via `@OnWorkerEvent('failed')` | 📋 ToDo | P1 | S | 4.3 |
| 4.5 | E2E suite with Testcontainers Redis (7 scenarios) | 📋 ToDo | P0 | L | 4.1, 4.2 |
| 4.6 | Mutation-testing baseline (Stryker `break 95`) | 📋 ToDo | P1 | M | 4.5 |
| 4.7 | Phase 4 index exports, lifecycle tests & validation | 📋 ToDo | P0 | M | 4.1–4.6 |

> Cross-phase dependencies reference **Phase 1** `1.5` (`ConnectionResolver`), `1.8` (`forRoot` + barrel); **Phase 2** `2.2` (`WorkerRegistry`), `2.3` (`QueueEventsRegistry`); **Phase 3** `3.1` (`FlowService`), `3.5` (`MetricsService`).

---

## Tasks

### Task 4.1 — `forRootAsync()` — factory/class/existing async configuration

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 1.8 (`forRoot` module + barrel), 3.1 (`FlowService`), 3.5 (`MetricsService`) — the conditional providers `forRootAsync` must wire

#### Description

Add `forRootAsync()` to `BymaxQueueModule` so options can be resolved from a factory (`useFactory` + `inject`), a class (`useClass`), or an existing provider (`useExisting`). This is the registration path the canonical `@bymax-one/nest-cache` Mode-A integration uses (inject `BYMAX_CACHE_QUEUE_REDIS`, return `{ connection: { client } }`). It must register the exact same providers/exports as the synchronous path and apply `global` from `setExtras`.

#### Acceptance criteria

- [x] `forRootAsync({ useFactory: () => ({...}) })` instantiates the full provider graph correctly
- [x] `forRootAsync({ imports: [SomeModule], inject: [SOME_TOKEN], useFactory: (dep) => ({...}) })` integrates with an external module's provider
- [x] `forRootAsync({ useClass: MyOptionsFactory })` registers a `BymaxQueueOptionsFactory` class
- [x] `forRootAsync({ useExisting: MyOptionsFactory })` reuses an existing factory provider
- [x] `forRootAsync({})` (none of `useFactory`/`useClass`/`useExisting`) is rejected by `ConfigurableModuleBuilder`
- [x] Providers/exports identical to `forRoot`; `global` is applied from `setExtras` (the `isGlobal` extra)
- [x] `BYMAX_QUEUE_RESOLVED_OPTIONS` is derived from the async-resolved options (`validateOptions` then `applyDefaults`)
- [x] `ConnectionResolver` is built and `await r.init()` completes before dependent providers resolve
- [x] 100% line/branch coverage on every `forRootAsync` branch

#### Files to create / modify

- `src/server/bymax-queue.module.ts` (add `forRootAsync`)
- `src/server/bymax-queue.module.spec.ts` (async-registration branch tests)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ (typed job queues, workers,
flows, Job Schedulers, graceful shutdown) with a dual-mode Redis connection (Mode A: bring your own
client; Mode B: lib opens its own). Published to npm; peer deps `bullmq ^5.16.0` + `ioredis ^5` +
`@nestjs/common|core ^11`. Recurring jobs use the BullMQ Job Schedulers API (never `addRepeatable`).

CURRENT PHASE: 4 — Task 4.1 of 7 (FIRST)

PRECONDITIONS
- Phases 1–3 are done: `BymaxQueueModule.forRoot()` exists, built on `ConfigurableModuleBuilder`
  (`.setClassMethodName('forRoot').setExtras({ isGlobal: true }, (def, extras) => ({ ...def,
  global: extras.isGlobal }))`), exporting `ConfigurableModuleClass`, `MODULE_OPTIONS_TOKEN`
  (aliased `BYMAX_QUEUE_OPTIONS`), `OPTIONS_TYPE`, `ASYNC_OPTIONS_TYPE`.
- The providers exist: `ConnectionResolver` (with async `init()`), `QueueService`, `WorkerRegistry`,
  `QueueEventsRegistry`, the processor-discovery provider, `FlowService`, `MetricsService`,
  `QueueLifecycle` (added in Task 4.2 — wire it into the providers array now; it is a no-op if the
  service file is still a stub on your branch). `validateOptions` and `applyDefaults` exist in
  `src/server/config/`. `BYMAX_QUEUE_RESOLVED_OPTIONS` token exists.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 4.2 "BymaxQueueModuleAsyncOptions interface" and § 4.3
  "Registration methods" (the `ConfigurableModuleBuilder` block, the `forRoot`/`forRootAsync`
  signatures, and the "no `forFeature` stub" note).
- `docs/development_plan.md` § 5.1 "forRootAsync() implementation" (the additions skeleton).

TASK
Implement `static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule` by extending the
generated async path (`super.registerAsync`/`super.forRootAsync`) — never hand-roll the
options-provider. Merge the lib's own providers and exports on top, deriving the resolved options
and the initialized connection from `MODULE_OPTIONS_TOKEN`.

DELIVERABLES

1. `src/server/bymax-queue.module.ts` — add `forRootAsync`:

   ```typescript
   /**
    * Asynchronous registration. Use when options depend on other modules
    * (ConfigService, BymaxCacheModule, etc.). Mirrors the NestJS standard
    * async dynamic-module pattern (useFactory | useClass | useExisting + inject).
    */
   static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
     const base = super.forRootAsync(options) // generated: options provider + `global` from setExtras

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
         const resolver = new ConnectionResolver(opts)
         await resolver.init()
         return resolver
       },
       inject: [MODULE_OPTIONS_TOKEN],
     }

     // FlowService / MetricsService remain resolved-options-aware factories (parity with forRoot).
     const flowProvider: Provider = { /* useFactory(conn, resolved) => new FlowService(...) */ }
     const metricsProvider: Provider = { /* useFactory(qs, resolved) => new MetricsService(...) */ }

     return {
       ...base,
       imports: [DiscoveryModule, ...(base.imports ?? [])],
       providers: [
         ...(base.providers ?? []),
         { provide: BYMAX_QUEUE_OPTIONS, useExisting: MODULE_OPTIONS_TOKEN },
         resolvedProvider, connectionProvider,
         QueueService, WorkerRegistry, QueueEventsRegistry, /* processor discovery */,
         flowProvider, metricsProvider, QueueLifecycle,
       ],
       exports: [
         QueueService, FlowService, MetricsService, WorkerRegistry, QueueEventsRegistry,
         ConnectionResolver, BYMAX_QUEUE_OPTIONS, BYMAX_QUEUE_RESOLVED_OPTIONS,
       ],
     }
   }
   ```
   Keep the synchronous `forRoot` providers/exports identical — factor the shared provider list into
   a private static helper if it reduces duplication, but do not change `forRoot`'s observable result.

2. `src/server/bymax-queue.module.spec.ts` — async branch tests using `Test.createTestingModule`:
   - `useFactory` (with and without `inject`), `useClass`, `useExisting` each resolve the module and
     `app.get(QueueService)` returns an instance.
   - An external `imports`/`inject` factory receives the injected dependency.
   - `forRootAsync({})` (no factory/class/existing) throws at module build.
   - `global` flag is set on the returned `DynamicModule` (assert via the definition).
   - Mock `ConnectionResolver.init()` and BullMQ so no real Redis is needed (unit scope).

Constraints:
- TS strict, zero `any`; JSDoc on `forRootAsync`. No suppression comments. English-only, timeless.
- Do NOT add a `forFeature` stub. Do NOT hand-write `@Global()`. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: clean.
- `pnpm lint` — expected: no warnings.
- `pnpm test src/server/bymax-queue.module.spec.ts` — expected: all async branches green.
- `pnpm test:cov:all` (module file) — expected: 100% line/branch on `forRootAsync`.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `1 / 7` in the header.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.1 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 4.2 — `QueueLifecycle` — bounded graceful shutdown

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 1.5 (`ConnectionResolver`), 2.2 (`WorkerRegistry`), 2.3 (`QueueEventsRegistry`), 3.1 (`FlowService`) — the resources `QueueLifecycle` must close on shutdown

#### Description

Implement the shutdown protocol from spec §10.2 in a single `OnModuleDestroy` service. Close every worker with a bounded drain (`Promise.race([worker.close(), timeout(drainTimeoutMs)])`, escalating to `worker.close(true)` on timeout and emitting `queue.shutdown_timeout_exceeded`), close every `QueueEvents`, optionally `queue.drain()` when `drainOnShutdown` is set, close the `FlowProducer`, close every cached `Queue`, then tear down the connection (Mode B quits the main client and all duplicated connections; Mode A closes only the duplicated worker/QueueEvents connections — never the consumer's shared client). Emit a structured shutdown-metrics log (total time, forced/drained worker count).

#### Acceptance criteria

- [x] `onModuleDestroy` runs the ordered sequence: workers → QueueEvents → (optional) drain → FlowProducer → queues → connection teardown
- [x] Each worker is closed via `Promise.race([worker.close(), timeout])`; a worker that exceeds `drainTimeoutMs` is force-closed via `worker.close(true)` and a structured warning carrying `queue.shutdown_timeout_exceeded` is logged
- [x] A timed-out/forced worker does **not** block the remaining teardown steps
- [x] `drainOnShutdown: true` calls `queue.drain()` on every cached queue; `drainOnShutdown: false` (default) does **not**
- [x] Mode B: `connection.onModuleDestroy` (which `quit()`s) runs; Mode A: it runs but is a no-op for the shared client (only duplicated connections are closed)
- [x] Teardown steps swallow individual errors so one failure never aborts the rest
- [x] The shutdown log includes total elapsed ms and the drained/forced worker count
- [x] 100% line/branch coverage (timeout branch, `drainOnShutdown` branch, swallowed-error branches)

#### Files to create / modify

- `src/server/lifecycle/queue-lifecycle.service.ts`
- `src/server/lifecycle/queue-lifecycle.service.spec.ts`

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ (typed job queues, workers,
flows, Job Schedulers, graceful shutdown) with a dual-mode Redis connection (Mode A: bring your own
client; Mode B: lib opens its own). Peer deps `bullmq ^5.16.0` + `ioredis ^5`. The Queue/FlowProducer
connection keeps default retries; Worker/QueueEvents use duplicated connections with
`maxRetriesPerRequest: null` for the blocking commands `BRPOPLPUSH`/`BZPOPMIN`/`BLMOVE`.

CURRENT PHASE: 4 — Task 4.2 of 7 (MIDDLE)

PRECONDITIONS
- Phases 1–3 done. `WorkerRegistry.getAll()` yields `[name, Worker]`; `QueueEventsRegistry.getAll()`
  yields `[name, QueueEvents]`; `QueueService.getCachedQueues()` yields `[name, Queue]`;
  `FlowService` has its own `onModuleDestroy()` (idempotent close of the FlowProducer);
  `ConnectionResolver.onModuleDestroy()` quits the owned client in Mode B and is a no-op for the
  shared client in Mode A. `BYMAX_QUEUE_RESOLVED_OPTIONS` exposes
  `shutdown: { drainTimeoutMs, drainOnShutdown }`. `QUEUE_ERROR_CODES.SHUTDOWN_TIMEOUT_EXCEEDED`
  equals `'queue.shutdown_timeout_exceeded'`.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 10 "Delivery Semantics and Shutdown Strategy" — especially
  § 10.2 "Shutdown protocol" (the 7-step ordered sequence and the Mode A vs Mode B teardown rule)
  and § 10.3 "Guarantees".
- `docs/development_plan.md` § 5.2 "QueueLifecycle — graceful shutdown" (the skeleton + the
  Risks/Notes on `worker.close()` having no timeout argument).

TASK
Implement `QueueLifecycle` as an `@Injectable()` `OnModuleDestroy` service executing the §10.2
protocol exactly, with full coverage of the timeout and conditional-drain branches.

DELIVERABLES

1. `src/server/lifecycle/queue-lifecycle.service.ts`:

   ```typescript
   import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
   import { Worker } from 'bullmq'
   import { BYMAX_QUEUE_RESOLVED_OPTIONS } from '../bymax-queue.constants'
   import type { ResolvedQueueOptions } from '../config/resolved-options'
   import { QUEUE_ERROR_CODES } from '../constants/error-codes'
   // + WorkerRegistry, QueueEventsRegistry, QueueService, FlowService, ConnectionResolver

   @Injectable()
   export class QueueLifecycle implements OnModuleDestroy {
     private readonly logger = new Logger(QueueLifecycle.name)
     // constructor injects: workers, events, queues, flow, connection, resolved options

     async onModuleDestroy(): Promise<void> {
       const start = Date.now()
       let forced = 0
       const drainTimeoutMs = this.resolved.shutdown.drainTimeoutMs

       // 1. Close each worker with a bounded drain.
       for (const [name, worker] of this.workers.getAll()) {
         try {
           await this.closeWorkerWithTimeout(worker, drainTimeoutMs)
         } catch {
           forced++
           this.logger.warn(
             `Worker "${name}" exceeded ${drainTimeoutMs}ms — forcing close ` +
             `(${QUEUE_ERROR_CODES.SHUTDOWN_TIMEOUT_EXCEEDED}); in-flight jobs become stalled`,
           )
           await worker.close(true).catch(() => undefined)
         }
       }

       // 2. Close QueueEvents.
       for (const [, qe] of this.events.getAll()) await qe.close().catch(() => undefined)

       // 3. Optional drain (DEV/TEST only).
       if (this.resolved.shutdown.drainOnShutdown) {
         for (const [, queue] of this.queues.getCachedQueues()) {
           await queue.drain().catch(() => undefined)
         }
       }

       // 4. Close FlowProducer (idempotent). 5. Close queues. 6. Connection teardown.
       await this.flow.onModuleDestroy().catch(() => undefined)
       for (const [, queue] of this.queues.getCachedQueues()) await queue.close().catch(() => undefined)
       await this.connection.onModuleDestroy().catch(() => undefined)

       this.logger.log(`Queue shutdown complete in ${Date.now() - start}ms (forced ${forced} worker(s))`)
     }

     // worker.close() ALREADY drains and takes NO timeout — race it against a timer.
     private async closeWorkerWithTimeout(worker: Worker, timeoutMs: number): Promise<void> {
       let timer: ReturnType<typeof setTimeout> | undefined
       try {
         await Promise.race([
           worker.close(),
           new Promise<never>((_, reject) => {
             timer = setTimeout(() => reject(new Error('drain timeout')), timeoutMs)
           }),
         ])
       } finally {
         if (timer) clearTimeout(timer)
       }
     }
   }
   ```

2. `src/server/lifecycle/queue-lifecycle.service.spec.ts` — unit tests with mocked
   Worker/QueueEvents/Queue/registries:
   - Full ordered sequence is invoked (assert call order).
   - A worker whose mocked `close()` never resolves is force-closed with `close(true)` after the
     timeout, the `queue.shutdown_timeout_exceeded` warning is logged, and teardown continues.
   - `drainOnShutdown: true` calls `queue.drain()`; default does not.
   - Mode B vs Mode A: `connection.onModuleDestroy` is always called (no-op for the shared client).
   - Rejections in each teardown step are swallowed (one failure does not abort the rest).
   - Use fake timers for the timeout branch.

Constraints:
- TS strict, zero `any`; JSDoc on the class and the public method. No suppression comments.
- English-only, timeless comments (never reference roadmap phases). Follow `/bymax-workflow:standards`.

Verification:
- `pnpm test src/server/lifecycle/queue-lifecycle.service.spec.ts` — expected: green.
- `pnpm test:cov:all` (this file) — expected: 100% line/branch including the timeout & drain branches.
- `pnpm typecheck && pnpm lint` — expected: clean.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `2 / 7` in the header.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.2 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 4.3 — At-least-once semantics & handler idempotency documentation

- **Status**: ✅ Done
- **Priority**: P1
- **Size**: S
- **Depends on**: 4.2

#### Description

Document the at-least-once delivery contract as a first-class, prominent part of the public API: BullMQ guarantees at-least-once (never exactly-once), so handlers must be idempotent. Make this unmissable in JSDoc — on `enqueue` (idempotency vs deduplication), on the `@Process`/`@Processor` decorators, and on `QueueLifecycle` (force-close → stalled → retry). Distinguish producer-side deduplication (`jobId`, `deduplication`) from consumer-side idempotency, and link `lockDuration` tuning to avoiding false stalls. No new runtime behavior — this task hardens the documented contract so consumers cannot misread the guarantee.

#### Acceptance criteria

- [x] `enqueue` JSDoc states at-least-once + handler idempotency, and clearly separates `jobId` (idempotent insert) from `deduplication` (windowed deduplication), noting neither changes the consumer-side guarantee
- [x] `@Process` / `@Processor` JSDoc instructs handlers to be idempotent (idempotency key on writes, upserts over inserts, or an "already-processed" marker keyed by `job.id`)
- [x] `QueueLifecycle`/`@OnWorkerEvent` JSDoc explains that a force-closed in-flight job becomes `stalled` and is retried (the visible at-least-once path) and that `lockDuration` must exceed worst-case handler runtime
- [x] No code claims or implies exactly-once anywhere in the surface
- [x] `pnpm typecheck && pnpm lint` clean; coverage unaffected (docs/JSDoc only — no logic added)

#### Files to create / modify

- `src/server/services/queue.service.ts` (JSDoc on `enqueue` / `enqueueBulk`)
- `src/server/decorators/process.decorator.ts`, `src/server/decorators/processor.decorator.ts` (JSDoc)
- `src/server/decorators/on-worker-event.decorator.ts` (JSDoc on `failed`/`stalled`)
- `src/server/lifecycle/queue-lifecycle.service.ts` (class JSDoc — stalled/retry note)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. Delivery is at-least-once
(never exactly-once); producer-side deduplication is via BullMQ-native `jobId` (idempotent insert) and
`deduplication` (Simple/Throttle/Debounce/keep-last-if-active) surfaced through `enqueue` options —
the lib adds no custom deduplication code. Recurring jobs use `upsertJobScheduler` (never `addRepeatable`).

CURRENT PHASE: 4 — Task 4.3 of 7 (MIDDLE)

PRECONDITIONS
- Task 4.2 done: `QueueLifecycle` exists and force-close turns in-flight jobs into `stalled`
  (retried). `enqueue`, the `@Process`/`@Processor`/`@OnWorkerEvent` decorators all exist with
  baseline JSDoc.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 10.0 "Delivery semantics — at-least-once, never exactly-once"
  and § 10.3 "Guarantees".
- `docs/technical_specification.md` § 5.4.1 "Idempotency and deduplication" (the jobId vs
  deduplication-modes table).

TASK
Harden the documented contract — JSDoc only, no behavior change. Make at-least-once + idempotency
impossible to miss on the public surface, and keep the jobId-vs-deduplication distinction crisp.

DELIVERABLES

1. `src/server/services/queue.service.ts` — expand the JSDoc on `enqueue` (and a one-liner on
   `enqueueBulk`):
   - State: "Delivery is at-least-once — a handler may run more than once for the same job (worker
     crash / lock expiry / shutdown force-close). Make handlers idempotent."
   - Separate `jobId` (idempotent insert: a second add with the same id is a no-op while the first
     exists) from `deduplication` (windowed deduplication). Note both collapse duplicate PRODUCERS and do
     not change the at-least-once guarantee on the CONSUMER side.

2. `src/server/decorators/process.decorator.ts` + `processor.decorator.ts` — JSDoc: handlers MUST be
   idempotent; recommend an idempotency key on writes, upserts over inserts, or an
   "already-processed" marker keyed by `job.id`.

3. `src/server/decorators/on-worker-event.decorator.ts` — JSDoc on `'failed'`/`'stalled'`: a stalled
   job (e.g. after shutdown force-close or lock expiry) is re-run — the visible at-least-once path;
   set `lockDuration` comfortably above worst-case handler runtime to avoid false stalls.

4. `src/server/lifecycle/queue-lifecycle.service.ts` — extend the class JSDoc: on `drainTimeoutMs`
   expiry the worker is force-closed and its in-flight job becomes `stalled` (retried) — at-least-once
   by design, surfaced via `queue.shutdown_timeout_exceeded`.

Constraints:
- JSDoc/comments only — do NOT change runtime logic or signatures (coverage must stay 100%).
- Never write or imply "exactly-once". English-only, timeless. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck && pnpm lint` — expected: clean (no warnings).
- `pnpm test:cov:all` — expected: unchanged 100% (no logic added).
- `grep -ri "exactly-once\|exactly once" src/` — expected: only negations ("never exactly-once").

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `3 / 7` in the header.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.3 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 4.4 — Dead-letter-queue (DLQ) pattern via `@OnWorkerEvent('failed')`

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: S
- **Depends on**: 4.3

#### Description

Document and demonstrate the dead-letter-queue pattern the lib endorses for exhausted jobs: a consumer-owned `@OnWorkerEvent('failed')` listener that, once `job.attemptsMade >= (job.opts.attempts ?? 1)`, re-enqueues the payload (plus failure metadata) onto a `*-dlq` queue via `QueueService.enqueue`. The lib does not bundle a DLQ service (it stays unopinionated about persistence), but it must ship a clear, copy-pasteable, idempotent example and JSDoc guidance so the pattern is consistent across consumers. Provide the example as an E2E-friendly fixture processor that Task 4.5 can exercise.

#### Acceptance criteria

- [ ] A documented DLQ example processor exists showing the `attemptsMade >= attempts` guard and re-enqueue to a `<queue>-dlq` queue
- [ ] The example preserves the original payload plus failure metadata (`failedReason`, `attemptsMade`, original `jobId`) and is idempotent (stable DLQ `jobId`)
- [ ] `@OnWorkerEvent('failed')` JSDoc references the DLQ pattern and the exhaustion guard
- [ ] The example uses only the public API (`@Processor`, `@Process`, `@OnWorkerEvent`, `QueueService.enqueue`) — no internal services
- [ ] `pnpm typecheck && pnpm lint` clean; the fixture compiles under the E2E tsconfig

#### Files to create / modify

- `test/e2e/fixtures/processors/dlq.processor.ts` (example/fixture processor)
- `src/server/decorators/on-worker-event.decorator.ts` (JSDoc — DLQ guidance)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. The lib is unopinionated about
persistence and dead-lettering: it provides the typed primitives (`@OnWorkerEvent('failed')`,
`QueueService.enqueue`) and documents the DLQ pattern; it does NOT bundle a DLQ service. Delivery is
at-least-once, so the DLQ re-enqueue must itself be idempotent (stable DLQ jobId).

CURRENT PHASE: 4 — Task 4.4 of 7 (MIDDLE)

PRECONDITIONS
- Task 4.3 done. `@OnWorkerEvent('failed')` passes `(job: Job | undefined, error: Error)`; `job` may
  be undefined if the failure happened before the worker fetched it. `QueueService.enqueue` and the
  `@Processor`/`@Process` decorators are available to fixtures.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 6.5 "Event decorators — @OnWorkerEvent vs @OnQueueEvent"
  (the worker-local listener receives the full Job).
- `docs/development_plan.md` § 5.2 Risks/Notes (the DLQ guidance: re-enqueue to `*-dlq` when
  `job.attemptsMade >= (job.opts.attempts ?? 1)`).

TASK
Create the canonical DLQ example as an E2E fixture processor and add DLQ guidance to the
`@OnWorkerEvent` JSDoc. Public API only; fully idempotent.

DELIVERABLES

1. `test/e2e/fixtures/processors/dlq.processor.ts`:

   ```typescript
   import { Injectable } from '@nestjs/common'
   import { Processor, Process, OnWorkerEvent, QueueService } from '@bymax-one/nest-queue'
   import type { Job } from 'bullmq'

   interface RiskyData { willFail: boolean; payload: string }

   @Injectable()
   @Processor('risky', { concurrency: 2 })
   export class DlqProcessor {
     constructor(private readonly queues: QueueService) {}

     @Process()
     async handle(job: Job<RiskyData>): Promise<void> {
       if (job.data.willFail) throw new Error('intentional failure')
     }

     /**
      * Dead-letter routing: once retries are exhausted, copy the payload + failure metadata
      * onto a `<queue>-dlq` queue. Idempotent via a stable DLQ jobId so a redelivered `failed`
      * event never double-inserts.
      */
     @OnWorkerEvent('failed')
     async onFailed(job: Job<RiskyData> | undefined, error: Error): Promise<void> {
       if (!job) return
       const maxAttempts = job.opts.attempts ?? 1
       if (job.attemptsMade < maxAttempts) return // not exhausted yet — let BullMQ retry
       await this.queues.enqueue(
         'risky-dlq',
         'dead-letter',
         { original: job.data, failedReason: error.message, attemptsMade: job.attemptsMade, jobId: job.id },
         { jobId: `dlq:${job.id}` },
       )
     }
   }
   ```

2. `src/server/decorators/on-worker-event.decorator.ts` — add to the `'failed'` JSDoc: the DLQ
   pattern (guard on `attemptsMade >= (opts.attempts ?? 1)`, re-enqueue to `*-dlq` with a stable
   jobId for idempotency), with a one-line pointer to the example fixture.

Constraints:
- Public API only — no `WorkerRegistry`/`ConnectionResolver`/`QueueLifecycle` internals.
- TS strict, zero `any`; the fixture must compile under `tsconfig.e2e.json`. English-only, timeless.
- Do NOT create empty directories — write the real fixture file. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` (and the e2e tsconfig path) — expected: the fixture type-checks.
- `pnpm lint` — expected: no warnings.
- The fixture is consumed by Task 4.5's E2E suite as the DLQ demonstration.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `4 / 7` in the header.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.4 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 4.5 — E2E suite with Testcontainers Redis (7 scenarios)

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: L
- **Depends on**: 4.1 (`forRootAsync`), 4.2 (`QueueLifecycle`)

#### Description

Build a `test/e2e/` suite that boots real Redis via `@testcontainers/redis` (or `testcontainers` `GenericContainer('redis:7-alpine')`), instantiates a NestJS fixture application context, and validates the seven end-to-end scenarios from spec §15.5 / §18.3. Runs only via `pnpm test:e2e` (config `jest.e2e.config.ts`, `rootDir: test/e2e`), never under `pnpm test`. Each scenario must clean its queues between runs (`queue.obliterate()` in `afterEach`) and silence framework/BullMQ logs.

#### Acceptance criteria

- [ ] Scenario 1 — enqueue → process → typed result (assert the handler's `TResult` via `@OnQueueEvent('completed')` capture)
- [ ] Scenario 2 — graceful shutdown finishes an in-flight job before the context closes (enqueue a slow job, trigger `app.close()`, assert it completed)
- [ ] Scenario 3 — a 3-level flow completes all descendants before the root
- [ ] Scenario 4 — `upsertJobScheduler` (interval `every`) fires twice within ~10s; re-upserting the same `schedulerId` does not create a second scheduler (`getJobSchedulers` length stays 1)
- [ ] Scenario 5 — failure → exponential retry → eventual success (handler fails twice then succeeds; assert 3 attempts)
- [ ] Scenario 6 — deduplication collapses N rapid same-`deduplication.id` enqueues into one processed job
- [ ] Scenario 7 — the Mode-A worker connection is coerced to `maxRetriesPerRequest: null` while the Queue connection keeps ioredis defaults (inspect both)
- [ ] `pnpm test:e2e` completes in < 90s (60s container-boot timeout); queues are obliterated between scenarios; Nest/BullMQ logs are silenced
- [ ] The suite exercises the Task 4.4 DLQ fixture at least as a smoke check (exhausted job lands on `*-dlq`)

#### Files to create / modify

- `test/e2e/queue.e2e-spec.ts`
- `test/e2e/setup/testcontainers.ts`
- `test/e2e/fixtures/test.module.ts`
- `test/e2e/fixtures/processors/echo.processor.ts`
- `jest.e2e.config.ts` (confirm `rootDir`/`maxWorkers`; created earlier — verify only)

#### Agent prompt

````
You are a senior NestJS/TypeScript test engineer working on the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ (typed queues, workers, flows,
Job Schedulers, graceful shutdown), dual-mode Redis. Recurring jobs use `upsertJobScheduler` (never
`addRepeatable`). The Queue connection keeps default retries; Worker/QueueEvents use duplicated
connections with `maxRetriesPerRequest: null` (blocking commands BRPOPLPUSH/BZPOPMIN/BLMOVE).

CURRENT PHASE: 4 — Task 4.5 of 7 (MIDDLE)

PRECONDITIONS
- Tasks 4.1 (`forRootAsync`) and 4.2 (`QueueLifecycle`) are done; Task 4.4 shipped the DLQ fixture.
- `jest.e2e.config.ts` exists (from the scaffold) with `rootDir: 'test/e2e'` and `maxWorkers: '50%'`.
- Docker is available locally and on the CI runner (`ubuntu-latest`).

REQUIRED READING (only these):
- `docs/technical_specification.md` § 15.5 "Phase 4 — Shutdown, E2E, Polish" (the 7 scenarios) and
  § 18.3 "What the e2e suite must prove".
- `docs/development_plan.md` § 5.3 "E2E suite with Testcontainers Redis" (the setup + fixture +
  spec skeletons).

TASK
Implement the Testcontainers-backed E2E suite covering all 7 scenarios. One sequential run only —
never fan out parallel suites against the local library.

DELIVERABLES

1. `test/e2e/setup/testcontainers.ts` — boot `redis:7-alpine`, expose `{ container, url, stop }`:

   ```typescript
   import { GenericContainer, type StartedTestContainer } from 'testcontainers'

   export interface RedisContainer { container: StartedTestContainer; url: string; stop: () => Promise<void> }

   export async function startRedisContainer(): Promise<RedisContainer> {
     const container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
     const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
     return { container, url, stop: () => container.stop() }
   }
   ```

2. `test/e2e/fixtures/processors/echo.processor.ts` — a typed `@Processor('echo')` with a `@Process()`
   handler returning `{ echoed }` and an `@OnQueueEvent('completed')` capturing `{ jobId, returnvalue }`
   into a public array for assertions.

3. `test/e2e/fixtures/test.module.ts` — a `buildTestModule(redisUrl, mode)` helper that registers
   `BymaxQueueModule.forRootAsync({ useFactory: () => ({ connection: <Mode A or B>, flows: { enabled: true },
   metrics: { enabled: true }, shutdown: { drainTimeoutMs: 5_000 } }) })` plus the fixture processors
   (Echo, the slow processor, the retry processor, the DLQ processor). For Scenario 7, Mode A passes a
   pre-built ioredis client so the test can inspect both connection roles.

4. `test/e2e/queue.e2e-spec.ts` — `beforeAll` boots Redis + the app context (60s timeout); `afterEach`
   obliterates touched queues; `afterAll` closes the app then stops the container. Implement:
   - S1 enqueue→process→typed result; S2 graceful shutdown (slow job finishes before close);
   - S3 3-level flow (assert child completions precede the root); S4 interval scheduler fires ≥2 in
     ~10s and re-upsert keeps `getJobSchedulers().length === 1`; S5 fail-twice-then-succeed (3
     attempts, exponential backoff); S6 deduplication collapses N→1; S7 inspect the duplicated worker
     connection (`maxRetriesPerRequest === null`) vs the Queue connection (default);
   - DLQ smoke: an exhausted `risky` job lands on `risky-dlq`.
   - Use `NestFactory.createApplicationContext(..., { logger: false })`; poll with a bounded
     `waitFor(predicate, timeoutMs)` helper rather than fixed sleeps.

Constraints:
- TS strict, zero `any`; English-only, timeless. Do NOT create empty dirs — write real files only.
- Do NOT use `addRepeatable`/legacy repeatable API. No suppression comments. `/bymax-workflow:standards`.
- Keep total wall time < 90s; raise per-test timeouts only where a scenario truly needs it (S4 ~12s).

Verification:
- `pnpm test:e2e` — expected: all 7 scenarios + DLQ smoke pass in < 90s.
- `pnpm test` — expected: the E2E suite is NOT picked up (separate config).
- Re-run twice — expected: deterministic (obliterate between scenarios prevents cross-talk).

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `5 / 7` in the header.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.5 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 4.6 — Mutation-testing baseline (Stryker `break 95`)

- **Status**: 📋 ToDo
- **Priority**: P1
- **Size**: M
- **Depends on**: 4.5

#### Description

Run Stryker once to establish a mutation-score baseline on the critical files, confirm the thresholds (`{ high: 99, low: 95, break: 95 }`, targeting 100%), and capture the strategy + first result in `docs/`. Mutation testing is a pre-release gate (10–20 min), not per-commit. Document the targets (files whose surviving mutants are unacceptable), the accepted exclusions (barrel exports, metadata-only NestJS decorators already covered by integration), and any survivors as TODOs.

#### Acceptance criteria

- [ ] `stryker.config.json` confirms `thresholds: { high: 99, low: 95, break: 95 }`, the `jest.stryker.config.ts` runner, and a sensible `mutate` glob (critical `src/server/**` files; excludes barrels and pure metadata decorators)
- [ ] `pnpm mutation:dry-run` completes with no config error
- [ ] `pnpm mutation` (full run) yields ≥ 95% on the critical paths (`break 95`), targeting 100%
- [ ] `docs/mutation_testing_plan.md` lists targets (`connection-resolver`, `queue.service`, `worker-registry`, processor discovery, `validate-options`, `validate-connection`, repeat-options validation, `metrics.service`, `queue-lifecycle`), accepted exclusions, and thresholds
- [ ] `docs/mutation_testing_results.md` records the first run output with a date; unacceptable survivors become TODOs in the plan

#### Files to create / modify

- `stryker.config.json` (confirm thresholds + mutate glob)
- `docs/mutation_testing_plan.md` (create)
- `docs/mutation_testing_results.md` (create)

#### Agent prompt

````
You are a senior TypeScript test/quality engineer working on the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ. Quality floor: 100% line/branch
coverage on implemented files; Stryker mutation testing `{ high: 99, low: 95, break: 95 }` targeting
100%, run as a PRE-RELEASE gate (not per-commit) because a full run takes 10–20 min.

CURRENT PHASE: 4 — Task 4.6 of 7 (MIDDLE)

PRECONDITIONS
- Tasks 4.1–4.5 done: all logic implemented, 100% unit coverage, E2E suite green.
- `stryker.config.json` and `jest.stryker.config.ts` exist from the scaffold.
- Memory safety: run sequentially in the main agent; do not fan out parallel suites against the
  local library (Stryker + Jest workers duplicate the module graph per worker).

REQUIRED READING (only these):
- `docs/technical_specification.md` § 18.2 "Coverage and mutation policy" and § 18.1 (the Mutation
  layer row: thresholds, pre-release gate, memory cap).
- `docs/development_plan.md` § 5.4 "Mutation testing baseline" (targets, exclusions, thresholds).

TASK
Confirm the Stryker config, run the baseline, and document the plan + results.

DELIVERABLES

1. `stryker.config.json` — confirm/set:
   - `"thresholds": { "high": 99, "low": 95, "break": 95 }`
   - `"testRunner": "jest"` pointing at `jest.stryker.config.ts`
   - `"mutate"`: the critical `src/server/**/*.ts` files; exclude `**/index.ts` barrels, `*.spec.ts`,
     and pure metadata-only decorator files already exercised by integration tests.
   - A bounded `concurrency` to stay memory-safe.

2. `docs/mutation_testing_plan.md`:
   - **Targets (unacceptable survivors):** connection-resolver, queue.service, worker-registry,
     processor-discovery, validate-options, validate-connection, repeat-options validation,
     metrics.service, queue-lifecycle.
   - **Accepted exclusions:** barrel exports; metadata-only NestJS decorators (covered by integration).
   - **Thresholds:** high 99, low 95, break 95 — targeting 100%. **Cadence:** pre-release, not per-commit.

3. `docs/mutation_testing_results.md`:
   - The first full-run summary (overall score + per-target score) with the run date and Stryker
     version. List any surviving mutants and copy each as a TODO into the plan.

Constraints:
- English-only, timeless docs (no roadmap/phase references in the committed markdown).
- Do not weaken thresholds to pass; if a target is below `break`, record the survivor as a TODO and
  add a follow-up note rather than lowering the bar. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm mutation:dry-run` — expected: no config error.
- `pnpm mutation` — expected: ≥ 95% on critical paths (build passes `break 95`).
- `ls docs/mutation_testing_plan.md docs/mutation_testing_results.md` — expected: both present.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `6 / 7` in the header.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.6 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 4.7 — Phase 4 index exports, lifecycle tests & validation

- **Status**: 📋 ToDo
- **Priority**: P0
- **Size**: M
- **Depends on**: 4.1–4.6

#### Description

Close the phase: wire the new symbols into the server barrel (`QueueLifecycle` exposed as a type for advanced consumers; keep direct, non-deep re-exports for tree-shaking), confirm `QueueLifecycle` unit tests reach 100% line/branch, and run the full validation chain (`typecheck`, `lint`, 100% coverage, `build`, `size`, `test:e2e`). Audit every Phase 4 acceptance criterion and run `/bymax-quality:code-review`, applying findings.

#### Acceptance criteria

- [ ] `src/server/index.ts` exports the Phase 4 additions with no deep barrels (`QueueLifecycle` as a type-only advanced export; `forRootAsync` reachable via `BymaxQueueModule`)
- [ ] `pnpm typecheck` passes (root + `tsconfig.server.json`)
- [ ] `pnpm lint` passes with no warnings (no `eslint-disable`)
- [ ] `pnpm test:cov:all` passes at 100% line/branch on every implemented file (`100/100/100/100`)
- [ ] `pnpm build` emits `.mjs`/`.cjs`/`.d.ts` for both subpaths (`server`, `shared`)
- [ ] `pnpm size` is within budget (`server` ≤ 18 KiB brotli)
- [ ] `pnpm test:e2e` green; mutation score ≥ 95% on critical paths
- [ ] `/bymax-quality:code-review` run and findings applied; `git status` clean (Conventional Commits)

#### Files to create / modify

- `src/server/index.ts` (barrel — add Phase 4 exports)
- `src/server/lifecycle/queue-lifecycle.service.spec.ts` (top up to 100% if needed)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer closing Phase 4 of the @bymax-one/nest-queue project.

PROJECT: @bymax-one/nest-queue — a public NestJS wrapper over BullMQ (typed queues, workers, flows,
Job Schedulers, graceful shutdown), dual-mode Redis, two subpaths (`.` server, `./shared`). No deep
barrel re-exports (direct named exports for tree-shaking). `ConnectionResolver`/`QueueLifecycle` are
internal-ish; `QueueLifecycle` is surfaced only as an advanced type.

CURRENT PHASE: 4 — Task 4.7 of 7 (LAST)

PRECONDITIONS
- Tasks 4.1–4.6 done: `forRootAsync`, `QueueLifecycle`, the at-least-once/DLQ docs, the E2E suite,
  and the mutation baseline all exist. This task wires exports and runs the full gate.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 3.3 "Exports per subpath" (the server barrel + the "public vs
  internal API" note) and § 18 "Testing Strategy and Quality Gates".
- `docs/development_plan.md` § 5.5 "Phase 4 — index + tests + validation", § 5.6 "Phase 4 validation",
  and § 1.4 "Global Done criteria per phase".

TASK
Finalize the barrel, top up `QueueLifecycle` coverage to 100%, and run the full validation chain.
Audit every Phase 4 acceptance criterion before marking the phase done.

DELIVERABLES

1. `src/server/index.ts` — add the Phase 4 exports with explicit named re-exports (no `export *`
   deep barrels). Expose `QueueLifecycle` as a type for advanced consumers (e.g.
   `export type { QueueLifecycle } from './lifecycle/queue-lifecycle.service'`); `forRootAsync` is
   reached through `BymaxQueueModule` (already exported). Keep ordering/grouping consistent with the
   existing barrel.

2. `src/server/lifecycle/queue-lifecycle.service.spec.ts` — add any missing cases to reach 100%
   line/branch (forced-close timeout branch, `drainOnShutdown` true/false, each swallowed-error path).

3. Run and make green, in order:
   `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size && pnpm test:e2e`
   then `pnpm mutation` (pre-release gate) and confirm ≥ 95% on critical paths.

Constraints:
- TS strict, zero `any`; JSDoc on any newly exported symbol. No suppression comments; never bypass a
  gate with `--no-verify` or `@ts-ignore`. English-only, timeless. Follow `/bymax-workflow:standards`.
- Run `/bymax-quality:code-review` and apply findings; re-run the gate after fixes.

Verification:
- `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size && pnpm test:e2e`
  — expected: all pass; coverage 100/100/100/100; bundle within budget.
- `pnpm mutation` — expected: ≥ 95% on critical paths (`break 95`).
- `node -e "import('./dist/server/index.mjs').then(m => console.log(Object.keys(m).sort()))"`
  — expected: the public surface (incl. `BymaxQueueModule`) resolves cleanly.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index table.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `7 / 7` in the header and flip the phase Status to ✅ Done
   once all seven tasks are complete.
5. Update the Phase 4 row in `docs/development_plan.md` (§1.3 Phase summary) and its header `Last updated`.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 4.7 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

## Completion log

> Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`.

<!-- entries appended as tasks complete -->

- 4.2 ✅ 2026-06-27 — `QueueLifecycle` ordered bounded-drain shutdown; registries expose duplicated connections and delegate shutdown to the lifecycle (no unbounded self-close).
- 4.1 ✅ 2026-06-27 — `forRootAsync` (useFactory/useClass/useExisting + inject) with shared core providers; `QueueLifecycle` wired into both paths; `setFactoryMethodName('createQueueOptions')`.
- 4.3 ✅ 2026-06-27 — At-least-once + idempotency JSDoc on `enqueue`/`enqueueBulk`, `@Process`/`@Processor`, `@OnWorkerEvent`, and the lifecycle (jobId vs deduplication; stalled-retry; lockDuration).
