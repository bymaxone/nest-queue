# @bymax-one/nest-queue — Complete Technical Specification

> **Spec revision:** 2.0.0 — aligned to the Bymax Lib Standard and to the current BullMQ API
> **Last updated:** 2026-06-23
> **Status:** Draft for implementation
> **Type:** Public npm package (`@bymax-one/nest-queue`)
> **Target engine:** BullMQ `^5.16.0` (validated against `5.79.1`, the current release at the time of writing)
> **Origin:** Consolidates and supersedes an internal hand-rolled BullMQ helper (~154 LoC) used in a production NestJS app, re-designed as a public, fully-typed library.

---

## Table of Contents

0. [Alignment with the Bymax Lib Standard](#0-alignment-with-the-bymax-lib-standard)
1. [Vision and Value Proposition](#1-vision-and-value-proposition)
2. [Architecture](#2-architecture)
3. [Package Structure](#3-package-structure)
4. [Configuration API](#4-configuration-api)
5. [Main Service](#5-main-service)
6. [Workers](#6-workers)
7. [Flows](#7-flows)
8. [Job Schedulers (repeatable / cron jobs)](#8-job-schedulers-repeatable--cron-jobs)
9. [Metrics and Health Check](#9-metrics-and-health-check)
10. [Delivery Semantics and Shutdown Strategy](#10-delivery-semantics-and-shutdown-strategy)
11. [Integration with `@bymax-one/nest-cache`](#11-integration-with-bymax-onenest-cache)
12. [Error Code Catalog](#12-error-code-catalog)
13. [What is NOT in the package](#13-what-is-not-in-the-package)
14. [Dependencies](#14-dependencies)
15. [Implementation Phases](#15-implementation-phases)
16. [Known Limitations](#16-known-limitations)
17. [Example Integration](#17-example-integration)
18. [Testing Strategy and Quality Gates](#18-testing-strategy-and-quality-gates)
19. [CI/CD and Release Engineering](#19-cicd-and-release-engineering)
20. [Versioning and Migration Policy](#20-versioning-and-migration-policy)
21. [Comparison with `@nestjs/bullmq`](#21-comparison-with-nestjsbullmq)
- [Appendix A — Relevant architectural decisions](#appendix-a--relevant-architectural-decisions)
- [Appendix B — Security checklist](#appendix-b--security-checklist)

---

## 0. Alignment with the Bymax Lib Standard

This spec follows the cross-portfolio Bymax public-library standard (the same one applied to `@bymax-one/nest-logger`, `@bymax-one/nest-cache`, and `@bymax-one/nest-notification`). The following are **normative invariants** for this package; where the body of the document and these invariants ever disagree, these win.

1. **Dynamic module via `ConfigurableModuleBuilder`.** The module is built on `@nestjs/common`'s `ConfigurableModuleBuilder`, exposing `forRoot()` / `forRootAsync()`. Global scope is opted-in through `isGlobal` mapped to `DynamicModule.global` via `setExtras` — **not** a hand-written `@Global()` decorator.
2. **Quality floor.** 100% line/branch coverage on every implemented file (enforced by `jest.coverage.config.ts` thresholds set to `100/100/100/100`); Stryker mutation testing with `{ high: 99, low: 95, break: 95 }`, targeting 100%, run as a **pre-release gate** (not on every commit).
3. **Bundle budget** measured in **KiB brotli** by `scripts/check-size.mjs` (not "KB gzipped").
4. **Recurring jobs use the current BullMQ Job Schedulers API** (`upsertJobScheduler` / `removeJobScheduler` / `getJobSchedulers`). The legacy "repeatable jobs" API (`addRepeatable` / `removeRepeatable` / `getRepeatableJobs`) is **deprecated and removed in BullMQ v6** and must not appear in the public surface.
5. **Observability and deduplication are first-class**, not consumer responsibilities: the module accepts a BullMQ `telemetry` instance (OpenTelemetry via `bullmq-otel`) and exposes BullMQ native `deduplication` options through `enqueue`.
6. **English everywhere** — code, comments, JSDoc, identifiers, commit messages, and every file under `docs/`.
7. **Repo-as-config files are mandatory deliverables** and appear in the package tree: `SECURITY.md`, `CLAUDE.md`, `AGENTS.md`, `commitlint.config.cjs`, and the four Copilot review files (`.github/copilot-instructions.md`, `.github/instructions/code.instructions.md`, `.github/instructions/tests.instructions.md`, `.github/agents/agent-code-reviewer.agent.md`).
8. **Planning docs are English and kept in sync with this spec:** `development_plan.md` holds the phased plan + status dashboard, and detailed executable tasks live one-file-per-phase under `docs/tasks/phase-NN-<slug>.md` (the rust-auth layout). Each phase file carries a JIRA-style task index, acceptance criteria, exact file paths, and a self-contained agent prompt per task.
9. **CI hard gates:** lint + typecheck + 100% coverage, CodeQL, OpenSSF Scorecard ≥ 7.0, OSV-Scanner, TruffleHog OSS (secret scan), and npm publish with **provenance** (OIDC trusted publishing). GitHub Actions are pinned by commit SHA.
10. **A dogfood example app** (`nest-queue-example`) consumes the published package end-to-end before each release.

---

## 1. Vision and Value Proposition

### 1.1 What `@bymax-one/nest-queue` is

`@bymax-one/nest-queue` is a **NestJS wrapper over BullMQ** that standardizes the use of job queues across applications in the Bymax ecosystem. The package encapsulates queue creation, worker registration, flows (hierarchical jobs), Job Schedulers (recurring / cron jobs), and the Redis connection lifecycle in a dynamic module (`forRoot` / `forRootAsync`) with end-to-end strong typing.

The lib does not reimplement BullMQ — it **orchestrates** BullMQ inside the NestJS container:

- Resolves the Redis connection in **dual mode** (brings its own connection from `@bymax-one/nest-cache` **or** opens its own connection from config), applying the correct `maxRetriesPerRequest` policy per connection role (see §2.3).
- Applies consistent `defaultJobOptions` (exponential retry, completed/failed job retention, priority).
- Exposes a central `QueueService` with typed helpers (`enqueue<T>`, `enqueueBulk<T>`, `upsertJobScheduler`, `getJob`, `getJobs`, `getMetrics`), including native BullMQ **deduplication** options on `enqueue`.
- Offers the `@Processor()` decorator and programmatic API to register workers, with safe defaults (`concurrency`, `rate limiting`) and both worker-local (`@OnWorkerEvent`, full `Job`) and global (`@OnQueueEvent`) event hooks.
- Supports **Flow Producers** (BullMQ Flows) for job graphs with parent/child dependencies.
- Accepts an optional **OpenTelemetry** `telemetry` instance so spans propagate from `enqueue` through the handler.
- Manages graceful shutdown (worker close with bounded drain, queue close, disconnect) under explicit at-least-once semantics.

### 1.2 Why it exists

In any NestJS architecture that uses BullMQ "by hand", there are five recurring frictions that this lib resolves:

1. **Redis connection dedicated to BullMQ**: BullMQ's **worker** connection must set `maxRetriesPerRequest: null` because workers issue long-lived blocking commands (`BRPOPLPUSH`, `BZPOPMIN`, `BLMOVE`); BullMQ throws at `Worker` construction otherwise. The plain **Queue** connection, by contrast, should keep ioredis' default retry count so a transient Redis outage makes `enqueue` fail fast instead of hanging. Getting this per-role policy right by hand — and not mixing it with the app's cache client — is error-prone.
2. **Ad-hoc `defaultJobOptions`**: without a central place, each team defines retry, backoff, and retention inconsistently.
3. **Workers without explicit `concurrency`**: BullMQ's default of 1 is silently serial. Without a pattern like `DEFAULT_WORKER_CONCURRENCY`, nobody notices.
4. **Weak job typing**: most integrations fall into `Job<any, any>`, losing compile-time checks.
5. **Disordered shutdown**: queues and workers are left open in `onModuleDestroy`, holding the process on `SIGTERM`.

The lib resolves each of these frictions with sensible defaults and a typed API.

### 1.3 Who uses it

- **NestJS applications** that need asynchronous processing queues (email sending, report generation, AI processing, webhooks, etc.).
- **Multi-tenant SaaS apps** that need per-tenant prefix isolation (`prefix: 'tenant:foo:bullmq'`).
- **Standalone workers** running in separate containers consuming the same queues (the lib registers workers identically in any NestJS application).

### 1.4 Distribution model

| Aspect     | Detail                                   |
| ---------- | ---------------------------------------- |
| Registry   | Public npm (`@bymax-one/nest-queue`)     |
| Cost       | Zero — open source package               |
| License    | MIT                                      |
| Runtime    | Node.js 24+                              |
| Framework  | NestJS 11+ (server)                      |
| Engine     | BullMQ `^5.16.0` (Job Schedulers API)    |
| Subpaths   | `.` (server), `./shared`                 |
| Size       | ≤ 18 KiB brotli (`check-size.mjs` target) |

### 1.5 Design principles

1. **Configuration over convention** — everything configurable via `forRoot()` / `forRootAsync()`, with sensible defaults.
2. **Dependency inversion over connection** — the lib accepts a `Redis` (ioredis) injected by another module (mode A) or opens its own connection from config (mode B). **Never reads environment variables directly**.
3. **Zero opinion on persistence** — BullMQ uses Redis as storage; the lib does not persist anything else. History, dashboards, and auditing are the consumer's responsibility.
4. **End-to-end typing** — `enqueue<TData, TResult>()`, `Job<TData, TResult>`, workers typed via decorator generics.
5. **Safe defaults** — retry with exponential backoff (3 attempts), minimum explicit `concurrency` of 2, retention of 24h for completed and 7d for failed.
6. **No deep barrel re-exports** — direct exports in `src/server/index.ts` to ensure tree-shaking.
7. **English in code, English in documentation** — aligned with the `@bymax-one/nest-*` portfolio standard.
8. **Current API only** — recurring jobs use BullMQ Job Schedulers (`upsertJobScheduler`); deduplication and OpenTelemetry are first-class passthroughs, never re-implemented and never deferred to the consumer. The public surface never exposes a BullMQ method that BullMQ itself has deprecated.

### 1.6 Feature categorization

The package organizes its surface into three layers with distinct activation levels:

#### Core (always active)

| Component             | Responsibility                                                            |
| --------------------- | ------------------------------------------------------------------------- |
| **BymaxQueueModule**  | Dynamic module with `forRoot()` / `forRootAsync()`                        |
| **QueueService**      | Factory and cache of `Queue<T>`, helpers `enqueue/getJob/getJobs/getMetrics` |
| **WorkerRegistry**    | Centralized registry of workers (programmatic and decorator-based)        |
| **ConnectionResolver** | Resolves the `Redis` in mode A (injected) or mode B (own)                |
| **QueueLifecycle**    | `onModuleDestroy` orchestrates drain + close of queues and workers        |

#### Opt-in extensions (via configuration)

| Component          | Activation                                | Responsibility                                            |
| ------------------ | ----------------------------------------- | --------------------------------------------------------- |
| **FlowService**    | `flows: { enabled: true }`                | Wrapper over `FlowProducer` for hierarchical jobs         |
| **MetricsService** | `metrics: { enabled: true }`              | `getJobCounts()` collection + light cache for health checks |

#### Decorators (always available, opt-in by the developer)

| Decorator              | Purpose                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| **@Processor(queue)**  | Marks a class as a processor for a specific queue                                        |
| **@Process(jobName?)** | Marks a method as a job handler (filters by optional `jobName`)                          |
| **@OnWorkerEvent()**   | Worker-local listener — handler receives the full `Job` (`completed`, `failed`, `progress`, `active`) |
| **@OnQueueEvent()**    | Global (cross-instance) listener via `QueueEvents` — receives `jobId` + serialized payload |

> **Principle:** when `flows` or `metrics` are not configured, their providers are **not registered** in the NestJS container, avoiding overhead and unnecessary dependencies. The same applies to `QueueEvents`: a global-events connection is opened only when at least one `@OnQueueEvent` is registered for a queue (worker-local `@OnWorkerEvent` listeners need no extra connection).

---

## 2. Architecture

### 2.1 NestJS dynamic module pattern

`@bymax-one/nest-queue` uses the NestJS **Dynamic Module** pattern. The lib **is not a separate service** — it runs **inside each NestJS application** as an imported module. The host application controls:

- The Redis connection (mode A: injects; mode B: lib opens)
- The global job defaults (`defaultJobOptions`)
- The Redis key prefix (`prefix`)
- Which workers are registered (via decorator or programmatically)

```
┌──────────────────────────────────────────────────┐
│           Host Application (NestJS)              │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │       @bymax-one/nest-queue module          │  │
│  │                                            │  │
│  │  QueueService ←→ WorkerRegistry ←→ Redis   │  │
│  │       ↕              ↕              ↕      │  │
│  │  FlowService    @Processor()     BullMQ    │  │
│  │       ↕              ↕                     │  │
│  │  MetricsService  QueueLifecycle            │  │
│  └────────┬───────────────────────────────────┘  │
│           │                                      │
│    ┌──────▼──────┐  (mode A)                     │
│    │ ioredis     │ ←── injected by               │
│    │ (shared)    │    @bymax-one/nest-cache      │
│    └─────────────┘                               │
│                                                  │
│    OR (mode B)                                   │
│                                                  │
│    ┌─────────────┐                               │
│    │ ioredis     │ ←── opened by the lib from    │
│    │ (own)       │    connection: { ... }        │
│    └─────────────┘                               │
└──────────────────────────────────────────────────┘
```

### 2.2 Connection modes

The lib accepts **two mutually exclusive modes** of providing the Redis connection to BullMQ. The choice is made by the presence of one of the two keys in `BymaxQueueModuleOptions`:

#### Mode A — Bring Your Own Connection

The application injects an already-configured `Redis` (typically coming from `@bymax-one/nest-cache.getClientForQueue()`). The lib **does not create** nor **close** that connection — it only uses it.

```typescript
BymaxQueueModule.forRootAsync({
  imports: [BymaxCacheModule],
  inject: [BYMAX_CACHE_QUEUE_REDIS],
  useFactory: (queueRedis: Redis) => ({
    connection: { client: queueRedis },
    defaultJobOptions: { attempts: 3 }
  })
})
```

#### Mode B — Open Your Own Connection

The lib receives connection parameters (URL or `RedisOptions` object) and internally creates a dedicated `ioredis`. The connection is closed in `onModuleDestroy`.

```typescript
BymaxQueueModule.forRoot({
  connection: {
    url: process.env.REDIS_URL,
    // or:
    host: 'localhost',
    port: 6379,
    db: 1,
    // Queue connection keeps default retries; the lib duplicates this with
    // maxRetriesPerRequest:null for worker/QueueEvents connections (see §2.3)
  },
  defaultJobOptions: { attempts: 3 }
})
```

> **Important — per-role retry policy.** The lib does **not** blindly force `maxRetriesPerRequest: null` on every connection. It applies the BullMQ-recommended policy per connection role:
>
> - **Queue / FlowProducer connection** — keeps the default retry count so that `enqueue` fails fast during a Redis outage rather than blocking the caller indefinitely.
> - **Worker / QueueEvents connection** — must be `maxRetriesPerRequest: null`. The lib obtains these via `client.duplicate({ maxRetriesPerRequest: null })`, so the override is applied even when the shared client (mode A) was created with a different value.
>
> In **mode A**, `onModuleInit` inspects the injected client: if a worker is going to be registered and the duplicated worker connection cannot be coerced to `null` (e.g. a wrapper that ignores the override), the lib **fails fast** with `queue.connection_requires_null_retries` instead of letting BullMQ crash later at `Worker` construction. See §2.3.

### 2.3 Connection sharing strategy

BullMQ requires **separate** connections for blocking consumers: a `Worker` (and each `QueueEvents`) holds a connection busy on long-lived blocking commands (`BRPOPLPUSH`, `BZPOPMIN`, `BLMOVE`), so it cannot share the same socket as the non-blocking `Queue`. The lib implements the following rules:

| Component          | Connection used (mode A)                                              | Connection used (mode B)                                              | `maxRetriesPerRequest` |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------- |
| `Queue`            | Received client (shared across all Queues)                            | Main client opened by the lib                                         | default (fail-fast)    |
| `FlowProducer`     | Received client                                                       | Main client opened by the lib                                         | default (fail-fast)    |
| `Worker`           | `client.duplicate({ maxRetriesPerRequest: null })` (one per worker)   | `client.duplicate({ maxRetriesPerRequest: null })` (one per worker)   | `null` (blocking)      |
| `QueueEvents`      | `client.duplicate({ maxRetriesPerRequest: null })` (one per queue)    | `client.duplicate({ maxRetriesPerRequest: null })` (one per queue)    | `null` (blocking)      |

Connection duplication — and the per-role `maxRetriesPerRequest` override — is internally managed by `ConnectionResolver`. The consumer does not need to think about it.

### 2.4 Initialization flow

1. The application calls `BymaxQueueModule.forRootAsync({ ... })`.
2. The module resolves the options via factory or ConfigService.
3. `ConnectionResolver` decides the mode (A or B) by inspecting `options.connection`.
4. In mode A, it validates the received `Redis` is usable for the Queue role (`status === 'ready' | 'connecting'`). It does **not** require `maxRetriesPerRequest === null` on the received client — the Queue role keeps default retries and worker connections are duplicated with `null` (see §2.3). It fails fast only if a worker connection cannot be coerced to `null`.
5. In mode B, it opens `ioredis` for the Queue role and waits for the `ready` event (with a fixed 10s connect timeout, after which it fails fast with `queue.connection_timeout`).
6. Providers are conditionally registered: `FlowService` only if `flows.enabled`; `MetricsService` only if `metrics.enabled`. If a `telemetry` instance is configured, it is passed to every `Queue`/`Worker` constructed.
7. The module applies `discover()` (via NestJS `DiscoveryService`) to find classes annotated with `@Processor()` and register their workers.
8. The module is ready to receive `enqueue()` calls and process jobs.

### 2.5 Job flow (enqueue → process)

```
Application calls enqueue<TData, TResult>(queueName, jobName, data)
    │
    ▼
QueueService.getOrCreateQueue(queueName)
    │
    ▼
Queue<TData, TResult>.add(jobName, data, { ...defaultJobOptions, ...opts })
    │
    ▼ (BullMQ persists in Redis)
    │
    ▼ (Registered worker pulls the job)
WorkerRegistry → Processor class → @Process method
    │
    ▼
Method returns TResult (or throws)
    │
    ▼
BullMQ marks as completed/failed and emits events
    │
    ▼ (optional)
QueueEvents listener (@OnQueueEvent) runs side-effect
```

---

## 3. Package Structure

### 3.1 Complete directory tree

The package is organized in 2 subpaths with distinct responsibilities:

```
@bymax-one/nest-queue/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsconfig.server.json
├── tsconfig.e2e.json
├── tsconfig.jest.json
├── tsup.config.ts
├── src/
│   ├── server/                              # NestJS backend
│   │   ├── index.ts                         # Barrel export (server)
│   │   ├── bymax-queue.module.ts            # Root dynamic module
│   │   ├── bymax-queue.constants.ts         # Injection tokens (Symbol)
│   │   ├── interfaces/
│   │   │   ├── queue-module-options.interface.ts
│   │   │   ├── queue-connection.interface.ts
│   │   │   ├── queue-job-data.interface.ts
│   │   │   ├── worker-options.interface.ts
│   │   │   └── processor-metadata.interface.ts
│   │   ├── config/
│   │   │   ├── default-options.ts           # DEFAULT_JOB_OPTIONS, DEFAULT_WORKER_CONCURRENCY
│   │   │   └── resolved-options.ts          # mergeOptions(user, defaults)
│   │   ├── services/
│   │   │   ├── queue.service.ts             # Public — enqueue, getJob, getMetrics
│   │   │   ├── worker-registry.service.ts   # Internal — register/unregister workers
│   │   │   ├── flow.service.ts              # Opt-in — FlowProducer wrapper
│   │   │   ├── metrics.service.ts           # Opt-in — getJobCounts cache
│   │   │   └── connection-resolver.service.ts  # Internal — mode A/B resolution
│   │   ├── decorators/
│   │   │   ├── processor.decorator.ts        # @Processor(queueName)
│   │   │   ├── process.decorator.ts          # @Process(jobName?)
│   │   │   ├── on-worker-event.decorator.ts  # @OnWorkerEvent('completed' | ...) — full Job
│   │   │   └── on-queue-event.decorator.ts   # @OnQueueEvent('completed' | ...) — global
│   │   ├── lifecycle/
│   │   │   └── queue-lifecycle.service.ts   # onModuleDestroy: drain + close
│   │   ├── errors/
│   │   │   ├── queue-error-codes.ts          # QUEUE_ERROR_MESSAGES + QUEUE_ERROR_STATUS (code→HTTP); re-exports QUEUE_ERROR_CODES from shared
│   │   │   └── queue-exception.ts            # QueueException
│   │   └── utils/
│   │       ├── duplicate-connection.ts      # ioredis duplicate({ maxRetriesPerRequest: null }) for blocking conns
│   │       └── validate-connection.ts       # assert duplicated worker conn resolves to maxRetriesPerRequest === null
│   │
│   └── shared/                              # Types and constants (zero deps)
│       ├── index.ts
│       ├── types/
│       │   ├── job-status.types.ts          # JobStatus union
│       │   ├── queue-metrics.types.ts       # QueueMetrics interface
│       │   └── job-scheduler-options.types.ts  # JobSchedulerRepeatOptions
│       └── constants/
│           ├── job-status.ts                # JOB_STATUS constants
│           └── error-codes.ts               # QUEUE_ERROR_CODES
│
├── test/                                    # E2E tests with testcontainers
│   └── queue.e2e-spec.ts
├── scripts/
│   └── check-size.mjs                        # bundle budget gate (KiB brotli)
├── .github/
│   ├── workflows/                            # ci.yml, codeql.yml, release.yml, scorecard.yml, osv-scanner.yml
│   ├── copilot-instructions.md               # repo-wide Copilot review config
│   ├── instructions/
│   │   ├── code.instructions.md
│   │   └── tests.instructions.md
│   └── agents/
│       └── agent-code-reviewer.agent.md
├── docs/
│   ├── technical_specification.md
│   ├── development_plan.md                   # phased plan + status dashboard
│   ├── mutation_testing_plan.md
│   ├── mutation_testing_results.md
│   └── tasks/                                # one file per phase (executable agent prompts)
│       ├── phase-01-foundation.md
│       ├── phase-02-workers.md
│       ├── phase-03-flows-schedulers-metrics.md
│       ├── phase-04-async-shutdown-e2e.md
│       └── phase-05-release.md
├── eslint.config.mjs
├── jest.config.ts
├── jest.coverage.config.ts                   # thresholds 100/100/100/100
├── jest.e2e.config.ts
├── jest.stryker.config.ts
├── stryker.config.json                       # break 95, high 99, low 95
├── commitlint.config.cjs                     # Conventional Commits
├── SECURITY.md
├── CLAUDE.md
├── AGENTS.md
├── README.md
├── LICENSE
└── CHANGELOG.md
```

### 3.2 Subpath exports

The package uses the `exports` field of `package.json` to expose two entry points with automatic tree-shaking:

| Subpath      | Entry point             | Description                                                  | Dependencies                  |
| ------------ | ----------------------- | ------------------------------------------------------------ | ----------------------------- |
| `.` (server) | `dist/server/index.js`  | NestJS module, services, decorators, FlowProducer            | NestJS 11, bullmq, ioredis    |
| `./shared`   | `dist/shared/index.js`  | Types and constants (job status, error codes, metrics)       | Zero                          |

```json
{
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
  }
}
```

### 3.3 Exports per subpath

**Server (`@bymax-one/nest-queue`):**

```typescript
// Main module
export { BymaxQueueModule } from './bymax-queue.module'

// Injection tokens (Symbol)
export {
  BYMAX_QUEUE_OPTIONS,
  BYMAX_QUEUE_REDIS_CLIENT,
  BYMAX_QUEUE_CONNECTION_MODE
} from './bymax-queue.constants'

// Public services
export { QueueService } from './services/queue.service'
export { FlowService } from './services/flow.service'
export { MetricsService } from './services/metrics.service'
export { WorkerRegistry } from './services/worker-registry.service' // advanced — dynamic workers

// Decorators
export { Processor } from './decorators/processor.decorator'
export { Process } from './decorators/process.decorator'
export { OnWorkerEvent } from './decorators/on-worker-event.decorator'
export { OnQueueEvent } from './decorators/on-queue-event.decorator'

// Interfaces (types)
export type {
  BymaxQueueModuleOptions,
  BymaxQueueModuleAsyncOptions,
  QueueConnectionConfig,
  WorkerOptions,
  ProcessorMetadata
} from './interfaces'

// Errors and constants
export { QueueException } from './errors/queue-exception'
// QUEUE_ERROR_CODES is defined once in ./shared (zero-dep) and re-exported by the
// server barrel; QUEUE_ERROR_MESSAGES (the human-readable map) lives with the codes.
export { QUEUE_ERROR_CODES, QUEUE_ERROR_MESSAGES } from './errors/queue-error-codes'
export { DEFAULT_WORKER_CONCURRENCY, DEFAULT_JOB_OPTIONS } from './config/default-options'

// Re-exports BullMQ types for convenience (we do not duplicate the lib)
export type {
  Job, JobsOptions, Queue, Worker, FlowProducer, FlowJob, JobNode,
  JobSchedulerJson, Telemetry, SandboxedJob
} from 'bullmq'
```

**Shared (`@bymax-one/nest-queue/shared`):**

```typescript
// Types (zero deps)
export type { JobStatus, QueueMetrics, JobSchedulerRepeatOptions } from './types'

// Constants (zero deps) — QUEUE_ERROR_CODES is the single source of truth,
// re-exported by the server barrel above.
export { JOB_STATUS, QUEUE_ERROR_CODES } from './constants'
```

> **Public vs internal API:** `QueueService`, `FlowService` (if enabled), and `MetricsService` (if enabled) are the primary public services. `WorkerRegistry` is also exported, but as an **advanced** surface — its `register`/`registerSandboxed`/`unregister`/`list` methods exist for dynamic (e.g. multi-tenant) worker creation (§6.6); most apps use the `@Processor` decorator instead. `ConnectionResolver` and `QueueLifecycle` are internal and must not be accessed.

---

## 4. Configuration API

### 4.1 `BymaxQueueModuleOptions` interface

This is the main interface that controls all module behavior. The host application provides these options when registering the module.

```typescript
import type { JobsOptions, QueueOptions, Telemetry } from 'bullmq'
import type { Redis, RedisOptions } from 'ioredis'

export interface BymaxQueueModuleOptions {
  /**
   * Register the module globally. When true, the module's providers
   * (QueueService, FlowService, MetricsService) are available app-wide without
   * re-importing. Mapped to DynamicModule.global by ConfigurableModuleBuilder.setExtras.
   * Default: true (QueueService is intended as an app-wide singleton).
   */
  isGlobal?: boolean

  /**
   * Redis connection configuration. REQUIRED.
   *
   * Mutually exclusive between Mode A (bring your own client) and Mode B (lib opens its own).
   */
  connection: QueueConnectionConfig

  /**
   * Default options applied to every job enqueued through QueueService.
   *
   * Per-job overrides are passed in the third argument of enqueue().
   *
   * Default:
   *   attempts: 3,
   *   backoff: { type: 'exponential', delay: 2000 },
   *   removeOnComplete: { age: 24 * 3600, count: 1000 },
   *   removeOnFail: { age: 7 * 24 * 3600, count: 5000 }
   */
  defaultJobOptions?: JobsOptions

  /**
   * Optional prefix for all Redis keys.
   * Useful for multi-tenant isolation (e.g. 'tenant:foo:bullmq').
   * Default: 'bull' (BullMQ default)
   */
  prefix?: string

  /**
   * Default options applied to every Queue created by QueueService.
   * Merged with `defaultJobOptions` and `prefix`.
   */
  queueOptions?: Partial<Omit<QueueOptions, 'connection' | 'defaultJobOptions' | 'prefix'>>

  /**
   * Flow Producer configuration. Opt-in.
   */
  flows?: {
    /** Enables FlowService registration. Default: false */
    enabled?: boolean
  }

  /**
   * Metrics collection configuration. Opt-in.
   */
  metrics?: {
    /** Enables MetricsService registration. Default: false */
    enabled?: boolean

    /** Cache TTL in milliseconds for getJobCounts(). Default: 5000 */
    cacheTtlMs?: number
  }

  /**
   * OpenTelemetry instrumentation. Opt-in.
   *
   * Pass a BullMQ `Telemetry` implementation — typically `new BullMQOtel(...)`
   * from the `bullmq-otel` package. When provided, it is attached to every Queue
   * and Worker the lib creates, so trace context propagates from enqueue() into
   * the job handler (and on to any child jobs in a flow).
   *
   * `bullmq-otel` is an OPTIONAL peer dependency — only install it if you set this.
   */
  telemetry?: Telemetry

  /**
   * Lifecycle behavior on application shutdown.
   */
  shutdown?: {
    /**
     * Max time (ms) to wait for in-flight jobs to finish before forcing close.
     * Default: 30_000 (30s)
     */
    drainTimeoutMs?: number

    /**
     * If true, the lib calls Queue.drain() during shutdown (removes all waiting/delayed jobs).
     * DANGER: only enable in dev/test — production should let jobs survive the restart.
     * Default: false
     */
    drainOnShutdown?: boolean
  }
}

/**
 * Connection configuration — Mode A or Mode B.
 *
 * Mode A: client is provided externally (typically from @bymax-one/nest-cache).
 * Mode B: lib opens its own ioredis using url or options.
 */
export type QueueConnectionConfig =
  | { client: Redis; ownsConnection?: false }  // Mode A
  | { url: string; options?: Partial<RedisOptions> }  // Mode B (url)
  | { options: RedisOptions }  // Mode B (options)
```

### 4.2 `BymaxQueueModuleAsyncOptions` interface

For asynchronous configuration (factory that depends on other modules):

```typescript
import type { ModuleMetadata, Type } from '@nestjs/common'

export interface BymaxQueueOptionsFactory {
  createQueueOptions(): Promise<BymaxQueueModuleOptions> | BymaxQueueModuleOptions
}

export interface BymaxQueueModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Factory function that returns options */
  useFactory?: (...args: unknown[]) => Promise<BymaxQueueModuleOptions> | BymaxQueueModuleOptions

  /** Class implementing BymaxQueueOptionsFactory */
  useClass?: Type<BymaxQueueOptionsFactory>

  /** Existing provider implementing BymaxQueueOptionsFactory */
  useExisting?: Type<BymaxQueueOptionsFactory>

  /** Providers to inject into the factory */
  inject?: Array<Type<unknown> | string | symbol>
}
```

### 4.3 Registration methods

The module is built on NestJS' `ConfigurableModuleBuilder`, which generates a typed `ConfigurableModuleClass` exposing `register`/`registerAsync` (re-exported here as `forRoot`/`forRootAsync` for portfolio consistency). Global scope is opted-in through the `isGlobal` option, mapped to `DynamicModule.global` via `setExtras` — there is **no** hand-written `@Global()` decorator.

```typescript
import { ConfigurableModuleBuilder } from '@nestjs/common'

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: BYMAX_QUEUE_OPTIONS,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE
} = new ConfigurableModuleBuilder<BymaxQueueModuleOptions>({ moduleName: 'BymaxQueue' })
  .setClassMethodName('forRoot')
  .setExtras(
    { isGlobal: true },
    (definition, extras) => ({ ...definition, global: extras.isGlobal })
  )
  .build()

export class BymaxQueueModule extends ConfigurableModuleClass {
  /**
   * Synchronous registration. Use when options are static and known at module load time.
   * Provided by ConfigurableModuleClass; declared here for documentation only.
   */
  static forRoot(options: typeof OPTIONS_TYPE): DynamicModule

  /**
   * Asynchronous registration. Use when options depend on other modules
   * (ConfigService, BymaxCacheModule, etc.).
   */
  static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule
}
```

> **No `forFeature` stub.** Earlier drafts exposed a no-op `forFeature()`. Shipping a documented public method that does nothing is a credibility risk, so it is removed. `QueueService` is an app-wide singleton (`isGlobal: true` by default) and reaches every queue by name; per-queue injection tokens (`@InjectQueue('email')`) are tracked as a future, additive feature and will be introduced as a real `forFeature` only when they do something.

### 4.4 Consolidated defaults

The lib applies the following defaults when fields are not informed:

```typescript
export const DEFAULT_WORKER_CONCURRENCY = 2 as const

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: {
    age: 24 * 3600,        // 24 hours
    count: 1000             // last 1000 completed jobs
  },
  removeOnFail: {
    age: 7 * 24 * 3600,     // 7 days
    count: 5000             // cap retained failed jobs to bound Redis memory under high failure rates
  }
} as const satisfies JobsOptions
```

> **Memory note:** `removeOnFail` keeps failed jobs for debugging, but an unbounded `age`-only policy lets a failure storm grow Redis memory without limit. The `count` cap is the backstop. Tune both per workload (see §16.6 on backpressure and payload size).

> **Decision:** `DEFAULT_WORKER_CONCURRENCY = 2` mirrors a value validated in a production NestJS workload. Workers must **always** pass this value (or a lower justified one) to the decorator/factory, and tune it by workload type (§6.7).

---

## 5. Main Service

### 5.1 `QueueService` — overview

`QueueService` is the central interaction point with queues. It:

- Keeps an internal cache (`Map<string, Queue>`) of created queues — one queue per name.
- Applies `defaultJobOptions` and `prefix` from the configuration to every new queue.
- Exposes typed helpers for enqueue, lookup, and metrics.

```typescript
import { Injectable } from '@nestjs/common'
import { Job, JobsOptions, Queue, QueueOptions } from 'bullmq'
import type { Redis } from 'ioredis'

@Injectable()
export class QueueService {
  private readonly queues = new Map<string, Queue>()

  constructor(
    private readonly redis: Redis,
    private readonly options: ResolvedQueueOptions
  ) {}

  // see methods below
}
```

### 5.2 Strong typing: `Job<TData, TResult>`

All methods exposed by `QueueService` are generic in `TData` (job payload) and optionally `TResult` (handler return).

```typescript
// Domain types (defined by consumer)
interface SendEmailJobData {
  to: string
  templateId: string
  variables: Record<string, string>
}

interface SendEmailJobResult {
  messageId: string
  acceptedAt: string
}

// Enqueue with full type inference
const job = await queueService.enqueue<SendEmailJobData, SendEmailJobResult>(
  'email',                // queueName
  'send-welcome',         // jobName
  { to: 'user@x.com', templateId: 'welcome', variables: {} },  // data — typed!
  { priority: 5 }         // options
)
// job: Job<SendEmailJobData, SendEmailJobResult, 'send-welcome'>
```

### 5.3 `getOrCreateQueue<TData, TResult>()` method

Returns the existing `Queue` or creates a new one with the default configuration.

```typescript
/**
 * Returns the existing Queue for `queueName` or creates a new one.
 *
 * Subsequent calls with the same name return the cached instance, sharing
 * the same Redis connection and default options. Per-queue overrides via
 * the second argument are merged on top of the module defaults.
 *
 * @param queueName - Unique queue name (used as Redis key prefix)
 * @param overrides - Optional QueueOptions overrides (excluding connection/prefix)
 * @returns Typed BullMQ Queue
 */
getOrCreateQueue<TData = unknown, TResult = unknown>(
  queueName: string,
  overrides?: Partial<Omit<QueueOptions, 'connection' | 'prefix'>>
): Queue<TData, TResult>
```

### 5.4 `enqueue<TData, TResult>()` method

Adds a single job to a queue.

```typescript
/**
 * Adds a job to the queue. Creates the queue lazily if it doesn't exist.
 *
 * @param queueName - Target queue
 * @param jobName - Job identifier used by @Process to dispatch
 * @param data - Typed payload (TData)
 * @param options - Per-job overrides: priority, delay, removeOnComplete,
 *                   jobId (idempotent insert), and `deduplication` (see 5.4.1).
 * @returns The created Job
 */
async enqueue<TData = unknown, TResult = unknown>(
  queueName: string,
  jobName: string,
  data: TData,
  options?: JobsOptions
): Promise<Job<TData, TResult, string>>
```

#### 5.4.1 Idempotency and deduplication

Two distinct, complementary mechanisms — both native to BullMQ and surfaced through `options` (no custom code in this lib):

- **`jobId` (idempotent insert).** If you set `options.jobId`, adding a second job with the same id is a no-op while the first still exists. Best for "exactly one job for this entity id" (e.g. `jobId: \`welcome:${userId}\``).
- **`deduplication` (windowed deduplication).** BullMQ's `deduplication` option collapses repeated enqueues of the same logical work within a window. Modes:

  | Mode | Options | Behavior |
  | ---- | ------- | -------- |
  | Simple | `{ id }` | Deduplicate until the in-flight job completes/fails. |
  | Throttle | `{ id, ttl }` | Ignore duplicates for `ttl` ms. |
  | Debounce | `{ id, ttl, extend: true, replace: true }` | Keep only the latest data; each duplicate resets the TTL (use with `delay`). |
  | Keep-last-if-active | `{ id, keepLastIfActive: true }` | While a job is processing, store the latest data and auto-create one follow-up job when it finishes. |

  ```typescript
  // Throttle: at most one index-rebuild per search term every 5s
  await queue.enqueue('search', 'reindex', { term }, {
    deduplication: { id: `reindex:${term}`, ttl: 5_000 }
  })
  ```

  This replaces the previous draft's "global deduplication is the consumer's job" stance — it is now a first-class, documented feature. The deduplication key is independent of `jobId`; inspect/clear it with the native `getDeduplicationJobId` / `removeDeduplicationKey`.

### 5.5 `enqueueBulk<TData, TResult>()` method

Adds multiple jobs in batch — a single Redis roundtrip.

```typescript
interface BulkJob<TData> {
  name: string
  data: TData
  options?: JobsOptions
}

/**
 * Enqueues multiple jobs in a single Redis roundtrip.
 *
 * Useful for fan-out scenarios (e.g. send 100 emails) where the cost
 * of 100 round trips is significant.
 *
 * The batch is bounded by MAX_BULK_SIZE (default 1000) to guard against a
 * self-inflicted DoS / Redis-memory spike; exceeding it throws
 * `queue.bulk_enqueue_failed` before anything is enqueued. Split larger
 * fan-outs into chunks.
 *
 * @param queueName - Target queue
 * @param jobs - Array of job descriptors (length <= MAX_BULK_SIZE)
 * @returns Array of created Jobs in the same order
 */
async enqueueBulk<TData = unknown, TResult = unknown>(
  queueName: string,
  jobs: ReadonlyArray<BulkJob<TData>>
): Promise<Array<Job<TData, TResult, string>>>
```

### 5.6 `upsertJobScheduler<TData>()` method

Creates or updates a Job Scheduler — the current BullMQ API for recurring (cron / interval) jobs. Full details in §8.

```typescript
/**
 * Creates or updates a Job Scheduler (recurring job). Idempotent by `schedulerId`:
 * calling it again with the same id atomically updates the schedule and the job
 * template (BullMQ performs an `override: true` upsert). This supersedes the
 * deprecated `addRepeatable` API, which BullMQ removes in v6.
 *
 * @param queueName - Target queue
 * @param schedulerId - Stable, unique scheduler identifier (the upsert key)
 * @param repeat - Schedule: cron `pattern` OR `every` (ms), plus tz/limit/start/end
 * @param template - Optional job template ({ name, data, opts }) applied to every run.
 *                   `name` defaults to `schedulerId`; `data` defaults to `{}`.
 * @returns The first scheduled (delayed) Job, or undefined
 */
async upsertJobScheduler<TData = unknown, TResult = unknown>(
  queueName: string,
  schedulerId: string,
  repeat: JobSchedulerRepeatOptions,
  template?: { name?: string; data?: TData; opts?: JobsOptions }
): Promise<Job<TData, TResult, string> | undefined>
```

### 5.7 Inspection methods: `getJob()`, `getJobs()`

```typescript
/**
 * Fetches a job by id. Returns null if not found.
 */
async getJob<TData = unknown, TResult = unknown>(
  queueName: string,
  jobId: string
): Promise<Job<TData, TResult, string> | null>

/**
 * Fetches jobs by status with pagination.
 *
 * @param queueName - Target queue
 * @param status - Job status filter (waiting | active | completed | failed | delayed | paused)
 * @param start - Starting index (inclusive). Default: 0
 * @param end - Ending index (inclusive). Default: 50
 */
async getJobs<TData = unknown, TResult = unknown>(
  queueName: string,
  status: JobStatus,
  start?: number,
  end?: number
): Promise<Array<Job<TData, TResult, string>>>
```

### 5.8 `getMetrics()` method

Returns a snapshot of job counters. Detailed implementation in §9.

```typescript
/**
 * Returns job counts grouped by status for a queue.
 *
 * If metrics caching is enabled (options.metrics.enabled), this method uses
 * the MetricsService cache (TTL = metrics.cacheTtlMs).
 */
async getMetrics(queueName: string): Promise<QueueMetrics>
```

Return shape:

```typescript
export interface QueueMetrics {
  queue: string
  counts: {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
    paused: number
  }
  collectedAt: string  // ISO timestamp
}
```

### 5.9 Control methods: `pauseQueue()`, `resumeQueue()`, `cleanQueue()`

```typescript
async pauseQueue(queueName: string): Promise<void>
async resumeQueue(queueName: string): Promise<void>

/**
 * Removes up to `limit` jobs older than `gracePeriodMs` in a given status.
 * Thin wrapper over BullMQ `Queue.clean(grace, limit, type?)` — the argument
 * order mirrors BullMQ exactly: `limit` is required and precedes the status,
 * and `0` means "no limit". Returns the ids of the removed jobs.
 */
async cleanQueue(
  queueName: string,
  gracePeriodMs: number,
  limit: number,
  status?: 'completed' | 'failed' | 'delayed' | 'wait' | 'active' | 'paused'
): Promise<string[]>
```

---

## 6. Workers

### 6.1 Registration pattern

Workers can be registered in two ways, both supported simultaneously:

1. **Via the `@Processor(queueName)` decorator** — recommended. The lib discovers annotated classes in `onModuleInit` via NestJS `DiscoveryService` and creates the workers automatically.
2. **Via the programmatic API (`WorkerRegistry.register()`)** — for dynamic cases (creating workers at runtime based on external config).

### 6.2 `@Processor()` decorator

```typescript
import { Processor, Process, OnQueueEvent } from '@bymax-one/nest-queue'

@Processor('email', { concurrency: 5, limiter: { max: 10, duration: 1000 } })
export class EmailProcessor {
  constructor(private readonly mailer: MailerService) {}

  // Handler for all jobs in this queue (no jobName filter)
  @Process()
  async handleAny(job: Job<SendEmailJobData, SendEmailJobResult>): Promise<SendEmailJobResult> {
    const result = await this.mailer.send(job.data)
    return { messageId: result.id, acceptedAt: new Date().toISOString() }
  }

  // OR: handler filtered by specific jobName
  @Process('send-welcome')
  async handleWelcome(job: Job<SendEmailJobData>): Promise<SendEmailJobResult> {
    // ...
  }

  // Worker-local event listeners — receive the FULL Job (job.data, timings,
  // attemptsMade), processed in this worker's process. Best for logging,
  // progress, and per-job side-effects.
  @OnWorkerEvent('completed')
  onCompleted(job: Job<SendEmailJobData, SendEmailJobResult>): void {
    // job.data, job.returnvalue, job.finishedOn, job.attemptsMade all available
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendEmailJobData> | undefined, error: Error): void {
    // job may be undefined if it failed before the worker fetched it
  }
}
```

### 6.3 Decorator signature

```typescript
/**
 * Marks a class as a queue processor.
 *
 * The class is instantiated by the NestJS DI container, so it can inject
 * any provider available in the host application's module graph.
 *
 * @param queueName - Queue this processor consumes from
 * @param workerOptions - Worker configuration (concurrency, limiter, etc.)
 */
export function Processor(queueName: string, workerOptions?: WorkerOptions): ClassDecorator
```

```typescript
export interface WorkerOptions {
  /**
   * Maximum number of concurrent jobs processed by this worker.
   * Default: DEFAULT_WORKER_CONCURRENCY (2)
   */
  concurrency?: number

  /**
   * Rate limiter — max N jobs per duration ms.
   * Example: { max: 10, duration: 1000 } = 10 jobs/sec max.
   */
  limiter?: {
    max: number
    duration: number
  }

  // NOTE: there is intentionally no `sandboxed` boolean here. BullMQ sandboxed
  // processors are created by passing a FILE PATH (not a class) to the Worker
  // constructor, so they run in a separate process/thread and CANNOT use NestJS
  // dependency injection. A boolean toggle on a DI-managed @Processor class is
  // therefore impossible. Sandboxed CPU-bound work has its own registration
  // path — see §6.8.

  /**
   * Auto-run the worker on registration. Default: true.
   * Set to false to manually call worker.run() later.
   */
  autorun?: boolean

  /**
   * Lock duration for active jobs. Default: 30_000 (30s).
   * Increase if your handler takes longer than 30s.
   */
  lockDuration?: number

  /**
   * Stalled job check interval. Default: 30_000 (30s).
   */
  stalledInterval?: number
}
```

### 6.4 `@Process(jobName?)` decorator

```typescript
/**
 * Marks a method as a job handler within a @Processor class.
 *
 * If jobName is omitted, the handler receives all jobs of the queue.
 * If jobName is provided, only jobs with matching name are dispatched here.
 *
 * Multiple @Process methods are allowed in the same class. Dispatch order:
 *   1. Method with matching jobName (most specific)
 *   2. Method without jobName (fallback)
 *
 * @param jobName - Optional job name filter
 */
export function Process(jobName?: string): MethodDecorator
```

### 6.5 Event decorators — `@OnWorkerEvent()` vs `@OnQueueEvent()`

BullMQ exposes events at two levels, and this lib surfaces both. Choosing the right one matters: the worker-local listener hands you the full `Job`; the global one does not.

```typescript
// Worker-local events — fired by THIS worker's process. Handler receives the
// full Job object (job.data, job.returnvalue, job.attemptsMade, timings).
type WorkerEventName = 'completed' | 'failed' | 'progress' | 'active' | 'stalled' | 'closing' | 'closed' | 'error'

/**
 * Marks a method as a worker-local event listener. No extra Redis connection
 * is required — these fire on the Worker the @Processor already owns.
 * Signatures mirror BullMQ Worker events:
 *   completed(job)              failed(job | undefined, err)
 *   progress(job, progress)     active(job)            stalled(jobId)
 */
export function OnWorkerEvent(eventName: WorkerEventName): MethodDecorator

// Global events — fired across ALL instances via a dedicated QueueEvents
// connection. Handler receives only ids + serialized strings, NOT the Job.
type QueueEventName = 'completed' | 'failed' | 'active' | 'progress' | 'waiting' | 'delayed' | 'stalled' | 'paused' | 'resumed' | 'cleaned' | 'drained'

/**
 * Marks a method as a global queue-event listener. The lib lazily creates ONE
 * QueueEvents instance per queue (on a duplicated, maxRetriesPerRequest:null
 * connection) only when at least one @OnQueueEvent is registered for it.
 * Signatures mirror BullMQ QueueEvents — e.g.:
 *   completed({ jobId, returnvalue })   failed({ jobId, failedReason })
 * Note: `returnvalue`/`failedReason` are STRINGS (serialized), and the key is
 * lowercase `returnvalue`. To get the Job, call queueService.getJob(jobId)
 * (which may be null if removeOnComplete already evicted it).
 */
export function OnQueueEvent(eventName: QueueEventName): MethodDecorator
```

| Use case | Decorator |
| -------- | --------- |
| Log the completed/failed job with its `data`, timings, attempts | `@OnWorkerEvent` (no round-trip, full `Job`) |
| Report/observe job `progress` updates | `@OnWorkerEvent('progress')` |
| React to events from jobs processed on **other** instances | `@OnQueueEvent` |
| Cross-instance dashboards / drained-queue signals | `@OnQueueEvent` |

> **Migration note:** apps coming from `@nestjs/bullmq` that used `@OnWorkerEvent('completed')(job => …)` map 1:1 onto this lib's `@OnWorkerEvent` — they do **not** need to be rewritten as `QueueEvents` listeners, and they keep access to `job.data`.

### 6.5.1 Reporting progress

Long-running handlers report progress with the native `job.updateProgress()` (a number or a JSON object). The matching `@OnWorkerEvent('progress')` listener receives `(job, progress)`:

```typescript
@Process('generate-report')
async handle(job: Job<ReportJobData, ReportResult>): Promise<ReportResult> {
  await job.updateProgress(10)
  const data = await this.fetch(job.data.reportId)
  await job.updateProgress({ stage: 'render', pct: 60 })
  return this.render(data)
}

@OnWorkerEvent('progress')
onProgress(job: Job<ReportJobData>, progress: number | object): void {
  // push to a websocket, etc.
}
```

### 6.6 Programmatic API

To register workers outside the decorator pattern (e.g., create 10 identical workers with different names from a config):

```typescript
@Injectable()
export class DynamicWorkerBootstrap implements OnModuleInit {
  constructor(private readonly workers: WorkerRegistry) {}

  async onModuleInit(): Promise<void> {
    for (const tenant of activeTenants) {
      await this.workers.register({
        queueName: `email:${tenant.id}`,
        handler: async job => this.processEmail(tenant.id, job.data),
        options: { concurrency: tenant.tier === 'premium' ? 10 : 2 }
      })
    }
  }
}
```

```typescript
export interface ProgrammaticWorkerConfig<TData = unknown, TResult = unknown> {
  queueName: string
  handler: (job: Job<TData, TResult>) => Promise<TResult>
  options?: WorkerOptions
}

@Injectable()
export class WorkerRegistry {
  async register<TData, TResult>(
    config: ProgrammaticWorkerConfig<TData, TResult>
  ): Promise<Worker<TData, TResult>>

  /** Registers a file-based, out-of-process (sandboxed) worker — no NestJS DI (§6.8). */
  async registerSandboxed(config: {
    queueName: string
    processorFile: string | URL
    options?: WorkerOptions & { useWorkerThreads?: boolean }
  }): Promise<Worker>

  async unregister(queueName: string): Promise<void>

  list(): readonly string[]
}
```

### 6.7 Decision on `concurrency` and `rate limiting`

The lib makes `concurrency` an explicit, deliberate choice for every worker registered via decorator. The motivation: BullMQ's silent default of `1` is serial and caused throughput surprises in practice. When a `@Processor` is registered without explicit `workerOptions.concurrency`, the lib **logs a warning and falls back to `DEFAULT_WORKER_CONCURRENCY`** (it does not hard-fail) — so a missing value is always surfaced, never silently serial.

> **Documented recommendation — tune by workload type, not a magic number:**
>
> - **I/O-bound handlers** (HTTP calls, DB, email): concurrency lets the worker overlap waits, so higher values improve throughput. Start at `2`, raise while watching the downstream system's limits, and pair with `limiter` when the downstream is rate-limited.
> - **CPU-bound handlers** (image/PDF/crypto/AI): in-process concurrency does **not** add parallelism — all jobs share one event loop and merely interleave. Keep concurrency low and move the work to a **sandboxed processor** (§6.8) or scale horizontally with more worker instances.
>
> `DEFAULT_WORKER_CONCURRENCY = 2` is a safe, non-serial starting point — not an inherently optimal value.

### 6.8 Sandboxed (out-of-process) processors

For CPU-bound work that must not block the event loop, BullMQ runs the processor in a **separate process or worker thread**. This is **not** a flag on a `@Processor` class — a sandboxed processor lives in its own file and receives no NestJS DI:

```typescript
// cpu-heavy.processor.ts — standalone, NO NestJS DI available here
import type { SandboxedJob } from 'bullmq'
export default async function (job: SandboxedJob): Promise<unknown> {
  // pure, dependency-light work (resize image, render PDF, hash, …)
  return heavyCompute(job.data)
}
```

```typescript
// register it programmatically by file path
await workerRegistry.registerSandboxed({
  queueName: 'thumbnails',
  processorFile: new URL('./cpu-heavy.processor.js', import.meta.url),
  options: { concurrency: 4, useWorkerThreads: false } // process by default; threads opt-in
})
```

Constraints (documented so consumers are not surprised):

- The processor file **cannot** inject NestJS providers — pass everything it needs via `job.data` or environment.
- The file must be a built `.js`/`.cjs`/`.mjs` artifact reachable at runtime (account for it in `tsup`/`dist`).
- Communication is over IPC, so payloads must be serializable and are subject to the same size guidance as job data (§16).

---

## 7. Flows

### 7.1 What BullMQ Flows are

Flows allow creating **trees of jobs** with parent-child relationships: a parent job only becomes processable once all its children have completed. Useful for:

- Processing pipelines (extract → transform → load).
- Fan-out + fan-in (generate 100 thumbnails in parallel + assemble the end PDF).
- AI workflows (embedding of N documents + end LLM call).

> **Child failure does NOT fail the parent by default.** In BullMQ, if a child exhausts its retries and fails, the parent simply stays in the `waiting-children` state — it neither completes nor fails. To make a child's failure propagate up and fail its parent, set `failParentOnFailure: true` on that child (see §7.2). Plan for unrecovered child failures explicitly, or the parent can wait indefinitely.

The lib exposes this feature via `FlowService`, registered **only if** `options.flows.enabled === true`.

### 7.2 `FlowService` interface

```typescript
import type { FlowJob, FlowProducer, JobNode } from 'bullmq'

@Injectable()
export class FlowService {
  /**
   * Adds a flow (a tree of jobs with parent-child relations).
   *
   * The root job becomes processable only after every descendant has completed.
   * By BullMQ default a failed (retry-exhausted) child does NOT fail the root —
   * the parent stays in `waiting-children` until the child eventually completes.
   * To make a child's failure fail its parent, set `failParentOnFailure: true`
   * on that child in the flow definition (it propagates upward if ancestors set
   * it too). Use `ignoreDependencyOnFailure: true` to let a parent proceed
   * despite a failed child.
   *
   * @param flow - Flow tree definition
   * @returns The root JobNode (which contains the created Job and children)
   */
  async add<TData = unknown>(flow: FlowJob): Promise<JobNode<TData>>

  /**
   * Bulk add multiple flows in a single roundtrip.
   */
  async addBulk(flows: ReadonlyArray<FlowJob>): Promise<Array<JobNode<unknown>>>

  /**
   * Returns the underlying FlowProducer for advanced use cases.
   * Prefer the helpers above when possible.
   */
  getProducer(): FlowProducer
}
```

### 7.3 Example: PDF pipeline

```typescript
await flowService.add({
  name: 'generate-pdf',
  queueName: 'pdf',
  data: { reportId: '123' },
  children: [
    { name: 'fetch-data', queueName: 'data', data: { reportId: '123' } },
    { name: 'render-charts', queueName: 'render', data: { reportId: '123' } },
    {
      name: 'render-tables',
      queueName: 'render',
      data: { reportId: '123' },
      children: [
        { name: 'fetch-table-1', queueName: 'data', data: { tableId: 't1' } },
        { name: 'fetch-table-2', queueName: 'data', data: { tableId: 't2' } }
      ]
    }
  ]
})
```

### 7.4 `FlowProducer` lifecycle

- Created once in `onModuleInit` (if `flows.enabled`).
- Uses the main connection (mode A or B).
- Closed in `onModuleDestroy` before the queues.

---

## 8. Job Schedulers (repeatable / cron jobs)

> **Why "Job Schedulers" and not "Repeatable Jobs".** BullMQ introduced the **Job Schedulers** API in `5.16.0` and **deprecated** the legacy "repeatable jobs" surface (`addRepeatable`, `getRepeatableJobs`, `removeRepeatable`, `removeRepeatableByKey`), which is **removed in BullMQ v6**. A public library must not expose a method that the upstream engine is deleting, so this package builds exclusively on `upsertJobScheduler` / `removeJobScheduler` / `getJobSchedulers`.

### 8.1 Supported schedules

A scheduler fires on one of two schedule kinds:

| Form           | When to use                              | Example                                |
| -------------- | ---------------------------------------- | -------------------------------------- |
| **Cron**       | Human times (every day at 03:00)         | `pattern: '0 3 * * *'`                 |
| **Every (ms)** | Fixed intervals (every 5 min)            | `every: 5 * 60 * 1000`                 |

BullMQ parses cron with `cron-parser`, which accepts both **5-field** and **6-field** (seconds) patterns — e.g. `'*/30 * * * * *'` runs every 30 seconds. The **first run of a newly created scheduler fires immediately** (for both cron and interval) — this is BullMQ's current default, so no flag is needed. (BullMQ's legacy `immediately` option was deprecated in `5.19.0` and is therefore intentionally not exposed here, per §0 invariant #4.) Interval schedulers accept an `offset` to phase-shift the cadence.

### 8.2 `JobSchedulerRepeatOptions` interface

```typescript
export type JobSchedulerRepeatOptions =
  | {
      /** Crontab expression (5-field, or 6-field with seconds). */
      pattern: string
      /** IANA timezone (e.g. 'America/Sao_Paulo'). Default: UTC */
      tz?: string
      /** Optional cap on the number of runs */
      limit?: number
      /** Start time (epoch ms or ISO). */
      startDate?: number | string
      /** Stop time (epoch ms or ISO). Must be in the future or BullMQ throws. */
      endDate?: number | string
    }
  | {
      /** Interval in milliseconds between runs */
      every: number
      /** Optional cap on the number of runs */
      limit?: number
      /** Phase offset (ms) for interval schedulers */
      offset?: number
      startDate?: number | string
      endDate?: number | string
    }
```

> This is a thin, validated projection of BullMQ's `RepeatOptions` (minus the internal `key`). The lib does **not** invent its own scheduling semantics.

### 8.3 `upsertJobScheduler<TData>()` usage

```typescript
// Cron — every day at 03:00 São Paulo time
await queueService.upsertJobScheduler<CleanupJobData>(
  'maintenance',                 // queueName
  'nightly-cleanup',             // schedulerId (the stable upsert key)
  { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
  { name: 'cleanup', data: { mode: 'soft' } }
)

// Interval — every 5 minutes
await queueService.upsertJobScheduler<HeartbeatJobData>(
  'monitoring',
  'api-heartbeat',
  { every: 5 * 60 * 1000 },
  { name: 'heartbeat', data: { service: 'api' } }
)
```

### 8.4 Idempotency, update, listing, and removal

`upsertJobScheduler` is idempotent **by `schedulerId`** — BullMQ performs an atomic `override: true` upsert. Calling it again with the same id updates the schedule and the job template in place (no duplicate scheduler), which is exactly the behavior you want when the host application re-registers schedulers on every boot.

```typescript
/** Removes a scheduler by id. Returns true if one was removed. */
async removeJobScheduler(queueName: string, schedulerId: string): Promise<boolean>

/** Lists schedulers for a queue (paginated), for inspection/health. */
async getJobSchedulers(
  queueName: string,
  start?: number,
  end?: number,
  asc?: boolean
): Promise<JobSchedulerJson[]>
```

### 8.5 Validation

The lib validates `repeat` before delegating to BullMQ and throws `queue.invalid_repeat_options` (400) when:

- both `pattern` and `every` are present, or neither is;
- `every` is not a positive integer;
- `pattern` fails to parse — the lib **delegates cron parsing to BullMQ** (which uses `cron-parser` internally) and rethrows any parse failure as `queue.invalid_repeat_options`. It never ships a hand-rolled cron regex (incorrect for 6-field patterns and a ReDoS risk) and adds **no direct dependency** to do this;
- `endDate` is in the past (BullMQ itself rejects this).

### 8.6 Best practice

Register schedulers in an `OnApplicationBootstrap` hook of the host application, **not** inside a job handler. Because `upsertJobScheduler` is idempotent by id, running this on every boot is safe and keeps the scheduler definition in code (auditable, reviewable) rather than as hidden Redis state.

---

## 9. Metrics and Health Check

### 9.1 Philosophy

The lib exposes **basic counters** sufficient for health checks and simple dashboards. It does not provide history, alerting, or SLA tracking — that is the consumer's responsibility (see §13).

### 9.2 `QueueMetrics` interface

```typescript
export interface QueueMetrics {
  /** Queue name */
  queue: string

  /** Job counts grouped by status (instantaneous snapshot) */
  counts: {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
    paused: number
  }

  /** ISO timestamp of the moment counts were sampled */
  collectedAt: string
}
```

### 9.3 `QueueService.getMetrics()`

Default implementation — calls `Queue.getJobCounts()` directly on Redis:

```typescript
async getMetrics(queueName: string): Promise<QueueMetrics> {
  const queue = this.getOrCreateQueue(queueName)
  const counts = await queue.getJobCounts(
    'waiting', 'active', 'completed', 'failed', 'delayed', 'paused'
  )
  return {
    queue: queueName,
    counts,
    collectedAt: new Date().toISOString()
  }
}
```

### 9.4 `MetricsService` (opt-in)

When `options.metrics.enabled === true`, the lib registers a `MetricsService` that applies in-memory caching (configurable TTL, default 5s). Useful when the `/health` endpoint is called every second by a load balancer and we want to avoid 6 roundtrips/s to Redis.

```typescript
@Injectable()
export class MetricsService {
  /**
   * Returns cached metrics for `queueName`. Cache TTL = options.metrics.cacheTtlMs.
   */
  async get(queueName: string): Promise<QueueMetrics>

  /**
   * Returns metrics for all known queues (those created via QueueService).
   */
  async getAll(): Promise<readonly QueueMetrics[]>

  /**
   * Forces cache invalidation. Useful in tests.
   */
  invalidate(queueName?: string): void
}
```

### 9.5 Health check pattern

The lib **does not** implement a `HealthIndicator` from `@nestjs/terminus` — that would introduce an unnecessary peer dep. Instead, we document the pattern:

```typescript
// In the host application
@Injectable()
export class QueueHealthIndicator extends HealthIndicator {
  constructor(private readonly metrics: MetricsService) { super() }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const all = await this.metrics.getAll()
    const totalActive = all.reduce((sum, m) => sum + m.counts.active, 0)
    const isHealthy = totalActive < SOME_THRESHOLD
    return this.getStatus(key, isHealthy, { active: totalActive })
  }
}
```

---

## 10. Delivery Semantics and Shutdown Strategy

### 10.0 Delivery semantics — at-least-once, never exactly-once

This is the single most important contract for any queue and is stated up front: **BullMQ (and therefore this lib) guarantees at-least-once delivery, not exactly-once.** A job whose worker crashes, is killed, or exceeds its lock is recovered as `stalled` and re-run by another worker. Consequences for consumers:

- **Handlers must be idempotent.** Re-running a handler with the same `job.id`/`job.data` must be safe (use an idempotency key on writes, upserts instead of inserts, or an "already-processed" marker keyed by `job.id`).
- Use `jobId` and/or `deduplication` (§5.4.1) to collapse duplicate **producers**, but understand that this does not change the at-least-once guarantee on the **consumer** side.
- Tune `lockDuration` (§6.3) to comfortably exceed your handler's worst-case runtime so healthy long jobs are never falsely treated as stalled.

The lib documents this prominently rather than implying a stronger guarantee it cannot deliver.

### 10.1 Why graceful shutdown matters

BullMQ workers continuously block on Redis (`BRPOPLPUSH` / `BZPOPMIN` / `BLMOVE`) waiting for work. If the process receives `SIGTERM` (deploy, scale-down) and simply terminates, two problems occur:

1. **In-flight job** loses its lock, is marked `stalled` after `lockDuration`, and is re-executed elsewhere — an avoidable at-least-once duplication.
2. **Open workers and queues** keep Redis connections open, delaying `exit(0)` (Kubernetes may escalate to `SIGKILL`).

The lib resolves this via `QueueLifecycle.onModuleDestroy()`, which executes the protocol below.

### 10.2 Shutdown protocol

`worker.close()` (non-force) **already** waits for the currently active jobs to finish and then resolves; it takes **no timeout argument**. To bound that wait we race it against a timer and escalate to `worker.close(true)` (force) on expiry. The protocol:

```
1. Receive SIGTERM (Nest triggers onModuleDestroy)
2. For each registered Worker, concurrently:
   a. Promise.race([ worker.close(), timeout(options.shutdown.drainTimeoutMs) ])
      - worker.close() stops fetching new jobs and waits for active ones to finish
   b. If the timeout wins, call worker.close(true) to force-close
      - in-flight jobs lose their lock and become `stalled` (will be retried);
        emit `queue.shutdown_timeout_exceeded` so the operator knows
3. For each registered QueueEvents: queueEvents.close()
4. If options.shutdown.drainOnShutdown === true (DEV/TEST ONLY):
   a. For each Queue: queue.drain() — removes waiting + delayed jobs
5. For each Queue: queue.close()
6. Connection teardown:
   - Mode B (lib owns the connection): redis.quit() on the main client and on
     every duplicated worker/QueueEvents connection
   - Mode A (injected client): close only the DUPLICATED worker/QueueEvents
     connections the lib created; never touch the consumer's shared client
7. Log shutdown metrics (total time, forced workers, drained jobs)
```

### 10.3 Guarantees

- **Minimized duplication for in-flight jobs**: if the worker finishes within `drainTimeoutMs`, the job is `completed` before `close()` resolves and is never re-run. On timeout, the job becomes `stalled` and is retried (at-least-once — by design, and surfaced via `queue.shutdown_timeout_exceeded`).
- **No-loss for waiting jobs**: unless `drainOnShutdown: true`, queues keep `waiting`/`delayed` jobs intact for the next deploy.
- **Clean Redis connection close**: the lib closes exactly the connections it owns, preventing `Connection closed` error logs and leaked sockets — and never closes a connection the consumer still uses (Mode A).

### 10.4 Configuration

```typescript
BymaxQueueModule.forRoot({
  // ...
  shutdown: {
    drainTimeoutMs: 30_000,    // default
    drainOnShutdown: false     // default — production-safe
  }
})
```

### 10.5 Recommendation for Kubernetes

Configure `terminationGracePeriodSeconds: 60` on the deployment to allow margin for `drainTimeoutMs: 30000`.

---

## 11. Integration with `@bymax-one/nest-cache`

### 11.1 Recommended pattern

The canonical integration between `@bymax-one/nest-cache` and `@bymax-one/nest-queue` uses **mode A** (bring your own connection). The reason: `nest-cache` already exposes a Redis client dedicated to BullMQ, and `nest-queue` applies the per-role retry policy automatically (it uses that client for the Queue role and duplicates it with `maxRetriesPerRequest: null` for the blocking worker/QueueEvents connections — see §2.3), so you do not configure connection retries yourself. For the cleanest fail-fast behavior, configure `nest-cache`'s queue client with **default** retries; the lib still forces `null` where BullMQ requires it.

### 11.2 Complete setup

```typescript
import { Module } from '@nestjs/common'
import { BymaxCacheModule, BYMAX_CACHE_QUEUE_REDIS } from '@bymax-one/nest-cache'
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import type { Redis } from 'ioredis'

@Module({
  imports: [
    // Cache module exposes a Redis client tagged for BullMQ usage
    BymaxCacheModule.forRoot({
      url: process.env.REDIS_URL,
      queueClient: { enabled: true }
    }),

    // Queue module consumes the cache module's Redis client (Mode A)
    BymaxQueueModule.forRootAsync({
      imports: [BymaxCacheModule],
      inject: [BYMAX_CACHE_QUEUE_REDIS],
      useFactory: (queueRedis: Redis) => ({
        connection: { client: queueRedis },
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 }
        },
        flows: { enabled: true },
        metrics: { enabled: true, cacheTtlMs: 3000 }
      })
    })
  ]
})
export class AppModule {}
```

### 11.3 When NOT to share

- **Worker in a separate container**: if you run the workers in a dedicated pod (without nest-cache), use mode B with the Redis URL directly.
- **Multi-tenant with distinct Redis instances**: each tenant has its own Redis — you cannot share a generic connection.

### 11.4 Correct configuration guarantee

The injected client is used **as-is for the Queue role** — the lib never mutates the consumer's client, so the Queue connection inherits whatever `maxRetriesPerRequest` the consumer configured (use the default for fail-fast on a Redis outage; if the shared client is already `null`, the Queue inherits `null` and simply loses that fast-fail, while remaining fully functional). For **workers and QueueEvents**, the lib always creates `client.duplicate({ maxRetriesPerRequest: null })`, so the blocking-connection requirement is satisfied without mutating the shared client and without breaking the consumer's cache operations.

The lib **does not** "warn and continue" on a non-null shared client — that would be unsafe, because the duplicated worker connection inherits the parent's options and BullMQ throws at `Worker` construction if it is not null. Instead, `onModuleInit` verifies the duplicated worker connection resolves to `maxRetriesPerRequest === null`; if a custom client wrapper prevents the override from taking effect, the lib **fails fast** with a clear error rather than crashing later:

```
[BymaxQueueModule] FATAL: worker connection could not be set to maxRetriesPerRequest=null
(resolved 20). BullMQ requires null for blocking worker commands. Provide a client whose
.duplicate({ maxRetriesPerRequest: null }) is honored, or use Mode B.
→ throws QueueException(queue.connection_requires_null_retries)
```

---

## 12. Error Code Catalog

### 12.1 `QueueException` class

```typescript
import { HttpException, HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_MESSAGES, QUEUE_ERROR_STATUS } from './queue-error-codes'

/**
 * Standardized exception for queue operations.
 * All exceptions follow the same response format. The HTTP status is derived
 * from the code via QUEUE_ERROR_STATUS (the §12.2 mapping); the optional
 * `statusCode` argument overrides it only when explicitly passed.
 */
export class QueueException extends HttpException {
  constructor(
    code: string,
    statusCode: HttpStatus = QUEUE_ERROR_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
    details?: Record<string, unknown>
  ) {
    super(
      {
        error: {
          code,
          message: QUEUE_ERROR_MESSAGES[code] ?? 'Queue error',
          details: details ?? null
        }
      },
      statusCode
    )
  }
}
```

### 12.2 Complete catalog

| Code                                    | HTTP | Message                                               | Context                                                                                        |
| --------------------------------------- | ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `queue.connection_invalid`              | 500  | Invalid Redis connection configuration                | Mode B with malformed URL, or mode A with client in `end`/`close` status                       |
| `queue.connection_requires_null_retries` | 500  | Worker connection must have maxRetriesPerRequest=null | Mode A: the duplicated worker/QueueEvents connection could not be coerced to `null` (e.g. a client wrapper that ignores the `duplicate()` override) — fail-fast at init |
| `queue.connection_timeout`              | 500  | Redis connection timeout                              | Mode B: did not reach `ready` within the timeout (default 10s)                                 |
| `queue.queue_not_found`                 | 404  | Queue not found                                       | Attempt to get metrics/jobs from an unregistered queue                                         |
| `queue.job_not_found`                   | 404  | Job not found                                         | `getJob()` with a non-existent id                                                              |
| `queue.invalid_job_data`                | 400  | Invalid job data                                      | `enqueue()` with `data` that fails schema validation (if the consumer enables it)              |
| `queue.invalid_repeat_options`          | 400  | Invalid repeat options                                | `upsertJobScheduler()` with both/neither of `pattern`/`every`, `every <= 0`, an unparseable cron, or a past `endDate` |
| `queue.duplicate_processor`             | 500  | Multiple @Processor decorators target the same queue  | Two classes annotated with `@Processor('foo')` — only one per queue is allowed                 |
| `queue.shutdown_timeout_exceeded`       | 500  | Shutdown timeout exceeded                             | Workers did not finish within `drainTimeoutMs` — log warning, force close                      |
| `queue.bulk_enqueue_failed`             | 500  | Bulk enqueue failed                                   | `enqueueBulk()` failed — thrown with the per-job errors in `details.errors`                     |
| `queue.worker_registration_failed`      | 500  | Failed to register worker                             | Error instantiating BullMQ Worker (connection problem, invalid option)                         |
| `queue.invalid_options`                 | 500  | Invalid module options                                | `forRoot()` with `connection` absent or ambiguous (client + URL at the same time)              |

### 12.3 Code constants

```typescript
export const QUEUE_ERROR_CODES = {
  CONNECTION_INVALID: 'queue.connection_invalid',
  CONNECTION_REQUIRES_NULL_RETRIES: 'queue.connection_requires_null_retries',
  CONNECTION_TIMEOUT: 'queue.connection_timeout',
  QUEUE_NOT_FOUND: 'queue.queue_not_found',
  JOB_NOT_FOUND: 'queue.job_not_found',
  INVALID_JOB_DATA: 'queue.invalid_job_data',
  INVALID_REPEAT_OPTIONS: 'queue.invalid_repeat_options',
  DUPLICATE_PROCESSOR: 'queue.duplicate_processor',
  SHUTDOWN_TIMEOUT_EXCEEDED: 'queue.shutdown_timeout_exceeded',
  BULK_ENQUEUE_FAILED: 'queue.bulk_enqueue_failed',
  WORKER_REGISTRATION_FAILED: 'queue.worker_registration_failed',
  INVALID_OPTIONS: 'queue.invalid_options'
} as const
```

### 12.4 Error response format

```json
{
  "error": {
    "code": "queue.connection_requires_null_retries",
    "message": "Worker connection must have maxRetriesPerRequest=null",
    "details": {
      "actualValue": 20,
      "expectedValue": null
    }
  }
}
```

### 12.5 Security in errors

- **Framework-neutral code, HTTP-friendly shape.** `QueueException extends HttpException` for ergonomics in HTTP request contexts, but it always carries a stable, transport-independent `code`. Queue work frequently runs **outside** an HTTP request (workers, `OnApplicationBootstrap`); consumers catching a `QueueException` there should branch on `code`, not on the HTTP status. (A framework-neutral base error with an HTTP mapping layer is tracked as a possible future refinement.)
- **No secrets in `details`.** `details` must never contain a raw connection string, password, or `job.data`. Connection identifiers are masked (`redis://default:***@host:6379`) before they reach a message, log, or `details` payload (see §18/Appendix B). `actualValue`/`expectedValue` above are scalar config values, never credentials.
- **No payload leakage.** Validation errors reference field names, never echo `job.data` values, so PII in payloads is not surfaced through exceptions.

---

## 13. What is NOT in the package

The lib was designed with clear boundaries. The items below are the **responsibility of the consuming application**:

| Item                                            | Reason                                                                                          | Where to implement                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **BullBoard UI** (visual dashboard)             | UI is a separate product (`bull-board` is a heavy peer dep). The lib exposes `Queue` objects for the consumer to plug BullBoard at will. | Host application mounts `@bull-board/express` or `@bull-board/nestjs` |
| **Alerting** (PagerDuty, Slack, etc.)           | Threshold decisions are product- and SLA-specific                                               | `@OnQueueEvent('failed')` in the consumer + tool integration |
| **SLA tracking** (job age, percentile latency)  | Requires historical storage (Prometheus, ClickHouse) — out of scope                             | Consumer publishes metrics via `prom-client` or similar |
| **Job audit log**                               | Retention of completed jobs is managed by BullMQ; long-term auditing requires another storage   | `@OnQueueEvent('completed')` hook + consumer table |
| **Rate limiting per tenant** (cross-queue)      | Worker `limiter` is per queue; per-tenant limits require external coordination                  | Consumer implements via Redis tokens                   |
| **Migration from old queues (BullMQ v3 → v5)**  | Can be destructive — we do not automate it                                                      | Consumer follows the official BullMQ migration guide   |
| **In-transit payload encryption**               | Redis TLS is ioredis client configuration                                                       | Pass `tls: {}` in `connection.options`                 |
| **Job persistence beyond removeOn***            | Long retention requires external archiving                                                      | `@OnWorkerEvent('completed')` hook → S3/database       |

---

## 14. Dependencies

### 14.1 Peer Dependencies (server subpath)

These dependencies must be installed in the host application that uses the server subpath. The package does not include them — it expects them to already exist.

| Package              | Version      | Reason                                                                  |
| -------------------- | ------------ | ----------------------------------------------------------------------- |
| `@nestjs/common`     | `^11.0.0`    | Core framework — decorators, exceptions, providers, `ConfigurableModuleBuilder` |
| `@nestjs/core`       | `^11.0.0`    | Core framework — module system, DI container, `DiscoveryService`        |
| `bullmq`             | `^5.16.0`    | Queue engine. `5.16.0` is the floor because it introduced the Job Schedulers API (§8). See §14.5 |
| `ioredis`            | `^5.0.0`     | Redis client (always present, even in mode A where the consumer passes) |
| `reflect-metadata`   | `^0.2.0`     | Metadata reflection for the decorators                                  |

### 14.2 Direct dependencies

The package has **no** direct dependencies (`"dependencies": {}`). All functionality is delivered via peer deps + own code + Node.js builtins. This keeps the install footprint minimal and avoids version conflicts in the host application.

### 14.3 Optional Peer Dependencies

| Package       | Version    | Needed when                                                       |
| ------------- | ---------- | ----------------------------------------------------------------- |
| `bullmq-otel` | `^1.0.0`   | Only if you set `options.telemetry` for OpenTelemetry tracing (§4, §16.5) |

`bullmq-otel` is declared in `peerDependenciesMeta` as `optional: true`, so installs do not warn when telemetry is unused. The `./shared` subpath has **zero** peer deps (only TS types).

### 14.4 Peer Dependencies per Subpath

| Subpath      | Peer Dependencies                                                          |
| ------------ | -------------------------------------------------------------------------- |
| `.` (server) | `@nestjs/common ^11`, `@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata ^0.2`; optional `bullmq-otel ^1` |
| `./shared`   | None                                                                       |

### 14.5 Decision on BullMQ version (v5 → v6)

At the time of writing, the current BullMQ release is **`5.79.1`**. The lib's floor is **`^5.16.0`** because that is where the Job Schedulers API (the only recurring-jobs API this lib exposes, §8) landed.

| BullMQ | Status                                                                                                                              | Decision |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **v5 (≥ 5.16)** | Current stable. Every API the lib uses (`Queue`, `Worker`, `FlowProducer`, `JobsOptions`, `getJobCounts`, `upsertJobScheduler`, `deduplication`, `Telemetry`) is GA. | ✅ Official support. |
| **v6** | Removes the legacy repeatable-jobs API. **Because this lib already uses Job Schedulers (not `addRepeatable`), it is forward-compatible by design.** Promote to `^5.16.0 || ^6.0.0` once the e2e suite passes on v6. | 🟢 Pre-positioned — no public-API breakage expected. |

> **Why this matters:** the earlier draft built on `addRepeatable`/`removeRepeatable`, which v6 deletes — that would have forced a breaking change on the first v6 bump. Standardizing on Job Schedulers removes that landmine.

The peer dep in the initial `package.json` is:

```json
"peerDependencies": {
  "bullmq": "^5.16.0"
}
```

This decision is reviewed in every minor release of the lib.

### 14.6 `package.json` example

```json
{
  "name": "@bymax-one/nest-queue",
  "version": "0.1.0",
  "description": "NestJS dynamic module wrapping BullMQ — typed jobs, flows, job schedulers, deduplication, OpenTelemetry, graceful shutdown",
  "author": "Bymax One <support@bymax.one>",
  "license": "MIT",
  "homepage": "https://github.com/bymaxone/nest-queue#readme",
  "repository": { "type": "git", "url": "https://github.com/bymaxone/nest-queue.git" },
  "bugs": { "url": "https://github.com/bymaxone/nest-queue/issues" },
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
    "lint:fix": "eslint src --fix",
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
  "devDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@stryker-mutator/core": "^9.0.0",
    "@stryker-mutator/jest-runner": "^9.0.0",
    "@testcontainers/redis": "^11.0.0",
    "@types/jest": "^30.0.0",
    "bullmq": "^5.79.1",
    "bullmq-otel": "^1.3.1",
    "ioredis": "^5.11.1",
    "jest": "^30.0.0",
    "ts-jest": "^29.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.6.0"
  },
  "keywords": [
    "nestjs", "bullmq", "queue", "redis", "worker", "flow",
    "cron", "job-scheduler", "scheduler", "deduplication",
    "opentelemetry", "otel", "graceful-shutdown", "job"
  ],
  "packageManager": "pnpm@11.0.0",
  "engines": { "node": ">=24.0.0" },
  "publishConfig": {
    "access": "public",
    "provenance": true,
    "registry": "https://registry.npmjs.org/"
  }
}
```

> `packageManager` must match the repo's pinned pnpm (the portfolio is on pnpm 11); `devDependencies` versions are illustrative — pin exact resolved versions in the real `package.json`.

---

## 15. Implementation Phases

> **Testing strategy:** unit tests are written **alongside each phase** (TDD), not accumulated in Phase 4. Each phase must reach **100% line/branch coverage on the files it implements** (enforced by `jest.coverage.config.ts` thresholds `100/100/100/100`). Stryker mutation testing (`break 95`, target 100%) runs as a pre-release gate, not per commit. See §18.

### 15.1 Phase overview

| Phase | Complexity | Focus                                      | Deliverables                                                                                          |
| ----- | ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1     | MEDIUM     | Module + QueueService                      | Scaffold, dynamic module (`ConfigurableModuleBuilder`), ConnectionResolver, basic QueueService (enqueue/getJob/getMetrics) + tests |
| 2     | MEDIUM     | Workers (decorator + programmatic)         | `@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`, WorkerRegistry (+ `registerSandboxed`) + tests |
| 3     | MEDIUM     | Flows + Job Schedulers + Deduplication/Telemetry   | FlowService, `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`, deduplication options, telemetry passthrough, MetricsService + tests |
| 4     | HIGH       | forRootAsync + shutdown + E2E + release    | forRootAsync, graceful-shutdown protocol, E2E tests with real Redis (testcontainers), mutation baseline, docs/README, release prep |

> **Phase mapping to the execution plan.** This section describes **4 logical phases**; the execution plan (`docs/development_plan.md`) and the per-phase task files (`docs/tasks/`) keep the same scope but split this Phase 4 into **plan Phase 4** (forRootAsync + graceful shutdown + E2E + mutation baseline) and **plan Phase 5** (release/publish). 4 spec phases ≡ 5 plan phases — not a contradiction.

> **Execution by AI agents** — there is no estimate in human days. Relative complexity per phase is indicated above; fine-grained granularity per sub-step lives in `docs/development_plan.md` (Appendix B — Complexity Matrix).

### 15.2 Phase 1 — Module and QueueService

**Goal:** Create the base structure of the package, the dynamic module, and the main `QueueService` with support for the two connection modes.

**Deliverables:**

1. **Project scaffold**
   - `package.json` with peer deps (NestJS 11, bullmq `^5.16`, ioredis 5; optional `bullmq-otel`)
   - `tsconfig.json`, `tsconfig.build.json`, `tsconfig.server.json`, `tsconfig.e2e.json`, `tsconfig.jest.json`
   - `tsup.config.ts` with 2 entries (`server`, `shared`)
   - Directory structure in `src/`
   - `eslint.config.mjs`, `jest.config.ts`, `jest.coverage.config.ts` (100/100/100/100), `commitlint.config.cjs`, `.prettierrc`
   - `scripts/check-size.mjs` (budget ≤ 18 KiB brotli)

2. **Base interfaces**
   - `queue-module-options.interface.ts` — `BymaxQueueModuleOptions`, `BymaxQueueModuleAsyncOptions`
   - `queue-connection.interface.ts` — `QueueConnectionConfig` (union of mode A and B)
   - `worker-options.interface.ts` — `WorkerOptions`
   - `queue-job-data.interface.ts` — utility types

3. **Constants and configuration**
   - `bymax-queue.constants.ts` — `BYMAX_QUEUE_OPTIONS`, `BYMAX_QUEUE_REDIS_CLIENT`, `BYMAX_QUEUE_CONNECTION_MODE` (Symbol)
   - `config/default-options.ts` — `DEFAULT_JOB_OPTIONS`, `DEFAULT_WORKER_CONCURRENCY`
   - `config/resolved-options.ts` — merge defaults with user options

4. **`ConnectionResolver`**
   - Detects mode A (presence of `connection.client`) or mode B (presence of `connection.url` or `connection.options`)
   - Per-role policy: Queue/FlowProducer connection keeps default retries; worker/QueueEvents connections obtained via `duplicate({ maxRetriesPerRequest: null })`
   - Mode A: validates `client.status`; fails fast (`queue.connection_requires_null_retries`) if a worker connection cannot be coerced to `null`
   - Mode B: opens `ioredis` with timeout
   - Exposes `getQueueClient()`, `duplicateForBlocking()`, and `isOwned()` (to know what it must close)

5. **`QueueService` — core methods**
   - `getOrCreateQueue<TData, TResult>()`
   - `enqueue<TData, TResult>()`
   - `enqueueBulk<TData, TResult>()`
   - `getJob<TData, TResult>()`
   - `getJobs<TData, TResult>()`
   - `getMetrics()` (version without cache)
   - `pauseQueue()`, `resumeQueue()`, `cleanQueue()`

6. **Dynamic module**
   - `bymax-queue.module.ts` — built on `ConfigurableModuleBuilder`; `isGlobal` mapped to `DynamicModule.global` via `setExtras` (no manual `@Global()`, no `forFeature` stub). The synchronous `forRoot()` lands in this phase; the asynchronous `forRootAsync()` is implemented in plan Phase 4 (it depends on the flows/metrics providers resolved first — see `development_plan.md` §5.1 and the Appendix A dependency graph)
   - Conditional registration of FlowService and MetricsService (stubs for now, activated in Phase 3)

7. **Errors**
   - `errors/queue-error-codes.ts` — all constants from §12.3
   - `errors/queue-exception.ts` — `QueueException` class

8. **Unit tests (Phase 1)**
   - `ConnectionResolver`: valid mode A, invalid mode A (maxRetries != null), mode B with URL, mode B with options, timeout
   - `QueueService`: each method with mocked `Queue` (ioredis-mock for Redis)
   - `BymaxQueueModule`: `forRoot` and `forRootAsync` (validate registered providers)
   - Coverage: 100% line/branch on implemented files

### 15.3 Phase 2 — Workers

**Goal:** Implement worker registration via decorator and programmatic API.

**Deliverables:**

1. **Decorators**
   - `decorators/processor.decorator.ts` — `@Processor(queueName, workerOptions?)`
   - `decorators/process.decorator.ts` — `@Process(jobName?)`
   - `decorators/on-worker-event.decorator.ts` — `@OnWorkerEvent(eventName)` (worker-local, full `Job`)
   - `decorators/on-queue-event.decorator.ts` — `@OnQueueEvent(eventName)` (global `QueueEvents`)
   - Metadata stored via `SetMetadata` (exclusive Symbol keys)

2. **`WorkerRegistry`**
   - `register<TData, TResult>(config)` — creates BullMQ `Worker`, performs `duplicate()` on the connection
   - `unregister(queueName)` — closes the worker
   - `list()` — returns registered names

3. **Discovery service integration**
   - In `onModuleInit`, uses NestJS `DiscoveryService` to find classes annotated with `@Processor`
   - For each class: instantiates via DI container, extracts metadata from each `@Process` method, registers the worker
   - Wires `@OnWorkerEvent` listeners directly to the `Worker` (full `Job`, no extra connection)
   - Wires `@OnQueueEvent` listeners to the corresponding (lazy) `QueueEvents`

3b. **Sandboxed worker registration**
   - `WorkerRegistry.registerSandboxed({ queueName, processorFile, options })` for file-based, out-of-process processors (no DI) — see §6.8

4. **Lazy `QueueEvents`**
   - Creates `QueueEvents` only when there is at least one `@OnQueueEvent` for that queue
   - Uses `connection.duplicate()` (one connection per listener)

5. **Worker options validation**
   - Warning if `concurrency` is missing → uses `DEFAULT_WORKER_CONCURRENCY`
   - Error if `concurrency < 1`
   - Error if `limiter.max < 1` or `limiter.duration < 1`

6. **Unit tests (Phase 2)**
   - Decorators: verify metadata via `Reflect.getMetadata`
   - `WorkerRegistry`: register, list, unregister, registerSandboxed
   - Discovery: class with `@Processor` + `@Process` is discovered and wired up
   - `@OnWorkerEvent` handler receives the full `Job`; `@OnQueueEvent` receives fired global events
   - Coverage: 100% line/branch on implemented files

### 15.4 Phase 3 — Flows, Job Schedulers, Deduplication, Telemetry, Metrics

**Goal:** Implement opt-in features (Flows, Metrics, Telemetry) plus Job Schedulers and deduplication.

**Deliverables:**

1. **`FlowService`**
   - Constructor creates `FlowProducer` with the main connection
   - Methods `add()`, `addBulk()`, `getProducer()`
   - Registered **only if** `options.flows.enabled === true`

2. **Job Schedulers in `QueueService`**
   - `upsertJobScheduler<TData>()` — wrapper over `Queue.upsertJobScheduler()` (idempotent by `schedulerId`)
   - `removeJobScheduler()` — wrapper over `Queue.removeJobScheduler()`
   - `getJobSchedulers()` — wrapper over `Queue.getJobSchedulers()`
   - Validation: exactly one of `pattern`/`every`; `every > 0`; `endDate` in the future; cron `pattern` parse delegated to BullMQ (cron-parser), parse failure rethrown as `queue.invalid_repeat_options` — never a hand-rolled regex, no direct dependency

3. **Deduplication + telemetry**
   - Surface BullMQ `deduplication` options on `enqueue` (Simple/Throttle/Debounce/Keep-last-if-active)
   - Attach `options.telemetry` to every `Queue`/`Worker` when provided

4. **`MetricsService`**
   - In-memory cache (`Map<string, { metrics: QueueMetrics; expiresAt: number }>`)
   - `get(queueName)`, `getAll()`, `invalidate()`
   - Registered **only if** `options.metrics.enabled === true`

5. **Integration in `QueueService.getMetrics()`**
   - If `MetricsService` is available (registered), delegates
   - Otherwise, fetches directly via `Queue.getJobCounts()`

6. **Unit tests (Phase 3)**
   - `FlowService`: add with 3-level tree, addBulk
   - `upsertJobScheduler`: valid cron pattern (5- and 6-field), invalid cron (rejects), valid `every`, idempotent re-upsert, `removeJobScheduler`, past `endDate` rejected
   - Deduplication: each mode collapses duplicates as documented
   - `MetricsService`: cache hit/miss, invalidate, TTL expiry
   - Coverage: 100% line/branch on implemented files

### 15.5 Phase 4 — Shutdown, E2E, Polish

**Goal:** Validate the package end-to-end, ensure graceful shutdown, and prepare for release.

**Deliverables:**

1. **`QueueLifecycle`**
   - `onModuleDestroy()` implements the protocol from §10.2
   - Structured logs (count of drained jobs, total time)
   - Respects `drainTimeoutMs` and `drainOnShutdown`

2. **E2E tests (with testcontainers)**
   - Spin up real Redis via `@testcontainers/redis`
   - Scenario 1: enqueue + process + verify result
   - Scenario 2: graceful shutdown (worker finishes in-flight job)
   - Scenario 3: flow with 3 levels, all complete
   - Scenario 4: Job Scheduler (`upsertJobScheduler`) fires twice in 10s; re-upsert does not duplicate
   - Scenario 5: failure → exponential retry → eventual success
   - Scenario 6: deduplication collapses N rapid enqueues to one processed job
   - Scenario 7: Mode-A worker connection is coerced to `maxRetriesPerRequest:null` and the Queue connection keeps defaults

3. **Documentation**
   - JSDoc on all public exports
   - `README.md` with badges, quick start, examples, subpath table
   - `CHANGELOG.md` with `0.1.0` entry
   - `SECURITY.md`, `CLAUDE.md`, `AGENTS.md`

4. **Polish**
   - Review of barrel exports (`src/server/index.ts`)
   - Options validation at init (clear error messages)
   - `scripts/check-size.mjs` — verifies that `dist/server/index.mjs` is within the ≤ 18 KiB brotli budget
   - Final lint + typecheck + coverage report

5. **Release prep**
   - Tag `v0.1.0`
   - Trigger `release.yml` workflow (publish with `--provenance`)
   - Verify the npm page

---

## 16. Known Limitations

### 16.1 Framework

| Limitation       | Impact                                                                   | Alternative                                                |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **NestJS only**  | Does not work with plain Express, standalone Fastify, or other frameworks | BullMQ directly + your own factory                         |
| **Node.js only** | No support for Deno, Bun, or other runtimes                              | Not planned                                                |

### 16.2 BullMQ

| Limitation                                  | Impact                                                                    | Alternative                                              |
| ------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| **BullMQ `^5.16` (0.1.x)**                  | Floor is `5.16` (Job Schedulers); v6 enabled once e2e passes (already forward-compatible) | Track the lib's 1.x release for the `^6` promotion |
| **No support for legacy Bull (without MQ)** | Apps still using `bull` v4 or earlier need to migrate first                | Official BullMQ migration guide                          |
| **No support for Redis Cluster sharding**   | BullMQ has experimental support — the lib does not exercise those paths   | Manually validate in cluster environments                |

### 16.3 Connection

| Limitation                                       | Impact                                                                   | Alternative                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Mode A does not control connection health**    | If the consumer closes the connection silently, jobs fail silently       | Document the contract; consumer keeps the connection alive |
| **Mode B opens one connection per app instance** | In deployments with 10 instances, there are 10+ connections              | Configure `connectionName` for visibility in Redis      |
| **No advanced connection pooling**               | BullMQ does not use a pool — one connection per Worker/QueueEvents        | No alternative — inherent to BullMQ                     |

### 16.4 Features

| Limitation                                     | Impact                                                                    | Alternative                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| **No job versioning**                          | If the payload changes incompatibly, old jobs break                       | Version via `jobName` (`process-v2`)                    |
| **No native job tags / labels**                | BullMQ does not support query by tag                                      | Include tags inside `data` and filter manually          |
| **No built-in dead-letter queue helper**       | A job that exhausts `attempts` goes to `failed`, not to a separate DLQ    | Detect `attemptsMade >= attempts` in `@OnWorkerEvent('failed')` and re-enqueue to a `*-dlq` queue (pattern in §16.6) |

> Cron-with-seconds (6-field patterns) **is** supported — see §8.1. Native windowed **deduplication** is supported — see §5.4.1. Neither is a limitation.

### 16.5 Observability

OpenTelemetry tracing **is** supported via the optional `telemetry` option (§4) — spans propagate from `enqueue` through the handler when you pass a `bullmq-otel` instance. The remaining boundary is metrics export:

| Boundary                                  | Impact                                                                  | Where to implement                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| **No Prometheus metrics export**          | The lib exposes counters via `getMetrics()` but does not publish them   | Consumer reads `getMetrics()` / `getAll()` and publishes via `prom-client` |
| **No SLA/percentile history**             | Counters are instantaneous snapshots, not time-series                   | Consumer ships metrics to Prometheus/ClickHouse             |

### 16.6 Backpressure, payload size, and dead-letter patterns

These are documented patterns, not lib features — but a professional consumer must handle them:

- **Backpressure / unbounded growth.** `removeOnComplete`/`removeOnFail` bound retained *finished* jobs, but nothing bounds the **waiting** set if producers outpace workers. Monitor `getMetrics().counts.waiting`; when it crosses a threshold, throttle producers or `pauseQueue()`. Treat a growing `waiting` depth as the primary saturation signal.
- **Payload size.** Job data is stored in Redis and round-tripped as JSON; large payloads bloat memory and slow every operation. Keep payloads small (rule of thumb: < ~30 KB) and use the **claim-check pattern** — store the blob in S3/DB and enqueue only a reference. `enqueueBulk` arrays should be bounded (the lib caps batch size; see §16/Appendix B).
- **Dead-letter queue.** Move exhausted jobs explicitly:
  ```typescript
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await this.queue.enqueue('emails-dlq', job.name, job.data, {
        // preserve context for forensics
        jobId: `dlq:${job.id}`
      })
    }
  }
  ```

---

## 17. Example Integration

### 17.1 Complete setup (mode A — with `@bymax-one/nest-cache`)

```typescript
// app.module.ts
import { Module } from '@nestjs/common'
import { BymaxCacheModule, BYMAX_CACHE_QUEUE_REDIS } from '@bymax-one/nest-cache'
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import { BullMQOtel } from 'bullmq-otel'
import type { Redis } from 'ioredis'
import { EmailProcessor } from './email.processor'
import { ReportProcessor } from './report.processor'

@Module({
  imports: [
    BymaxCacheModule.forRoot({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      queueClient: { enabled: true }
    }),

    BymaxQueueModule.forRootAsync({
      imports: [BymaxCacheModule],
      inject: [BYMAX_CACHE_QUEUE_REDIS],
      useFactory: (queueRedis: Redis) => ({
        connection: { client: queueRedis },        // Mode A — worker conns duplicated with maxRetriesPerRequest:null
        prefix: `app:${process.env.NODE_ENV}`,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 }
        },
        flows: { enabled: true },
        metrics: { enabled: true, cacheTtlMs: 3000 },
        telemetry: new BullMQOtel('app-queue'), // OpenTelemetry spans (positional form works on the ^1 floor)
        shutdown: { drainTimeoutMs: 45_000 }
      })
    })
  ],
  providers: [EmailProcessor, ReportProcessor]
})
export class AppModule {}
```

### 17.2 Complete setup (mode B — own connection)

```typescript
BymaxQueueModule.forRoot({
  connection: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    options: {
      db: 2,
      tls: { rejectUnauthorized: true }
    }
  },
  defaultJobOptions: { attempts: 3 }
})
```

### 17.3 End-to-end typed job

```typescript
// shared/jobs/send-email.job.ts
export interface SendEmailJobData {
  readonly to: string
  readonly templateId: 'welcome' | 'reset-password' | 'invoice'
  readonly variables: Readonly<Record<string, string>>
}

export interface SendEmailJobResult {
  readonly messageId: string
  readonly acceptedAt: string
}

export const EMAIL_QUEUE = 'email' as const
export const SEND_EMAIL_JOB = 'send-email' as const
```

```typescript
// services/notifications.service.ts
import { Injectable } from '@nestjs/common'
import { QueueService } from '@bymax-one/nest-queue'
import { EMAIL_QUEUE, SEND_EMAIL_JOB, SendEmailJobData, SendEmailJobResult } from '../shared/jobs/send-email.job'

@Injectable()
export class NotificationsService {
  constructor(private readonly queue: QueueService) {}

  async sendWelcomeEmail(userId: string, email: string): Promise<void> {
    await this.queue.enqueue<SendEmailJobData, SendEmailJobResult>(
      EMAIL_QUEUE,
      SEND_EMAIL_JOB,
      {
        to: email,
        templateId: 'welcome',
        variables: { userId }
      },
      {
        priority: 10,
        jobId: `welcome:${userId}`  // deduplication
      }
    )
  }
}
```

### 17.4 Worker via decorator

```typescript
// processors/email.processor.ts
import { Injectable } from '@nestjs/common'
import { Processor, Process, OnWorkerEvent } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'
import { MailerService } from '../mailer.service'
import {
  EMAIL_QUEUE,
  SendEmailJobData,
  SendEmailJobResult
} from '../shared/jobs/send-email.job'

@Injectable()
@Processor(EMAIL_QUEUE, {
  concurrency: 5,
  limiter: { max: 10, duration: 1000 }  // 10 msg/s max (provider limit)
})
export class EmailProcessor {
  constructor(private readonly mailer: MailerService) {}

  @Process()
  async handle(job: Job<SendEmailJobData, SendEmailJobResult>): Promise<SendEmailJobResult> {
    const { to, templateId, variables } = job.data
    const result = await this.mailer.send({ to, templateId, variables })

    return {
      messageId: result.id,
      acceptedAt: new Date().toISOString()
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendEmailJobData> | undefined, error: Error): void {
    // Full Job in hand: forward job.data + error to alerting / structured log.
    // Move to a DLQ if attempts are exhausted (see §16.6).
  }
}
```

### 17.5 PDF pipeline flow

```typescript
// services/pdf-pipeline.service.ts
import { Injectable } from '@nestjs/common'
import { FlowService } from '@bymax-one/nest-queue'

@Injectable()
export class PdfPipelineService {
  constructor(private readonly flow: FlowService) {}

  async generateReport(reportId: string): Promise<string> {
    const result = await this.flow.add({
      name: 'compose-pdf',
      queueName: 'pdf',
      data: { reportId },
      children: [
        {
          name: 'fetch-data',
          queueName: 'data',
          data: { reportId }
        },
        {
          name: 'render-charts',
          queueName: 'render',
          data: { reportId },
          children: [
            { name: 'render-chart-1', queueName: 'render', data: { chartId: 'c1' } },
            { name: 'render-chart-2', queueName: 'render', data: { chartId: 'c2' } }
          ]
        }
      ]
    })
    return result.job.id ?? ''
  }
}
```

### 17.6 Recurring job via Job Scheduler (cron / interval)

```typescript
// bootstrap/schedulers.bootstrap.ts
import { Injectable, OnApplicationBootstrap } from '@nestjs/common'
import { QueueService } from '@bymax-one/nest-queue'

@Injectable()
export class SchedulersBootstrap implements OnApplicationBootstrap {
  constructor(private readonly queue: QueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Daily cleanup at 03:00 São Paulo — idempotent by schedulerId, safe on every boot
    await this.queue.upsertJobScheduler(
      'maintenance',
      'cleanup-soft-deleted',                       // schedulerId (stable upsert key)
      { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' },
      { name: 'cleanup', data: { batchSize: 1000 } }
    )

    // Heartbeat every 5 minutes
    await this.queue.upsertJobScheduler(
      'monitoring',
      'api-heartbeat',
      { every: 5 * 60 * 1000 },
      { name: 'heartbeat', data: { service: 'api', region: 'sa-east-1' } }
    )
  }
}
```

### 17.7 Health check endpoint

```typescript
// controllers/health.controller.ts
import { Controller, Get } from '@nestjs/common'
import { MetricsService } from '@bymax-one/nest-queue'

@Controller('health')
export class HealthController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('queues')
  async queues(): Promise<{ healthy: boolean; queues: readonly object[] }> {
    const all = await this.metrics.getAll()
    const stuck = all.filter(m => m.counts.active > 100 || m.counts.failed > 1000)
    return {
      healthy: stuck.length === 0,
      queues: all
    }
  }
}
```

### 17.8 Programmatic worker (dynamic creation)

```typescript
// bootstrap/dynamic-workers.bootstrap.ts
import { Injectable, OnModuleInit } from '@nestjs/common'
import { WorkerRegistry } from '@bymax-one/nest-queue'  // advanced API — for dynamic worker creation

@Injectable()
export class DynamicWorkersBootstrap implements OnModuleInit {
  constructor(
    private readonly workers: WorkerRegistry,
    private readonly tenants: TenantsService
  ) {}

  async onModuleInit(): Promise<void> {
    const activeTenants = await this.tenants.findActive()

    for (const tenant of activeTenants) {
      await this.workers.register({
        queueName: `email:${tenant.id}`,
        handler: async job => {
          // tenant-isolated processing
          return { messageId: 'x', acceptedAt: new Date().toISOString() }
        },
        options: {
          concurrency: tenant.tier === 'premium' ? 10 : 2,
          limiter: { max: tenant.emailRateLimit, duration: 1000 }
        }
      })
    }
  }
}
```

---

## 18. Testing Strategy and Quality Gates

### 18.1 Test layers

| Layer | Tooling | Scope | Gate |
| ----- | ------- | ----- | ---- |
| Unit | Jest + ts-jest | Every service, resolver, decorator, validator with mocked BullMQ/Redis | 100% line/branch on implemented files (`jest.coverage.config.ts` → `100/100/100/100`) |
| E2E | Jest + `@testcontainers/redis` | Real Redis: enqueue→process, schedulers, flows, deduplication, retry, graceful shutdown, connection-role policy | Must pass in CI; run on a dedicated config (`jest.e2e.config.ts`) |
| Mutation | Stryker (`jest.stryker.config.ts`) | Kills surviving mutants in core logic | `stryker.config.json` thresholds `{ high: 99, low: 95, break: 95 }`, target 100% — **pre-release gate**, not per-commit |

### 18.2 Coverage and mutation policy

- Coverage thresholds are configured to **fail the build** below 100% on implemented files; new code ships with its tests in the same phase (TDD).
- Mutation testing is expensive, so it runs in the release pipeline (and on demand), gating publication on `break 95`.
- Memory safety: Jest is capped (`maxWorkers: '50%'`) and recursive workspace scripts are serialized, so a local library dependency is not duplicated across many workers.

### 18.3 What the e2e suite must prove

Enqueue + process + typed result; bounded graceful shutdown (finish in-flight, force-close on timeout → `stalled`); 3-level flow completion; `upsertJobScheduler` fires repeatedly and re-upsert is idempotent; deduplication collapses duplicates; exponential retry → eventual success; Mode-A worker connection coerced to `maxRetriesPerRequest:null` while the Queue connection keeps defaults.

---

## 19. CI/CD and Release Engineering

### 19.1 Workflows (`.github/workflows/`)

| Workflow | Trigger | Responsibility |
| -------- | ------- | -------------- |
| `ci.yml` | PR + push | Install (frozen lockfile) → typecheck → lint → unit (100% coverage) → e2e (Testcontainers) → `check-size.mjs` budget |
| `codeql.yml` | push to main + weekly | Static analysis (TS/JS) |
| `scorecard.yml` | push to main + weekly | OpenSSF Scorecard (target ≥ 7.0) |
| `osv-scanner.yml` | PR + weekly | Dependency vulnerability scan (OSV) |
| `release.yml` | tag `v*` | typecheck → lint → coverage → mutation gate → build → `pnpm publish --provenance` (OIDC trusted publishing) |

### 19.2 Hardening

- All third-party actions **pinned by commit SHA**; workflows use least-privilege `permissions:`.
- Secret scanning via **TruffleHog OSS** in CI.
- Conventional Commits enforced by `commitlint.config.cjs`; the changelog is generated from commit history.
- **Provenance** attestation on every published artifact; npm publish token is 2FA/granular-scoped.

### 19.3 Repo-as-config deliverables

`SECURITY.md` (disclosure policy), `CLAUDE.md` + `AGENTS.md` (agent guidance), and the four Copilot review files (`.github/copilot-instructions.md`, `instructions/code.instructions.md`, `instructions/tests.instructions.md`, `agents/agent-code-reviewer.agent.md`).

### 19.4 Dogfood example

`nest-queue-example` consumes the published tarball end-to-end (Mode A with `@bymax-one/nest-cache`, a `@Processor`, a Job Scheduler, a flow, and a `/health` queue endpoint) and runs in CI before a release is finalized.

---

## 20. Versioning and Migration Policy

### 20.1 Library semver

- **SemVer**, strictly. Pre-1.0 (`0.x`) may break minor; from `1.0.0`, breaking changes bump major.
- The public surface is exactly what `src/server/index.ts` and `src/shared/index.ts` export. Re-exported BullMQ types are passthroughs and follow BullMQ.
- **Deprecation policy:** a public symbol is marked `@deprecated` for at least one minor before removal in the next major, with a documented replacement.

### 20.2 BullMQ engine compatibility

- Floor `bullmq ^5.16.0` (Job Schedulers). Promotion to `^5.16.0 || ^6.0.0` happens once the e2e suite is green on v6; because the lib already uses Job Schedulers (not the removed repeatable API) and no other removed v6 API, no public-API break is expected.

### 20.3 Consumer migration notes

- **From a hand-rolled BullMQ/`@nestjs/bullmq` setup:** `@Processor`+`WorkerHost.process()` maps to `@Processor`+`@Process()`; `@OnWorkerEvent`/`@OnQueueEvent` map 1:1 (worker-local handlers keep full `Job` access — see §6.5). `@InjectQueue('q')` producers route through `QueueService.getOrCreateQueue('q')` / `enqueue('q', …)`.
- **From the legacy repeatable API:** replace `queue.add(name, data, { repeat })` / `addRepeatable` with `upsertJobScheduler(queueName, schedulerId, repeat, { name, data })`; replace `removeRepeatable*` with `removeJobScheduler(queueName, schedulerId)`.

---

## 21. Comparison with `@nestjs/bullmq`

The official `@nestjs/bullmq` is excellent and this lib does not replace it lightly — it targets the opinionated, multi-app Bymax use case. Where they overlap, the differentiators are explicit:

| Concern | `@nestjs/bullmq` (official) | `@bymax-one/nest-queue` |
| ------- | -------------------------- | ----------------------- |
| Module setup | `BullModule.forRoot()` + `registerQueue()` per queue | Single `forRoot()`/`forRootAsync()`; queues created on demand by name (no per-queue registration) |
| Connection | You wire ioredis + `maxRetriesPerRequest` yourself | Dual mode (BYO client from `@bymax-one/nest-cache`, or lib-owned); correct per-role retry policy applied automatically |
| Job defaults | Per `registerQueue` | Centralized, opinionated `defaultJobOptions` (retry/backoff/retention) with per-queue/per-job overrides |
| Concurrency | Default `1` (silent) | Explicit `concurrency` enforced + warning; workload-type guidance |
| Producer API | `@InjectQueue` + raw `queue.add` | Typed `enqueue<TData, TResult>()`, `enqueueBulk`, `upsertJobScheduler`, with native deduplication surfaced |
| Shutdown | Framework closes workers | Explicit bounded-drain protocol with force-close + `stalled` accounting + connection-ownership rules |
| Observability | Manual | `telemetry` passthrough (OpenTelemetry) + `MetricsService` |
| Decorators | `@Processor`/`WorkerHost.process`, `@OnWorkerEvent`, `@OnQueueEvent` | `@Processor`/`@Process(jobName?)`, `@OnWorkerEvent`, `@OnQueueEvent` (method-level dispatch) |

**Choose this lib when** you run several NestJS apps that should share one opinionated queue setup, want the `@bymax-one/nest-cache` connection-sharing story, and value enforced defaults + a tested shutdown protocol. **Choose `@nestjs/bullmq`** when you want the thinnest possible official binding and prefer to wire connection/defaults yourself.

---

## Appendix A — Relevant architectural decisions

### A.1 Why two connection modes?

The lib needs to work both in apps that already use `@bymax-one/nest-cache` (common case in the bymax-one portfolio) and in apps that don't want to pull in the entire cache lib just to run workers. **Mode A** optimizes for sharing; **mode B** optimizes for simplicity.

### A.2 Why `concurrency` default = 2?

The BullMQ default of `1` is silently serial, which surprised teams in practice. `2` is a safe, non-serial starting point that has been used successfully in a production NestJS workload. It is **not** claimed to be optimal — §6.7 documents that the right value depends on workload type (I/O-bound vs CPU-bound) and that CPU-bound work belongs in a sandboxed processor (§6.8). The lib **warns** when `concurrency` is omitted and falls back to `DEFAULT_WORKER_CONCURRENCY`, so a missing value is always surfaced rather than silently serial.

### A.3 Why decorator + programmatic API?

Decorator covers 95% of cases (static, known at compile time). Programmatic API covers the remaining 5% (multi-tenancy with per-tenant workers). Keeping both does not cost significant complexity — they share 100% of the `Worker` creation logic via `WorkerRegistry`.

### A.4 Why not embed BullBoard?

BullBoard is a product with its own release cadence, with heavy peer deps (`@bull-board/express`, `@bull-board/api`). Coupling to the lib forces versions and freezes choices. Since `QueueService.getOrCreateQueue` returns the native BullMQ `Queue`, the consumer plugs in BullBoard in one line whenever they want.

### A.5 Why is there no `forFeature`?

The module is global by default (`isGlobal: true`, mapped via `ConfigurableModuleBuilder.setExtras`) — `QueueService` is a singleton accessible in any module of the app, reaching every queue by name. A `forFeature` that did nothing would be a documented no-op, which is a credibility risk in a public API, so it is **not** shipped. If per-queue DI tokens (`@InjectQueue('email')`) are added later, they will arrive as a real `forFeature(['email'])` that actually registers those tokens — an additive, non-breaking change.

---

## Appendix B — Security checklist

**Runtime / data**

- [ ] `maxRetriesPerRequest: null` applied **only** to worker/QueueEvents connections; Queue connection keeps default retries (§2.3)
- [ ] Options validated in `onModuleInit` (early, clear errors; fail-fast on un-coercible worker connection)
- [ ] **No `job.data` is logged by default** — the lib never logs payloads; the consumer opts in explicitly (privacy/PII invariant)
- [ ] Connection strings are **masked** (`redis://default:***@host:port`) before any log, exception message, or `QueueException.details`
- [ ] Job data is treated as **opaque** — never deep-merged into objects (prototype-pollution guard against `__proto__`/`constructor` keys)
- [ ] Cron patterns validated by **BullMQ's own `cron-parser`** (the lib rethrows parse failures as `queue.invalid_repeat_options`), never a hand-rolled regex (avoids ReDoS and 6-field bugs) and no direct dependency
- [ ] `enqueueBulk`/`addBulk` array length and per-job payload size are **bounded** (self-DoS / Redis-memory guard); large blobs use the claim-check pattern (§16.6)
- [ ] Redis transport uses **TLS** in production (`connection.options.tls`); connection config comes from secrets, never literals
- [ ] Redis **AUTH** required and a least-privilege **ACL** user recommended for the queue connection; Mode-B URL is operator-trusted only (no SSRF from untrusted config)

**Process / release (supply chain)**

- [ ] Graceful shutdown tested in e2e with a real `SIGTERM` (drain + force-close path)
- [ ] Mutation score: Stryker `break 95` (high 99, low 95), targeting 100%, as a pre-release gate
- [ ] 100% line/branch coverage on implemented files
- [ ] OSV-Scanner clean; `pnpm audit` clean on recommended peer deps
- [ ] TruffleHog OSS secret scan clean
- [ ] OpenSSF Scorecard ≥ 7.0; GitHub Actions pinned by commit SHA
- [ ] Committed lockfile enforced; npm publish with **provenance** (OIDC trusted publishing); publish token 2FA-protected
- [ ] `SECURITY.md` present with a disclosure policy

---

> **Next step:** after this spec is approved, expand §15 into `development_plan.md` (phased dashboard) and one file per phase under `docs/tasks/`.