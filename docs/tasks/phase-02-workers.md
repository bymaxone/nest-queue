# Phase 2 — Workers: @Processor, decorators & WorkerRegistry

> **Status**: ✅ Done · **Progress**: 6 / 6 tasks · **Last updated**: 2026-06-26
> **Source roadmap**: [`docs/development_plan.md`](../development_plan.md) § Phase 2
> **Source spec**: [`docs/technical_specification.md`](../technical_specification.md)

---

## Context

Phase 1 is **done**: the dynamic module, the connection layer, and the base queue API already exist and are exercised by a fixture (you can install the lib, `enqueue` a job, and read its counts). Concretely, the following are in place and Phase 2 builds on them:

- `BymaxQueueModule.forRoot()` — the synchronous dynamic module, built on `ConfigurableModuleBuilder` (`isGlobal` mapped to `DynamicModule.global` via `setExtras`; **no** hand-written `@Global()`).
- `ConnectionResolver` — dual-mode (A: BYO client / B: lib-owned) with `getClient()`, `getMode()`, `isOwned()`; validated on bootstrap.
- `duplicateConnection(client)` — `src/server/utils/duplicate-connection.ts`, returns `client.duplicate({ maxRetriesPerRequest: null })` for blocking consumers.
- `QueueService` — `Queue` cache + `enqueue`/`enqueueBulk`/`getJob`/`getJobs`/`getMetrics`/`pauseQueue`/`resumeQueue`/`cleanQueue`.
- Interfaces (`src/server/interfaces/`): `WorkerOptions` (no `sandboxed` boolean by design), `ProcessorMetadata`, `ProcessHandlerMetadata`, `QueueEventListenerMetadata`, `BymaxQueueModuleOptions`.
- Constants (`src/server/constants/`): `DEFAULT_WORKER_CONCURRENCY = 2`, `QUEUE_ERROR_CODES`, `QUEUE_ERROR_MESSAGES`; `QueueException`.

Phase 2 makes the queue **process** jobs. It adds the four worker decorators (`@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`), the `WorkerRegistry` (programmatic + file-based sandboxed registration), the lazy `QueueEventsRegistry`, the `DiscoveryService`-driven wiring that turns annotated classes into running BullMQ `Worker`s (binding worker-local listeners to the `Worker` and global listeners to a per-queue `QueueEvents`), the module wiring, and the worker-options validation (concurrency required with a default + warning, `concurrency < 1` error, limiter validation). When Phase 2 closes, a fixture can declare `@Processor('email')` with a `@Process()` handler, the job enqueued on `email` runs, and an `@OnWorkerEvent('progress')` listener observes `job.updateProgress()`.

---

## Rules-of-phase

1. **TypeScript strict, zero `any`** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Where a BullMQ signature uses `any`, re-expose it as `unknown` on the lib's public surface; never widen the lib's own API to `any`.
2. **JSDoc on every exported symbol** (class, function, interface, type, constant), with `@example` where it aids the reader.
3. **Quality floor — 100% line/branch coverage** on every file implemented in this phase (`jest.coverage.config.ts` thresholds `100/100/100/100`). Stryker mutation testing (`break 95`, targeting 100%) is a **pre-release** gate, not per-commit.
4. **English everywhere** — identifiers, comments, JSDoc, error messages. **Timeless comments** — no `Phase N`/`Task`/roadmap-stage references inside any committed file (code, config, docs-as-config). A reference to a spec section (`§6.5`) is fine; a reference to a plan stage is not.
5. **No suppression comments** — no `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck`. Fix the type/lint finding, never silence it.
6. **Current BullMQ API only** (the spec's normative invariant). Specifically:
   - `@OnWorkerEvent(eventName)` is **worker-local** — its handler receives the **full `Job`** (`job.data`, `job.returnvalue`, `job.attemptsMade`, timings). No extra Redis connection.
   - `@OnQueueEvent(eventName)` is **global** — backed by a `QueueEvents` instance; its handler receives only `jobId` + **serialized** payload (`returnvalue`/`failedReason` are **strings**, key is lowercase `returnvalue`). To get the `Job`, call `queueService.getJob(jobId)` (may be `null` if already evicted).
   - **Sandboxed processors are FILE-BASED** via `WorkerRegistry.registerSandboxed` (a path/URL to a built `.js`/`.cjs`/`.mjs` artifact, run out-of-process, **no NestJS DI**). There is **no** `sandboxed: boolean` option anywhere.
   - `Worker` and `QueueEvents` connections are always obtained via `duplicateConnection()` → `duplicate({ maxRetriesPerRequest: null })` because they hold blocking commands (`BRPOPLPUSH` / `BZPOPMIN` / `BLMOVE`); the `Queue`/`FlowProducer` connection keeps default retries.
7. **Symbol metadata keys** — decorators write metadata under `Symbol(...)` keys so they never collide with user-defined metadata. `Reflect.getMetadata` returns `undefined` when absent → always default to `[]`.
8. **Conditional / lazy registration** — a `QueueEvents` connection is opened **only** when at least one `@OnQueueEvent` is registered for a queue. Worker-local `@OnWorkerEvent` listeners need no extra connection.
9. **`concurrency` is explicit by policy** — `DEFAULT_WORKER_CONCURRENCY = 2` is a safe, non-serial starting point (not a magic optimum). The lib falls back to it when a `@Processor` omits `concurrency`, but logs a warning during discovery. Tune by workload type: I/O-bound → raise concurrency + pair with `limiter`; CPU-bound → keep low and move to a sandboxed processor (§6.8).
10. **Never create `.gitkeep`/placeholder files or empty-directory scaffolding** — directories emerge from real files only.
11. **Conventional Commits** (`feat:`, `fix:`, `test:`, `refactor:`, …).

---

## Reference docs

- [`docs/technical_specification.md`](../technical_specification.md) — § 6 Workers (§6.2 `@Processor`, §6.3 signature, §6.4 `@Process`, §6.5 `@OnWorkerEvent` vs `@OnQueueEvent`, §6.5.1 progress, §6.6 programmatic API, §6.7 concurrency/limiter, §6.8 sandboxed), § 3.3 Exports per subpath, § 2.3 Connection sharing strategy, § 12 Error Code Catalog.
- [`docs/development_plan.md`](../development_plan.md) — § 3 Phase 2 (§3.1–§3.7), § 1.4 Global Done criteria per phase.
- `/bymax-workflow:standards` skill — universal TypeScript coding rules (type/lint discipline, JSDoc policy, English-only, typed errors, Conventional Commits).

---

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 2.1 | Worker decorators & Symbol metadata keys | ✅ Done | P0 | S | 1.3, 1.4 (Phase 1) |
| 2.2 | WorkerRegistry — programmatic + sandboxed + options validation | ✅ Done | P0 | M | 2.1, 1.4, 1.5 (Phase 1) |
| 2.3 | QueueEventsRegistry — lazy per-queue QueueEvents | ✅ Done | P1 | S | 1.5 (Phase 1) |
| 2.4 | ProcessorDiscoveryService — discover, dispatch & wire events | ✅ Done | P0 | L | 2.1, 2.2, 2.3 |
| 2.5 | Module wiring + server barrel exports | ✅ Done | P1 | S | 2.2, 2.3, 2.4, 1.8 (Phase 1) |
| 2.6 | Phase 2 unit tests, 100% coverage & phase validation | ✅ Done | P0 | L | 2.1, 2.2, 2.3, 2.4, 2.5 |

> Cross-phase dependencies reference **Phase 1** task IDs: `1.3` (interfaces), `1.4` (constants/DI tokens), `1.5` (`ConnectionResolver` + connection utils + `QueueException`), `1.8` (`forRoot` + server barrel).

---

## Tasks

### Task 2.1 — Worker decorators & Symbol metadata keys

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: S
- **Depends on**: 1.3, 1.4 (Phase 1)

#### Description

Create the four worker decorators and the Symbol metadata-key module. The decorators only **mark** classes/methods (write metadata via `Reflect.defineMetadata` under Symbol keys) — no execution logic. `@Processor` applies `DEFAULT_WORKER_CONCURRENCY` and `autorun: true` defaults, and records a `_warnedNoConcurrency` flag (consumed later by discovery) when `concurrency` is omitted. `@Process`, `@OnWorkerEvent`, and `@OnQueueEvent` accumulate per-class entries so multiple annotations on one class do not overwrite each other.

#### Acceptance criteria

- [x] `metadata-keys.constants.ts` exports four unique `Symbol(...)` keys (processor, process-handlers, worker-event-listeners, queue-event-listeners).
- [x] `@Processor('foo', { concurrency: 3 })` writes metadata with `queueName: 'foo'`, `workerOptions.concurrency: 3`, `workerOptions.autorun: true`.
- [x] `@Processor('foo')` without options applies `concurrency: DEFAULT_WORKER_CONCURRENCY` and sets `_warnedNoConcurrency: true`.
- [x] `@Process()` pushes an entry with `jobName: undefined`; `@Process('send')` pushes with `jobName: 'send'`.
- [x] Multiple `@Process` methods on one class accumulate (no overwrite); same for `@OnWorkerEvent` and `@OnQueueEvent`.
- [x] `@OnWorkerEvent` writes under the **worker-local** key; `@OnQueueEvent` writes under the **global** key (separate keys).
- [x] `WorkerEventName` and `QueueEventName` unions are exported and match the current BullMQ event sets.
- [x] JSDoc on every export; no `any`; 100% line/branch coverage.

#### Files to create / modify

- `src/server/decorators/metadata-keys.constants.ts` (create)
- `src/server/decorators/processor.decorator.ts` (create)
- `src/server/decorators/process.decorator.ts` (create)
- `src/server/decorators/on-worker-event.decorator.ts` (create)
- `src/server/decorators/on-queue-event.decorator.ts` (create)
- `src/server/interfaces/processor-metadata.interface.ts` (modify — add optional `_warnedNoConcurrency?: boolean` to `ProcessorMetadata`)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on @bymax-one/nest-queue.

PROJECT: @bymax-one/nest-queue — a public, fully-typed NestJS wrapper over BullMQ (Job Schedulers
API, ioredis peer dep). Two subpaths: `.` (server) and `./shared`. Zero runtime dependencies;
everything via peer deps. 100% coverage, Stryker break 95.

CURRENT PHASE: 2 (Workers) — Task 2.1 of 6 (FIRST)

PRECONDITIONS
- Phase 1 is done: interfaces (`WorkerOptions`, `ProcessorMetadata`, `ProcessHandlerMetadata`,
  `QueueEventListenerMetadata`) and constants (`DEFAULT_WORKER_CONCURRENCY = 2`) exist.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 6.2–6.4 (`@Processor`, `@Process` signatures and behavior)
  and § 6.5 (`@OnWorkerEvent` worker-local full-Job vs `@OnQueueEvent` global ids+serialized).
- `docs/development_plan.md` § 3.1 (the decorator skeletons and the metadata-key Symbols) and
  § 3.5 (the no-`concurrency` warning flag mechanism).

TASK
Implement the four decorators plus the Symbol metadata-key module. Decorators only WRITE metadata
(via `Reflect.defineMetadata` under Symbol keys) — no execution logic, no side effects at import
time. Accumulate per-class entries so multiple annotations never overwrite.

DELIVERABLES

1. `src/server/decorators/metadata-keys.constants.ts`:
   ```typescript
   /** Symbol metadata keys — never collide with user-defined metadata. */
   export const PROCESSOR_METADATA_KEY = Symbol('bymax_queue:processor')
   export const PROCESS_HANDLERS_METADATA_KEY = Symbol('bymax_queue:process_handlers')
   export const WORKER_EVENT_LISTENERS_METADATA_KEY = Symbol('bymax_queue:worker_event_listeners')
   export const QUEUE_EVENT_LISTENERS_METADATA_KEY = Symbol('bymax_queue:queue_event_listeners')
   ```

2. `src/server/decorators/processor.decorator.ts` — `Processor(queueName, workerOptions = {})`:
   - Builds `ProcessorMetadata` with defaults `{ concurrency: DEFAULT_WORKER_CONCURRENCY, autorun: true, ...workerOptions }`.
   - When `workerOptions.concurrency` is `undefined`, also set `_warnedNoConcurrency: true` on the
     metadata (the decorator runs at import time, so it must NOT log — discovery logs the warning).
   - `Reflect.defineMetadata(PROCESSOR_METADATA_KEY, metadata, target)`.

3. `src/server/decorators/process.decorator.ts` — `Process(jobName?)`:
   - Reads existing `ProcessHandlerMetadata[]` from `target.constructor` (default `[]`), pushes
     `{ jobName, methodKey: propertyKey }`, writes the new array back.

4. `src/server/decorators/on-worker-event.decorator.ts` — exports the union and the decorator:
   ```typescript
   export type WorkerEventName =
     | 'completed' | 'failed' | 'progress' | 'active' | 'stalled' | 'closing' | 'closed' | 'error'
   export function OnWorkerEvent(eventName: WorkerEventName): MethodDecorator
   ```
   - Accumulates `QueueEventListenerMetadata` entries under `WORKER_EVENT_LISTENERS_METADATA_KEY`.
   - JSDoc must state the handler receives the FULL `Job` (use `'progress'` to observe
     `job.updateProgress()`).

5. `src/server/decorators/on-queue-event.decorator.ts` — exports the union and the decorator:
   ```typescript
   export type QueueEventName =
     | 'completed' | 'failed' | 'active' | 'progress' | 'stalled'
     | 'waiting' | 'delayed' | 'paused' | 'resumed' | 'cleaned'
   export function OnQueueEvent(eventName: QueueEventName): MethodDecorator
   ```
   - Accumulates entries under `QUEUE_EVENT_LISTENERS_METADATA_KEY`. JSDoc must state the handler
     receives ids + SERIALIZED payload (not the Job).

6. `src/server/interfaces/processor-metadata.interface.ts` (MODIFY): add an optional
   `_warnedNoConcurrency?: boolean` field to `ProcessorMetadata` (additive, internal flag).

Constraints:
- TS strict, zero `any`. JSDoc on every export. English-only, timeless comments (reference spec
  sections, never plan stages). No suppression comments. Follow `/bymax-workflow:standards`.
- Decorators must be pure metadata writers — no logging, no I/O, no class instantiation.
- `Reflect.getMetadata` returns `undefined` when absent → always default to `[]` before pushing.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: no warnings, no disables.
- `pnpm test src/server/decorators/` — expected: green, 100% line/branch on the decorator files.

Completion Protocol (after you finish):
1. Set this task's status emoji to ✅ in the per-task block and the Task index.
2. Tick the acceptance-criteria checkboxes that are now satisfied.
3. Update the task row in the Task index table.
4. Increment the phase progress counter to `1/6` in the header.
5. Update the Phase 2 status in `docs/development_plan.md` (§3.1 + §1.3 row + Last updated).
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 2.1 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

### Task 2.2 — WorkerRegistry — programmatic + sandboxed + options validation

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: M
- **Depends on**: 2.1, 1.4, 1.5 (Phase 1)

#### Description

Implement `WorkerRegistry`, the service that creates and destroys BullMQ `Worker`s. It exposes `register` (in-process handler, NestJS-DI-backed), `registerSandboxed` (file-based, out-of-process, no DI), `unregister`, and `list`, plus an internal `getAll()` for the shutdown orchestrator. Every worker connection is a `duplicateConnection()` (`maxRetriesPerRequest: null`). It validates options (`concurrency >= 1`, `limiter.max >= 1`, `limiter.duration >= 1`), rejects duplicate registrations for the same queue with `DUPLICATE_PROCESSOR`, and wraps construction failures in `WORKER_REGISTRATION_FAILED`.

#### Acceptance criteria

- [x] `register(config)` creates a `Worker` (handler = function), stores it in the internal `Map`, returns it.
- [x] `register` twice on the same `queueName` throws `QueueException` with code `DUPLICATE_PROCESSOR`.
- [x] Worker connection is obtained via `duplicateConnection(connection.getClient())` (forces `maxRetriesPerRequest: null`).
- [x] `concurrency` defaults to `DEFAULT_WORKER_CONCURRENCY` when omitted; `concurrency: 0` (and `< 1`) throws `WORKER_REGISTRATION_FAILED` with a `reason`.
- [x] `limiter: { max: 0, ... }` or `{ duration: 0 }` throws `WORKER_REGISTRATION_FAILED`.
- [x] `registerSandboxed(config)` creates a file-based worker (processor = path/URL), forwards `useWorkerThreads` when set; duplicate queue → `DUPLICATE_PROCESSOR`.
- [x] `unregister(queueName)` calls `worker.close()` and removes it from the `Map`; unknown queue is a no-op.
- [x] `list()` returns the registered queue names; `getAll()` returns the live `Map`.
- [x] `onModuleDestroy` closes all workers best-effort (a failing `close()` is logged, never thrown) and clears the `Map`.
- [x] JSDoc on every export; no `any`; 100% line/branch coverage.

#### Files to create / modify

- `src/server/services/worker-registry.service.ts` (create)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on @bymax-one/nest-queue.

PROJECT: @bymax-one/nest-queue — a public, fully-typed NestJS wrapper over BullMQ (Job Schedulers
API, ioredis peer dep). Two subpaths (`.`, `./shared`). Zero runtime deps. 100% coverage, Stryker
break 95.

CURRENT PHASE: 2 (Workers) — Task 2.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 2.1 is done: decorators + Symbol metadata keys + `WorkerOptions` exist.
- Phase 1 is done: `ConnectionResolver` (`getClient()`), `duplicateConnection()`
  (`duplicate({ maxRetriesPerRequest: null })`), `QueueException`, `QUEUE_ERROR_CODES`,
  `DEFAULT_WORKER_CONCURRENCY` all exist.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 6.6 (programmatic API — `register`/`registerSandboxed`/
  `unregister`/`list` signatures), § 6.7 (concurrency/limiter policy), § 6.8 (sandboxed file-based
  processors — no DI, file artifact reachable at runtime), § 2.3 (worker connections must be
  duplicated with `maxRetriesPerRequest: null` for blocking commands).
- `docs/development_plan.md` § 3.2 (the `WorkerRegistry` skeleton and acceptance criteria).

TASK
Implement `WorkerRegistry` exactly per the § 3.2 skeleton.

DELIVERABLES

`src/server/services/worker-registry.service.ts`:
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
  private readonly workers = new Map<string, Worker>()
  constructor(private readonly connection: ConnectionResolver) {}

  async register<TData = unknown, TResult = unknown>(
    config: ProgrammaticWorkerConfig<TData, TResult>,
  ): Promise<Worker<TData, TResult>> { /* dup guard → validate → build opts → new Worker → store */ }

  /** File-based, out-of-process (sandboxed) worker — no NestJS DI (§6.8). */
  async registerSandboxed(config: {
    queueName: string
    processorFile: string | URL
    options?: WorkerOptions & { useWorkerThreads?: boolean }
  }): Promise<Worker> { /* dup guard → validate → new Worker(queue, processorFile, opts) */ }

  async unregister(queueName: string): Promise<void> { /* close() + delete */ }
  list(): readonly string[] { return Array.from(this.workers.keys()) }
  getAll(): ReadonlyMap<string, Worker> { return this.workers }   // used by QueueLifecycle
  async onModuleDestroy(): Promise<void> { /* best-effort close all, never throw */ }
  private validateOptions(opts?: WorkerOptions): void { /* concurrency >= 1; limiter max/duration >= 1 */ }
}
```
Key rules:
- Worker connection ALWAYS `duplicateConnection(this.connection.getClient())`.
- `concurrency` default `DEFAULT_WORKER_CONCURRENCY`; only forward `limiter`/`lockDuration`/
  `stalledInterval`/`autorun`/`useWorkerThreads` when defined (respect `exactOptionalPropertyTypes`).
- Duplicate queue → `DUPLICATE_PROCESSOR` (500). `new Worker` throwing → `WORKER_REGISTRATION_FAILED`
  (500, with `cause`). `concurrency < 1` / bad `limiter` → `WORKER_REGISTRATION_FAILED` (with `reason`).
- A sandboxed processor is a FILE PATH/URL (not a function) — that is the ONLY sandboxing mechanism;
  there is no `sandboxed: boolean`.

Constraints:
- TS strict, zero `any` (BullMQ `any` signatures narrowed to the lib's typed shapes). JSDoc on every
  export. English-only, timeless comments. No suppression comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: clean.
- `pnpm test src/server/services/worker-registry.service.spec.ts` — expected: green, 100% line/branch
  (mock `bullmq` `Worker` so no real Redis is needed in the unit suite).

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update index row. 4. Progress `2/6`.
5. Update the Phase 2 status in `docs/development_plan.md` (§3.2 + §1.3 + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`. 7. Append `- 2.2 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 2.3 — QueueEventsRegistry — lazy per-queue QueueEvents

- **Status**: ✅ Done
- **Priority**: P1
- **Size**: S
- **Depends on**: 1.5 (Phase 1)

#### Description

Implement `QueueEventsRegistry`, which lazily creates **one** BullMQ `QueueEvents` per queue (on a duplicated, `maxRetriesPerRequest: null` connection) and caches it. It is the backing store for global `@OnQueueEvent` listeners — a `QueueEvents` connection must only be opened when a queue actually needs one. Exposes `getOrCreate`, `list`, `getAll`, and a best-effort `onModuleDestroy` that closes every `QueueEvents`.

#### Acceptance criteria

- [x] `getOrCreate(queueName)` creates a `QueueEvents` with `connection: duplicateConnection(connection.getClient())` on first call and caches it.
- [x] A second `getOrCreate(queueName)` for the same queue returns the **same** instance (idempotent; no second connection).
- [x] `list()` returns the queue names with an open `QueueEvents`; `getAll()` returns the live `Map`.
- [x] `onModuleDestroy` closes all `QueueEvents` best-effort (failures logged, not thrown) and clears the `Map`.
- [x] JSDoc on every export; no `any`; 100% line/branch coverage.

#### Files to create / modify

- `src/server/services/queue-events-registry.service.ts` (create)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on @bymax-one/nest-queue.

PROJECT: @bymax-one/nest-queue — a public, fully-typed NestJS wrapper over BullMQ. Two subpaths.
Zero runtime deps. 100% coverage, Stryker break 95.

CURRENT PHASE: 2 (Workers) — Task 2.3 of 6 (MIDDLE)

PRECONDITIONS
- Phase 1 is done: `ConnectionResolver` (`getClient()`) and `duplicateConnection()` exist.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 6.5 (global `@OnQueueEvent` is backed by `QueueEvents`; the
  lib opens ONE `QueueEvents` per queue, lazily, only when at least one `@OnQueueEvent` is registered)
  and § 2.3 (the `QueueEvents` connection must be a `duplicate({ maxRetriesPerRequest: null })`).
- `docs/development_plan.md` § 3.3 (the `QueueEventsRegistry` skeleton).

TASK
Implement `QueueEventsRegistry` exactly per the § 3.3 skeleton.

DELIVERABLES

`src/server/services/queue-events-registry.service.ts`:
```typescript
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { QueueEvents } from 'bullmq'
import { ConnectionResolver } from './connection-resolver.service'
import { duplicateConnection } from '../utils/duplicate-connection'

@Injectable()
export class QueueEventsRegistry implements OnModuleDestroy {
  private readonly events = new Map<string, QueueEvents>()
  constructor(private readonly connection: ConnectionResolver) {}

  /** Lazily creates ONE QueueEvents per queue (cached). */
  getOrCreate(queueName: string): QueueEvents {
    const existing = this.events.get(queueName)
    if (existing) return existing
    const qe = new QueueEvents(queueName, { connection: duplicateConnection(this.connection.getClient()) })
    this.events.set(queueName, qe)
    return qe
  }

  list(): readonly string[] { return Array.from(this.events.keys()) }
  getAll(): ReadonlyMap<string, QueueEvents> { return this.events }
  async onModuleDestroy(): Promise<void> { /* close all best-effort, then clear */ }
}
```

Constraints:
- TS strict, zero `any`. JSDoc on every export. English-only, timeless comments. No suppression
  comments. Follow `/bymax-workflow:standards`.
- Do NOT open a `QueueEvents` eagerly — only on `getOrCreate`. The discovery service (Task 2.4)
  calls this only when a queue has at least one `@OnQueueEvent`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: clean.
- `pnpm test src/server/services/queue-events-registry.service.spec.ts` — expected: green, 100%
  line/branch (mock `bullmq` `QueueEvents`).

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update index row. 4. Progress `3/6`.
5. Update the Phase 2 status in `docs/development_plan.md` (§3.3 + §1.3 + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`. 7. Append `- 2.3 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 2.4 — ProcessorDiscoveryService — discover, dispatch & wire events

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 2.1, 2.2, 2.3

#### Description

Implement `ProcessorDiscoveryService`, the heart of the decorator path. In `onModuleInit` it scans every provider via NestJS `DiscoveryService`, finds classes carrying `PROCESSOR_METADATA_KEY`, and for each one: builds a dispatcher (jobName-specific handler first, catch-all fallback), registers a `Worker` through `WorkerRegistry`, binds every `@OnWorkerEvent` listener to that `Worker` (full `Job`), and binds every `@OnQueueEvent` listener to a lazily-created `QueueEvents` (only when the class has at least one). It enforces one processor per queue (`DUPLICATE_PROCESSOR`) and logs the concurrency warning when a `@Processor` carried `_warnedNoConcurrency`.

#### Acceptance criteria

- [x] A class annotated `@Processor('email')` + `@Process()` is discovered on `onModuleInit` and a worker is registered for `email`.
- [x] Two classes annotated `@Processor('email')` → `QueueException` `DUPLICATE_PROCESSOR`.
- [x] The dispatcher routes `job.name === 'send'` to `@Process('send')` and all other names to the `@Process()` catch-all; a job with no matching handler throws a clear error.
- [x] `@OnWorkerEvent('completed'|'progress'|...)` methods are bound to the `Worker` via `worker.on(event, fn.bind(instance))` and receive the **full `Job`** (verified in a unit test that emits `completed` with a `Job` and asserts the handler saw `job.data`).
- [x] `@OnQueueEvent('completed')` methods are bound to the queue's `QueueEvents`; `QueueEventsRegistry.getOrCreate` is called **only** when the class has at least one `@OnQueueEvent`.
- [x] When a `@Processor` carried `_warnedNoConcurrency`, discovery logs a `Logger.warn` naming the `queueName` and the `concurrency=2` fallback; with an explicit `concurrency`, **no** warning is logged.
- [x] Providers without an instance, or without processor metadata, are skipped without error.
- [x] JSDoc on every export; no `any`; 100% line/branch coverage (focus on `buildDispatcher` and the discovery branches).

#### Files to create / modify

- `src/server/services/processor-discovery.service.ts` (create)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on @bymax-one/nest-queue.

PROJECT: @bymax-one/nest-queue — a public, fully-typed NestJS wrapper over BullMQ. Two subpaths.
Zero runtime deps. 100% coverage, Stryker break 95.

CURRENT PHASE: 2 (Workers) — Task 2.4 of 6 (MIDDLE)

PRECONDITIONS
- Task 2.1 done: decorators + Symbol metadata keys (`PROCESSOR_METADATA_KEY`,
  `PROCESS_HANDLERS_METADATA_KEY`, `WORKER_EVENT_LISTENERS_METADATA_KEY`,
  `QUEUE_EVENT_LISTENERS_METADATA_KEY`); `ProcessorMetadata._warnedNoConcurrency`.
- Task 2.2 done: `WorkerRegistry.register(...)`.
- Task 2.3 done: `QueueEventsRegistry.getOrCreate(...)`.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 6.1 (registration patterns), § 6.5 (`@OnWorkerEvent` binds to
  the Worker and gets the full Job; `@OnQueueEvent` binds to a lazy `QueueEvents` and gets ids +
  serialized payload), § 6.5.1 (progress via `@OnWorkerEvent('progress')`), § 6.7 (concurrency
  warning policy).
- `docs/development_plan.md` § 3.3 (the `ProcessorDiscoveryService` skeleton + `buildDispatcher`)
  and § 3.5 (read `_warnedNoConcurrency` and `Logger.warn` during discovery — never log in the
  decorator itself).

TASK
Implement `ProcessorDiscoveryService` exactly per the § 3.3 skeleton, with the § 3.5 warning.

DELIVERABLES

`src/server/services/processor-discovery.service.ts`:
```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { DiscoveryService, MetadataScanner } from '@nestjs/core'
import { Job } from 'bullmq'
import { WorkerRegistry } from './worker-registry.service'
import { QueueEventsRegistry } from './queue-events-registry.service'
import {
  PROCESSOR_METADATA_KEY, PROCESS_HANDLERS_METADATA_KEY,
  WORKER_EVENT_LISTENERS_METADATA_KEY, QUEUE_EVENT_LISTENERS_METADATA_KEY,
} from '../decorators/metadata-keys.constants'
import type {
  ProcessorMetadata, ProcessHandlerMetadata, QueueEventListenerMetadata,
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
    // For each provider whose constructor carries PROCESSOR_METADATA_KEY:
    //   - guard one-processor-per-queue (DUPLICATE_PROCESSOR)
    //   - if processorMeta._warnedNoConcurrency → Logger.warn(queueName, "Defaulting to concurrency=2")
    //   - build dispatcher from PROCESS_HANDLERS_METADATA_KEY
    //   - register the worker via WorkerRegistry.register({ queueName, handler: dispatcher, options })
    //   - bind @OnWorkerEvent listeners to the Worker (worker.on(event, fn.bind(instance))) — FULL Job
    //   - if there are @OnQueueEvent listeners → events.getOrCreate(queueName), bind each to it
  }

  private buildDispatcher(
    instance: Record<string | symbol, unknown>,
    handlers: ProcessHandlerMetadata[],
  ): (job: Job) => Promise<unknown> {
    // jobName-specific via Map, else catch-all; throw a clear Error when nothing matches.
  }
}
```
Key rules:
- Skip providers with no `instance` or no processor metadata (no error).
- `Reflect.getMetadata(...) ?? []` for each listener/handler array.
- `@OnWorkerEvent` → `worker.on(eventName, fn.bind(instance))` (full Job; no extra connection).
- `@OnQueueEvent` → ONLY when present, `events.getOrCreate(queueName)` then `qe.on(eventName, fn.bind(instance))`.
- The concurrency warning is logged HERE (discovery time), driven by `_warnedNoConcurrency`.

Constraints:
- TS strict, zero `any`. Where you must satisfy BullMQ's loose `on(...)` overloads, narrow with the
  lib's own types — do NOT use `@ts-ignore`/`@ts-expect-error`/`eslint-disable`. JSDoc on every
  export. English-only, timeless comments. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: clean.
- `pnpm test src/server/services/processor-discovery.service.spec.ts` — expected: green, 100%
  line/branch. Use a mock `DiscoveryService` (`getProviders()` returns wrappers whose `instance`
  carries metadata) and a mock `Worker`; assert a `completed` emission delivers the FULL `Job` to
  the `@OnWorkerEvent('completed')` handler.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update index row. 4. Progress `4/6`.
5. Update the Phase 2 status in `docs/development_plan.md` (§3.3 + §3.5 + §1.3 + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`. 7. Append `- 2.4 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 2.5 — Module wiring + server barrel exports

- **Status**: ✅ Done
- **Priority**: P1
- **Size**: S
- **Depends on**: 2.2, 2.3, 2.4, 1.8 (Phase 1)

#### Description

Wire the new providers into `BymaxQueueModule`: import `DiscoveryModule`, register `WorkerRegistry`, `QueueEventsRegistry`, and `ProcessorDiscoveryService` as providers, and export `WorkerRegistry` + `QueueEventsRegistry` so consumers can drive dynamic workers. Then extend the server barrel (`src/server/index.ts`) with the decorators, the registries, and the event-name types — per the spec's explicit export list (§3.3), with no deep barrel re-exports.

#### Acceptance criteria

- [x] `bymax-queue.module.ts` imports `DiscoveryModule` and adds `WorkerRegistry`, `QueueEventsRegistry`, `ProcessorDiscoveryService` to `providers`.
- [x] `WorkerRegistry` and `QueueEventsRegistry` are added to `exports` (advanced public surface); `ProcessorDiscoveryService` is **not** exported (internal).
- [x] A fixture app declaring `@Processor` is discovered and a worker is registered (smoke).
- [x] `src/server/index.ts` exports `Processor`, `Process`, `OnWorkerEvent`, `OnQueueEvent`, `WorkerRegistry`, `QueueEventsRegistry`, `ProgrammaticWorkerConfig` (type), `WorkerEventName` (type), `QueueEventName` (type).
- [x] `pnpm build` produces `dist/server/index.{mjs,cjs,d.ts}` with the new symbols; `pnpm typecheck` clean.

#### Files to create / modify

- `src/server/bymax-queue.module.ts` (modify)
- `src/server/index.ts` (modify)

#### Agent prompt

````
You are a senior NestJS/TypeScript library engineer working on @bymax-one/nest-queue.

PROJECT: @bymax-one/nest-queue — a public, fully-typed NestJS wrapper over BullMQ. Two subpaths
(`.`, `./shared`). Zero runtime deps. No deep barrel re-exports (explicit named exports only).

CURRENT PHASE: 2 (Workers) — Task 2.5 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 2.1–2.4 done: decorators, `WorkerRegistry`, `QueueEventsRegistry`,
  `ProcessorDiscoveryService` all exist and pass their unit suites.
- Phase 1 is done: `BymaxQueueModule.forRoot()` (ConfigurableModuleBuilder, `isGlobal` via
  `setExtras`) and `src/server/index.ts` exist with the Phase 1 exports.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 3.3 (Exports per subpath — the exact server export list,
  including the decorators, `WorkerRegistry` as the advanced surface, and the BullMQ type re-exports).
- `docs/development_plan.md` § 3.4 (module integration change + index export additions).

TASK
Register the new providers in the module and extend the server barrel.

DELIVERABLES

1. `src/server/bymax-queue.module.ts` (MODIFY): inside the `forRoot` definition assembly, add
   `imports: [DiscoveryModule]` (from `@nestjs/core`), append `WorkerRegistry`,
   `QueueEventsRegistry`, `ProcessorDiscoveryService` to `providers`, and add `WorkerRegistry`,
   `QueueEventsRegistry` to `exports` (keep `...base`/`...providers` carrying Phase 1 wiring; do NOT
   drop the `global` flag set by `setExtras`). `ProcessorDiscoveryService` stays internal (not exported).

2. `src/server/index.ts` (MODIFY): add the explicit named exports:
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

Constraints:
- TS strict, zero `any`. JSDoc where a new export needs it. English-only, timeless comments. No
  suppression comments. No deep barrel re-exports. Follow `/bymax-workflow:standards`.

Verification:
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: clean.
- `pnpm build` — expected: emits `dist/server/index.{mjs,cjs,d.ts}`.
- `node -e "import('./dist/server/index.mjs').then(m => console.log(['Processor','Process','OnWorkerEvent','OnQueueEvent','WorkerRegistry','QueueEventsRegistry'].every(k => k in m)))"`
  — expected: `true`.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update index row. 4. Progress `5/6`.
5. Update the Phase 2 status in `docs/development_plan.md` (§3.4 + §1.3 + Last updated).
6. Recompute the overall progress percentage in `docs/development_plan.md`. 7. Append `- 2.5 ✅ <YYYY-MM-DD> — <summary>`.
````

---

### Task 2.6 — Phase 2 unit tests, 100% coverage & phase validation

- **Status**: ✅ Done
- **Priority**: P0
- **Size**: L
- **Depends on**: 2.1, 2.2, 2.3, 2.4, 2.5

#### Description

Author the unit suites for every file implemented in Phase 2 and drive line/branch coverage to 100%, then run the phase validation gate. Tests must cover the decorator metadata (defaults, accumulation, separate keys), `WorkerRegistry` (register/registerSandboxed/unregister/list, duplicate guards, options validation), `QueueEventsRegistry` (lazy idempotency, shutdown), and `ProcessorDiscoveryService` (mock `DiscoveryService`, dispatcher routing, the concurrency warning, and the critical assertion that an `@OnWorkerEvent` handler receives the **full `Job`**). Close the phase against the Global Done criteria (§1.4) and the §3.7 smoke test.

#### Acceptance criteria

- [x] Spec files exist for all four decorators, `WorkerRegistry`, `ProcessorDiscoveryService`, and `QueueEventsRegistry`.
- [x] `@OnWorkerEvent` test asserts the bound handler is invoked with the full `Job` (the listener reads `job.data`/`job.returnvalue`), distinguishing it from the serialized `@OnQueueEvent` payload.
- [x] Dispatcher tests cover jobName-specific match, catch-all fallback, and the no-matching-handler error branch.
- [x] `WorkerRegistry` tests cover the duplicate guard, `concurrency < 1`, bad `limiter`, sandboxed registration, `unregister` no-op, and `onModuleDestroy` close-all-without-throw.
- [x] `QueueEventsRegistry` test asserts a second `getOrCreate` returns the same instance and does not open a second connection.
- [x] `pnpm test:cov:all` reports **100% line/branch** on every Phase 2 file (`jest.coverage.config.ts` thresholds `100/100/100/100`).
- [x] `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build` all pass.
- [x] `/bymax-quality:code-review` run and findings applied.

#### Files to create / modify

- `src/server/decorators/processor.decorator.spec.ts` (create)
- `src/server/decorators/process.decorator.spec.ts` (create)
- `src/server/decorators/on-worker-event.decorator.spec.ts` (create)
- `src/server/decorators/on-queue-event.decorator.spec.ts` (create)
- `src/server/services/worker-registry.service.spec.ts` (create)
- `src/server/services/processor-discovery.service.spec.ts` (create)
- `src/server/services/queue-events-registry.service.spec.ts` (create)

#### Agent prompt

````
You are a senior NestJS/TypeScript test engineer working on @bymax-one/nest-queue.

PROJECT: @bymax-one/nest-queue — a public, fully-typed NestJS wrapper over BullMQ. Quality floor is
100% line/branch coverage per file (Jest, `jest.coverage.config.ts` → 100/100/100/100); Stryker
break 95 runs pre-release. Tests run with a bounded worker pool — never fan out parallel agents.

CURRENT PHASE: 2 (Workers) — Task 2.6 of 6 (LAST)

PRECONDITIONS
- Tasks 2.1–2.5 done: decorators, `WorkerRegistry`, `QueueEventsRegistry`,
  `ProcessorDiscoveryService`, and the module wiring all exist.

REQUIRED READING (only these):
- `docs/technical_specification.md` § 6.5 (the FULL-Job `@OnWorkerEvent` vs serialized `@OnQueueEvent`
  distinction — the key behavior a test must lock down), § 6.6 / § 6.7 / § 6.8 (registry behavior).
- `docs/development_plan.md` § 3.6 (critical test cases) and § 3.7 (phase validation + smoke test +
  Done criteria), § 1.4 (Global Done criteria per phase).

TASK
Write the seven unit suites and bring every Phase 2 file to 100% line/branch coverage, then run the
phase-validation gate. Mock `bullmq` (`Worker`, `QueueEvents`, `Job`) and NestJS `DiscoveryService`/
`MetadataScanner` so the unit suite needs no real Redis. Keep one `it()` per behavior with a short
descriptive comment.

DELIVERABLES (create all seven `.spec.ts` files listed in "Files to create / modify")
Critical cases to cover:
- Decorators: metadata written, defaults applied, options merged, `_warnedNoConcurrency` set when
  `concurrency` omitted; multiple `@Process`/`@OnWorkerEvent`/`@OnQueueEvent` accumulate under the
  correct (separate) Symbol keys.
- WorkerRegistry: register/registerSandboxed/unregister/list; `DUPLICATE_PROCESSOR`;
  `concurrency < 1` and bad `limiter` → `WORKER_REGISTRATION_FAILED`; `onModuleDestroy` closes all
  without throwing even when a `close()` rejects.
- ProcessorDiscoveryService: mock `DiscoveryService.getProviders()` returns wrappers whose `instance`
  carries metadata; dispatcher routes jobName-specific → catch-all → throws when nothing matches;
  `@OnWorkerEvent('completed')` handler is invoked with the FULL `Job` (assert it reads `job.data`);
  `@OnQueueEvent` binds to `QueueEvents` only when present; the concurrency warning fires for a
  `_warnedNoConcurrency` processor and NOT for one with explicit `concurrency`.
- QueueEventsRegistry: lazy idempotency (same instance on second call); `onModuleDestroy` closes all.

Constraints:
- TS strict in tests too; zero `any` (cast mocks through typed helpers, not `as any`). No suppression
  comments. English-only, timeless comments. Follow `/bymax-workflow:standards`. Do NOT relax the
  coverage thresholds to make the gate pass — add the missing tests instead.

Verification (run sequentially, in the main agent — never parallel test fan-out):
- `pnpm typecheck` — expected: no errors.
- `pnpm lint` — expected: clean.
- `pnpm test:cov:all` — expected: green, 100% line/branch on every Phase 2 file.
- `pnpm build` — expected: emits `dist/server/index.{mjs,cjs,d.ts}`.
- Smoke (§3.7): run `/tmp/smoke-phase2.mjs` against a local Redis — expected: the enqueued job is
  processed and the `@OnQueueEvent('completed')` listener logs the completion.
- `/bymax-quality:code-review` — expected: run and findings applied.

Completion Protocol:
1. Status ✅ (block + index). 2. Tick AC. 3. Update index row. 4. Progress `6/6` in the header.
5. Update the Phase 2 status in `docs/development_plan.md` — mark Phase 2 done (§3.6 + §3.7 + §1.3
   row + Last updated) once all six tasks are ✅.
6. Recompute the overall progress in `docs/development_plan.md`.
7. Append a completion-log entry: `- 2.6 ✅ <YYYY-MM-DD> — <one-line summary>`.
````

---

## Completion log

> Append-only. One line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`.

- 2.1 ✅ 2026-06-26 — Four worker decorators + Symbol metadata keys implemented; `@Processor` applies concurrency defaults and `_warnedNoConcurrency` flag; `@Process`, `@OnWorkerEvent`, `@OnQueueEvent` accumulate entries under separate Symbol keys.
- 2.2 ✅ 2026-06-26 — `WorkerRegistry` implemented; synchronous `register`/`registerSandboxed`, async `unregister`/`onModuleDestroy` with best-effort close; validates concurrency and limiter; wraps BullMQ constructor errors in `WORKER_REGISTRATION_FAILED`.
- 2.3 ✅ 2026-06-26 — `QueueEventsRegistry` implemented; lazily creates one `QueueEvents` per queue on `duplicateConnection`; idempotent `getOrCreate`; best-effort `onModuleDestroy`.
- 2.4 ✅ 2026-06-26 — `ProcessorDiscoveryService` implemented; discovers `@Processor` classes via NestJS `DiscoveryService`; builds named-handler dispatcher with catch-all fallback; wires `@OnWorkerEvent` to Worker (full Job) and `@OnQueueEvent` to lazy `QueueEvents`; enforces one-processor-per-queue and logs concurrency warning.
- 2.5 ✅ 2026-06-26 — `BymaxQueueModule` extended with `DiscoveryModule` import, `WorkerRegistry`/`QueueEventsRegistry`/`ProcessorDiscoveryService` providers, and `WorkerRegistry`/`QueueEventsRegistry` exports; server barrel updated with all Phase 2 exports.
- 2.6 ✅ 2026-06-26 — Seven unit spec files created; 140 tests, 100% statements/branches/functions/lines; typecheck, lint, build, and size all passing; code and security reviews applied.
