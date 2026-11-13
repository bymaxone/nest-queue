<p align="center">
  <img src="https://img.shields.io/badge/%40bymax--one-nest--queue-000000?style=for-the-badge&logo=nestjs&logoColor=E0234E" alt="@bymax-one/nest-queue" />
</p>

<h1 align="center">@bymax-one/nest-queue</h1>

<p align="center">
  <strong>Typed BullMQ queues for NestJS</strong><br />
  <sub>BullMQ 6 · Workers · Flows · Job Schedulers · Deduplication · OpenTelemetry · Graceful Shutdown</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bymax-one/nest-queue"><img src="https://img.shields.io/npm/v/@bymax-one/nest-queue?style=flat-square&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@bymax-one/nest-queue"><img src="https://img.shields.io/npm/dm/@bymax-one/nest-queue?style=flat-square&colorA=000000&colorB=000000" alt="npm downloads" /></a>
  <a href="https://github.com/bymaxone/nest-queue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bymaxone/nest-queue/ci.yml?branch=main&style=flat-square&colorA=000000&label=CI" alt="CI status" /></a>
  <a href="https://github.com/bymaxone/nest-queue/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&colorA=000000" alt="coverage" /></a>
  <a href="https://github.com/bymaxone/nest-queue/blob/main/docs/mutation_testing_results.md"><img src="https://img.shields.io/badge/mutation-100%25-brightgreen?style=flat-square&colorA=000000" alt="mutation score" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/bymaxone/nest-queue"><img src="https://api.scorecard.dev/projects/github.com/bymaxone/nest-queue/badge?style=flat-square" alt="OpenSSF Scorecard" /></a>
  <a href="https://github.com/bymaxone/nest-queue/blob/main/LICENSE"><img src="https://img.shields.io/github/license/bymaxone/nest-queue?style=flat-square&colorA=000000&colorB=000000" alt="license" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="https://github.com/bymaxone/nest-queue">GitHub</a> ·
  <a href="https://github.com/bymaxone/nest-queue/issues">Issues</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-api-reference">API Reference</a> ·
  <a href="https://github.com/bymaxone/nest-queue-example">Example App</a>
</p>

---

## ✨ Overview

`@bymax-one/nest-queue` is a NestJS dynamic module that wraps **BullMQ 6** behind a typed,
opinionated surface. Instead of wiring `ioredis` connections, per-queue registration, and
`maxRetriesPerRequest` policy by hand, you install one library and get typed producers,
decorator-based workers, flows, recurring **Job Schedulers**, native deduplication,
OpenTelemetry passthrough, and a tested bounded graceful-shutdown protocol.

The library has **zero direct dependencies** — `bullmq`, `ioredis`, and `@nestjs/*` arrive as
peer dependencies, so you control exact versions and the supply-chain surface stays minimal.

---

## 🔥 Features

### 📤 Producing

- ✅ **One setup, every queue** — a single `forRoot` / `forRootAsync`; queues are created on demand by name, with no `registerQueue()` per queue
- ✅ **Typed producer API** — `enqueue<TData, TResult>()` threads both generics through to the returned `Job`, so `job.data` and `job.returnvalue` need no cast
- ✅ **Bounded bulk insert** — `enqueueBulk` adds up to 1 000 jobs in a single Redis roundtrip and rejects a larger batch outright, rather than letting one call inflate the heap
- ✅ **Native deduplication** — simple, throttle, debounce and keep-last-if-active, passed straight through to BullMQ; the library writes no deduplication logic of its own
- ✅ **Job Schedulers** — cron (5-field, or 6-field with seconds) and fixed intervals through `upsertJobScheduler`; the `addRepeatable` API removed in BullMQ v6 is never called
- ✅ **Flows** — opt-in `FlowService` over BullMQ's `FlowProducer`, with fail-parent semantics preserved

### ⚙️ Consuming

- ✅ **Decorator workers** — `@Processor`, `@Process`, `@OnWorkerEvent` and `@OnQueueEvent`, discovered automatically from your providers
- ✅ **Programmatic registry** — `WorkerRegistry.register()` for workers built at runtime, and `registerSandboxed()` for file-based out-of-process processors
- ✅ **Progress reporting** — `job.updateProgress()` with the matching worker event wired through to your handler

### 🔌 Connections & Shutdown

- ✅ **Dual-mode connection** — bring your own `ioredis` client, or let the library open its own from a URL or an options object
- ✅ **Per-role retry policy** — `maxRetriesPerRequest: null` reaches only the duplicated Worker and QueueEvents connections; the producer keeps a finite retry limit, a 5 s command deadline and no offline queue on the connection the library opens, and `enqueue` has its own 10 s deadline, so a Redis outage rejects a call in seconds instead of holding the request; a shared client with `maxRetriesPerRequest: null` is the exception, and the library warns about it at boot
- ✅ **One namespace, four objects** — the configured `prefix` reaches `Queue`, `Worker`, `QueueEvents` **and** `FlowProducer`, so producers and consumers can never end up on separate keyspaces
- ✅ **Bounded graceful shutdown** — a single ordered sequence drains every worker under a deadline and then force-closes; delivery is at-least-once by design, so handlers must be idempotent
- ✅ **No unlistened emitter** — every `Queue`, `Worker`, `QueueEvents` and `FlowProducer` the library creates carries a fallback `error` listener, so a transient Redis fault cannot become an uncaught exception in your process; your own `@OnWorkerEvent('error')` or `@OnQueueEvent('error')` still runs alongside it

### 🧩 Developer Experience

- ✅ **Stable error catalog** — namespaced codes exported from both subpaths, so a frontend maps a `code` without importing the server
- ✅ **Dual-format output** — ESM + CJS with declarations for each format, verified against the packed tarball on every PR
- ✅ **Opt-in observability** — OpenTelemetry passthrough via `bullmq-otel`, plus a `MetricsService` with a configurable TTL cache
- ✅ **Typed end to end** — TypeScript `strict` with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; zero `any`, no `@ts-ignore` and no `eslint-disable`

---

## 📦 Subpath Exports

`./shared` exists so a browser or edge bundle can import the job-status union and the
error-code catalog without pulling in `bullmq`, `ioredis`, or `@nestjs/*`. Nothing under
that subpath imports a runtime dependency.

| Subpath        | Import                         | Purpose                                                   |       Dependencies        |
| -------------- | ------------------------------ | --------------------------------------------------------- | :-----------------------: |
| **`.`**        | `@bymax-one/nest-queue`        | Full server surface: module, services, decorators, types  | NestJS · BullMQ · ioredis |
| **`./shared`** | `@bymax-one/nest-queue/shared` | Job-status union, error codes, metric and scheduler types |           none            |

```
@bymax-one/nest-queue          (server — NestJS + BullMQ + ioredis)
        │
        └── re-exports ──▶ @bymax-one/nest-queue/shared   (zero dependencies)
```

Both subpaths ship ESM **and** CommonJS with declarations for each format, so a
`require()` consumer receives CommonJS declarations rather than ESM ones. The
`pnpm check:exports` gate verifies this against the packed tarball.

### Peer dependency matrix

| Subpath      | Required peers                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `.` (server) | `@nestjs/common ^11.0.16`, `@nestjs/core ^11.1.18`, `bullmq ^6.0`, `ioredis ^6.0`, `reflect-metadata ^0.2` |
| `./shared`   | None                                                                                                       |
| Optional     | `bullmq-otel ^2` (OpenTelemetry)                                                                           |

> [!IMPORTANT]
> `reflect-metadata` is a **global polyfill the application owns** — import it once at
> the top of `main.ts`. This library never imports it, so it cannot be shipped twice
> into your bundle; NestJS pulls it in as well, which is why a correctly wired
> application already has it before a decorator runs.

---

> [!TIP]
> A full reference application lives in
> [`bymaxone/nest-queue-example`](https://github.com/bymaxone/nest-queue-example) —
> an API and a web console exercising every public export against a real Redis.

---

## 🚀 Quick Start

### 1. Install

```bash
pnpm add @bymax-one/nest-queue bullmq ioredis reflect-metadata
```

### 2. Load `reflect-metadata`

`reflect-metadata` is loaded **once by your application**, before anything else — this
is the standard NestJS entry point and the decorators in this library depend on it:

```typescript
// main.ts
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  await app.listen(3000)
}

void bootstrap()
```

### 3. Register the module

Wire the module in your root `AppModule`:

```typescript
import { Module } from '@nestjs/common'
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import { EmailModule } from './email.module'

@Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
    }),
    EmailModule,
  ],
})
export class AppModule {}
```

### 4. Enqueue a job

From any service:

```typescript
import { Injectable } from '@nestjs/common'
import { QueueService } from '@bymax-one/nest-queue'

@Injectable()
export class EmailService {
  constructor(private readonly queue: QueueService) {}

  async sendWelcome(userId: string): Promise<void> {
    await this.queue.enqueue<{ userId: string }, void>('email', 'welcome', { userId })
  }
}
```

### 5. Process jobs

With a decorated handler:

```typescript
import { Injectable } from '@nestjs/common'
import { Processor, Process } from '@bymax-one/nest-queue'
import type { Job } from '@bymax-one/nest-queue'

@Injectable()
@Processor('email')
export class EmailProcessor {
  @Process('welcome')
  async handleWelcome(job: Job<{ userId: string }, void>): Promise<void> {
    // handle job.data.userId
  }
}
```

### 6. Register the providers

Put the service and the processor in a feature module that `AppModule` imports, like the `EmailModule`
above. The module is global by default (`isGlobal` defaults to `true`), so `QueueService` is injectable
there without importing `BymaxQueueModule` again:

```typescript
import { Module } from '@nestjs/common'
import { EmailProcessor } from './email.processor'
import { EmailService } from './email.service'

@Module({
  providers: [EmailService, EmailProcessor],
})
export class EmailModule {}
```

---

## ⚙️ Configuration

Every option passed to `forRoot` / `forRootAsync`. Only `connection` is required.

| Option                     | Type                                             | Default                                                                                                                                    | Description                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`               | `{ client } \| { url, options? } \| { options }` | —                                                                                                                                          | **Required.** Mode A supplies an existing `ioredis` client; Mode B lets the library open its own. The arms are mutually exclusive.                                                                                                                                                                                          |
| `prefix`                   | `string`                                         | `'bull'`                                                                                                                                   | Redis key namespace. Applied to the `Queue`, `Worker`, `QueueEvents` **and** `FlowProducer` — see [Architecture](#-architecture).                                                                                                                                                                                           |
| `defaultJobOptions`        | `JobsOptions`                                    | `attempts: 3` · exponential backoff `2000` ms · `removeOnComplete: { age: 24 h, count: 1000 }` · `removeOnFail: { age: 7 d, count: 5000 }` | Merged into every job enqueued through the service; per-job options win. The bounded `removeOn*` caps are what keep Redis from growing without limit under a failure storm.                                                                                                                                                 |
| `queueOptions`             | `Partial<QueueOptions>`                          | `{}`                                                                                                                                       | Extra BullMQ `Queue` options. `connection`, `defaultJobOptions` and `prefix` are owned by the library and cannot be set here.                                                                                                                                                                                               |
| `flows.enabled`            | `boolean`                                        | `false`                                                                                                                                    | `FlowService` is always provided; while disabled, every method except `close()` throws `FLOW_DISABLED`.                                                                                                                                                                                                                     |
| `metrics.enabled`          | `boolean`                                        | `false`                                                                                                                                    | `MetricsService` is always provided; while disabled, every method throws `METRICS_DISABLED`.                                                                                                                                                                                                                                |
| `metrics.cacheTtlMs`       | `number`                                         | `5_000`                                                                                                                                    | TTL of the metrics snapshot cache. `0` disables caching. Must be `>= 0`.                                                                                                                                                                                                                                                    |
| `telemetry`                | `Telemetry`                                      | —                                                                                                                                          | A BullMQ `Telemetry` instance (typically `new BullMQOtel(...)` from the optional `bullmq-otel` peer), attached to every `Queue` and `Worker`.                                                                                                                                                                               |
| `shutdown.drainTimeoutMs`  | `number`                                         | `30_000`                                                                                                                                   | Upper bound on the graceful drain before workers are force-closed. Must be `> 0`.                                                                                                                                                                                                                                           |
| `shutdown.drainOnShutdown` | `boolean`                                        | `false`                                                                                                                                    | Development and test only: once the HTTP server has stopped, call `drain()` on every cached queue, which **removes** its waiting jobs (delayed and active jobs are left alone). Leave it `false` in production.                                                                                                             |
| `connectionReadyTimeoutMs` | `number`                                         | `10_000`                                                                                                                                   | Mode B only: the budget for Redis to reach `ready`. A connection error while the client is still reconnecting does not end the wait; when the budget ends, startup fails with `CONNECTION_TIMEOUT` carrying `lastErrorCode` (a code such as `ECONNREFUSED`, never the message) and the client the library opened is closed. |
| `commandTimeoutMs`         | `number`                                         | `5_000`                                                                                                                                    | Mode B only: the deadline for one Redis command on the connection the library opened (ioredis `commandTimeout`); an `options.commandTimeout` wins. Worker and QueueEvents connections have none.                                                                                                                            |
| `enqueueTimeoutMs`         | `number`                                         | `10_000`                                                                                                                                   | The deadline for one `enqueue` or `enqueueBulk`, in either mode; it rejects with `CONNECTION_TIMEOUT`, and the add may still complete in Redis, so retry with a stable `jobId` or `deduplication`.                                                                                                                          |
| `isGlobal`                 | `boolean`                                        | `true`                                                                                                                                     | Register the module globally, so `QueueService` is injectable without re-importing.                                                                                                                                                                                                                                         |

> [!WARNING]
> **`shutdown.drainOnShutdown` deletes jobs.** When it is `true`, shutdown calls `drain()` on every
> queue this process created, which removes all of that queue's waiting jobs from
> Redis, including the ones other instances were about to process. It exists for development and
> tests that need an empty queue. Never enable it in production.

Invalid options are rejected at bootstrap with `QueueException(INVALID_OPTIONS)` — never
silently corrected. A misconfigured queue fails when the application starts, not when the
first job is enqueued.

---

## 🔌 Connections

`connection` takes a client (**Mode A**) or a URL or ioredis options (**Mode B**); the arms are mutually
exclusive. In both modes the Queue connection keeps the ioredis defaults, and the Worker and
`QueueEvents` connections are `duplicate()`s of it with `maxRetriesPerRequest: null`.

### Mode A — your own client

Recommended when the application already runs `@bymax-one/nest-cache`: one client is shared and
duplicated per role, and your cache connection is left alone.

```typescript
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import { ConnectionManager } from '@bymax-one/nest-cache'
import type { Redis } from 'ioredis'

BymaxQueueModule.forRootAsync({
  inject: [ConnectionManager],
  useFactory: (cache: ConnectionManager) => ({
    connection: { client: cache.getClient() as Redis },
  }),
})
```

`BymaxCacheModule` is global by default and provides `ConnectionManager`. `getClient()` is typed
`Redis | Cluster` and Mode A takes a standalone `Redis`, so run `@bymax-one/nest-cache` in standalone mode.

### Mode B — a connection the library owns

```typescript
// URL form
BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
})

// Options form
BymaxQueueModule.forRoot({
  connection: {
    options: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD ?? undefined,
      tls: {},
    },
  },
})
```

### Connection budget

The connections held are linear in what you register. Counts were read from `INFO clients` against
Redis 8 with BullMQ 6 and `ioredis` 6; every connection the library opens is released when the application context closes.

| What you register                              | Connections held                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| The module, Mode B                             | 1, shared by every queue and every flow                                 |
| The module, Mode A                             | 0 of its own; your client is yours and is never counted                 |
| Each worker (`@Processor` or `WorkerRegistry`) | 2: a blocking connection that waits for jobs, and a command connection  |
| Each queue observed with `@OnQueueEvent`       | 2: a blocking connection that reads the event stream, and a command one |

Queues and `FlowService` add none, so the cost comes from consumers: a blocking connection is parked
inside a blocking command until a job arrives and cannot be shared. **Example:** 20 workers and 5 observed
queues in Mode B hold 1 + (2 × 20) + (2 × 5) = **51** connections (50 in Mode A, plus whatever your own
client uses). Each instance opens its own set, so three instances hold 153.

Hosted Redis plans cap concurrent connections: multiply by the instances you run (rolling deploys
overlap old and new) and compare with your plan's limit; self-managed Redis allows 10 000 (`maxclients`).
In `CLIENT LIST`, a worker's blocking connection is named `<prefix>:<base64 of the queue name>…`; the
command connection is unnamed.

---

## 🎀 Decorators

### `@Processor(queueName)`

Marks a class as a worker bound to `queueName`. The class must be an `@Injectable()` registered as a NestJS provider.

### `@Process(jobName?)`

Method decorator for the handler. If `jobName` is omitted, the method handles all jobs on the queue. If provided, only jobs with that `name` are dispatched here.

```typescript
@Process()
async handleAll(job: Job): Promise<void> { /* … */ }

@Process('send-email')
async handleSendEmail(job: Job<EmailPayload>): Promise<void> { /* … */ }
```

### `@OnWorkerEvent(eventName)`

Listens to BullMQ worker-local events (`'completed'`, `'failed'`, `'progress'`, `'active'`, `'stalled'`, …).

```typescript
@OnWorkerEvent('failed')
onFailed(job: Job | undefined, err: Error): void {
  console.error(`Job ${job?.id} failed:`, err.message)
}
```

A listener that throws, or returns a promise that rejects, is logged with the handler's name and the code `queue.event_handler_failed` and the process carries on; it is never an unhandled rejection. Handle the error inside the listener when the failure matters.

### `@OnQueueEvent(eventName)`

Listens to BullMQ `QueueEvents` (global, cross-process events). The library opens one shared `QueueEvents` connection per queue when it discovers the first listener for it; there is no option to enable.

The handler receives one serialized payload object, not a `Job`: `completed` carries `{ jobId, returnvalue, prev? }`, `failed` carries `{ jobId, failedReason, prev? }`, and `error` carries a real `Error`. Fetch the job with `QueueService.getJob` when you need it.

```typescript
@OnQueueEvent('completed')
onCompleted({ jobId, returnvalue }: { jobId: string; returnvalue: string }): void {
  console.log(`Job ${jobId} completed with ${returnvalue}`)
}
```

---

## ⏰ Job Schedulers

Job Schedulers are the current recurring-jobs API in BullMQ (superseding the removed `addRepeatable` API). Use `upsertJobScheduler` to create or update a scheduler:

```typescript
// Cron-based (every day at 9 AM)
await this.queue.upsertJobScheduler(
  'notifications',
  'daily-digest',
  { pattern: '0 9 * * *' },
  { name: 'send-digest', data: { type: 'daily' } },
)

// Interval-based (every 5 minutes)
await this.queue.upsertJobScheduler(
  'health-check',
  'ping',
  { every: 5 * 60 * 1000 },
  { name: 'ping', data: {} },
)

// Remove
await this.queue.removeJobScheduler('notifications', 'daily-digest')

// List
const schedulers = await this.queue.getJobSchedulers('notifications')
```

Cron-with-seconds (6-field patterns) is supported. Patterns are validated by BullMQ's
own `cron-parser`, not a hand-rolled regex.
A pattern the parser rejects is `INVALID_REPEAT_OPTIONS` (400) before Redis is asked. Every other failure of the upsert, such as a read-only replica or a lost connection, reaches you as it is.

---

## 🔁 Deduplication & Telemetry

### Deduplication

Pass the `deduplication` option directly on `enqueue` — the library delegates the behavior entirely to BullMQ:

```typescript
const id = `welcome:${userId}`

// Simple: collapse duplicates until the first in-flight job completes
await this.queue.enqueue('email', 'welcome', { userId }, { deduplication: { id } })

// Throttle: ignore duplicates for 30 seconds
await this.queue.enqueue('email', 'welcome', { userId }, { deduplication: { id, ttl: 30_000 } })

// Debounce: keep only the latest; each duplicate resets the TTL
await this.queue.enqueue(
  'email',
  'welcome',
  { userId },
  { deduplication: { id, ttl: 5_000, extend: true, replace: true } },
)
```

### A duplicate does not add a job

When a custom `jobId` already exists, or a `deduplication` rule keeps the job that is already there (a rule with `replace` swaps it for the new one instead), `enqueue`, `enqueueBulk` and the flow methods add nothing: BullMQ answers with the id of the **existing** job together with the data and options of **this** call, so the returned object does not describe what is stored. Call `QueueService.getJob` when you need the stored job.

### A timed-out `enqueue` may still have been added

When Redis does not answer within `enqueueTimeoutMs`, `enqueue` and `enqueueBulk` reject with `CONNECTION_TIMEOUT`, but the library cannot cancel the command: if Redis applies it late, the job exists anyway. Retrying a call that timed out can therefore add the job twice. For anything that must not run twice, pass a deterministic `jobId` (for example one derived from the business key): BullMQ ignores a second add with the same `jobId` for as long as the first job is still stored, so a retry inside that window is safe. A completed job is removed by `removeOnComplete`, and from then on the same `jobId` adds a new job, so keep the retry inside that window or keep the handler idempotent. A `deduplication` rule gives the same guarantee for work that is allowed to repeat after a window.

### OpenTelemetry

Pass a `bullmq-otel` telemetry instance (optional peer dep) to trace spans from `enqueue` through the handler:

```typescript
import { BullMQOtel } from 'bullmq-otel'

BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  telemetry: new BullMQOtel({ tracerName: 'my-service' }),
})
```

---

## 🛑 Graceful Shutdown

`QueueLifecycle` runs automatically when NestJS closes the application context, through its `onModuleDestroy` and `onApplicationShutdown` hooks (call `app.enableShutdownHooks()` so that a termination signal closes the context).
It implements a **bounded drain protocol** with at-least-once semantics:

1. All workers are closed **in parallel**, within one budget (`drainTimeoutMs`, default 30 s) that
   covers steps 1 to 4 together: however many workers are stuck, consumption stops after one budget,
   not one per worker.
2. A worker resolves either when it drains normally or when the budget runs out — whichever comes
   first.
3. On timeout, the worker is force-closed (`worker.close(true)`), preserving stalled
   jobs for reprocessing by the next instance.
4. Queue-events and the connections the library opened for workers and queue-events are closed,
   each within what is left of the budget; a connection that has not quit by then is disconnected.
5. Once NestJS has stopped the HTTP server (`onApplicationShutdown`), the flow producer, the
   cached queues and, in Mode B, the library's own Redis connection are closed. NestJS runs
   `onModuleDestroy` before it stops the HTTP server, so a request that is still being served can
   enqueue a job after step 4; those resources stay open until the server is down.

**Handlers must be idempotent.** Use `jobId`, `deduplication`, or application-level
idempotency keys to guard against reprocessing a job that was partially handled before
a crash or force-close.

**DLQ pattern.** When a job exhausts its `attempts`, move it to a dead-letter queue:

```typescript
@OnWorkerEvent('failed')
async onFailed(job: Job | undefined, err: Error): Promise<void> {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await this.queue.enqueue(`${job.queueName}-dlq`, job.name, job.data, {
      jobId: `dlq:${job.id}`,
    })
  }
}
```

Tune `drainTimeoutMs` when jobs may run longer than 30 s:

```typescript
BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  shutdown: { drainTimeoutMs: 60_000 },
})
```

---

## 🤔 Why over `@nestjs/bullmq`

| Concern       | `@nestjs/bullmq` (official)                          | `@bymax-one/nest-queue`                                                          |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Module setup  | `BullModule.forRoot()` + `registerQueue()` per queue | Single `forRoot`/`forRootAsync`; queues created on demand by name                |
| Connection    | Manual ioredis + `maxRetriesPerRequest` wiring       | Dual mode (BYO / lib-owned); correct per-role retry policy applied automatically |
| Job defaults  | Per `registerQueue`                                  | Centralized opinionated defaults with per-queue/per-job overrides                |
| Producer API  | `@InjectQueue` + raw `queue.add`                     | Typed `enqueue<TData, TResult>()`, `enqueueBulk`, `upsertJobScheduler`           |
| Shutdown      | Framework closes workers                             | Explicit bounded-drain protocol; force-close + stalled accounting                |
| Observability | Manual                                               | `telemetry` passthrough (OpenTelemetry) + `MetricsService`                       |

**Choose this library** when you want a single opinionated setup, the `@bymax-one/nest-cache`
connection-sharing story, enforced defaults, and a tested bounded-shutdown protocol.

**Choose `@nestjs/bullmq`** when you want the thinnest official binding and prefer to
wire connection and defaults yourself.

---

## 🏗️ Architecture

```
                        BymaxQueueModule.forRoot / forRootAsync
                                        │
                              validateOptions (fail fast)
                                        │
                               applyDefaults (frozen)
                                        │
                          ┌─────────────┴─────────────┐
                          │     ConnectionResolver    │
                          │  Mode A: your ioredis     │
                          │  Mode B: lib-owned        │
                          └─────────────┬─────────────┘
                                        │
       ┌──────────────┬─────────────────┼─────────────────┬──────────────┐
       │              │                 │                 │              │
   QueueService  WorkerRegistry  QueueEventsRegistry  FlowService   MetricsService
    (Queue)        (Worker)         (QueueEvents)    (FlowProducer)   (opt-in)
       │              │                 │                 │
   default        duplicate()      duplicate()         default
   retries      maxRetries: null  maxRetries: null      retries
       │              │                 │                 │
       └──────────────┴────── same `prefix` ──────────────┘
                                        │
                            ProcessorDiscoveryService
                        (@Processor / @Process / @OnWorkerEvent)
                                        │
                                 QueueLifecycle
                     (bounded drain → force close → disconnect)
```

### Design Principles

The role-shaped connections, the shared `prefix` and the Job Scheduler API are described under
[Features](#-features) and [Connections](#-connections). Two principles are not:

| Principle                           | Description                                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 💥 **Fail at boot, not at runtime** | Options are validated before any connection is opened, and every rejection carries a distinct reason.                                                                                                                               |
| 🧬 **Explicit DI tokens**           | Tokens are `Symbol()` and every injectable constructor parameter carries an explicit `@Inject`. The package ships bundled, where design-time metadata is not emitted — implicit resolution would break inside your build, not ours. |

---

## 🔐 Security Model

This library moves your application's data through Redis and runs your code against it.
Its security contract is about what it does with credentials, what it puts in a payload,
and which keyspace a job lands in.

### Credentials never leave the configuration

Connection details arrive through injected options — the library never reads
`process.env` itself, so credentials live wherever your configuration layer keeps them.
No connection string, password, or TLS material is written to a log line, an exception
message, or an exception payload. `QueueException.details` carries only scalar
values — a reason, a limit, a queue or scheduler name, a status — never a
connection object and never `job.data`.

They are also not reachable by serializing the objects that hold them. The connection is
attached to the resolved options as a non-enumerable accessor, and the resolver keeps the
ioredis client — which carries `options.password` as a plain field — in a private field,
as do the registries that hold the `Queue`, `Worker` and `QueueEvents` instances. So
`JSON.stringify`, object spread, `util.inspect` and `util.inspect` with `showHidden` all
come back without credentials, which is what matters when a structured logger renders a
provider it was handed or an error reporter captures the scope of a throw.

### Job data is opaque

The library treats `job.data` as a payload to transport, never to inspect. It is never
deep-merged (which would expose a prototype-pollution path from a queued payload), never
logged, and never copied into an error. Whatever you enqueue is what your handler
receives — so a payload holding a secret is a decision you make, and Redis is where it
will sit until the job is removed.

### The prefix is a namespace, not a security boundary

`prefix` isolates one tenant's or one environment's keys from another's inside a single
Redis database. It is enforced consistently — `Queue`, `Worker`, `QueueEvents` and
`FlowProducer` all receive it — so jobs cannot be produced into one namespace and
consumed from another. It is **not** an access control: anything that can reach the Redis
instance can read every namespace on it. Cross-tenant isolation that must survive a
compromised client belongs in Redis ACLs or separate instances.

### Shutdown is bounded and at-least-once

A job still running when the drain deadline expires is **not** acknowledged, so BullMQ's stalled-job
check re-queues it and it runs again. **Every handler must be idempotent** — see
[Graceful Shutdown](#-graceful-shutdown).

### Security Checklist

- [ ] Redis reachable only from the application network — never exposed publicly.
- [ ] Redis requires authentication (`requirepass` or ACL user) and TLS in transit.
- [ ] A distinct `prefix` per tenant or environment, and a distinct Redis ACL user or
      instance where the isolation must hold against a compromised client.
- [ ] Every `@Process` handler is idempotent — retries and stalled-job recovery both
      replay work.
- [ ] Job payloads carry identifiers, not secrets. If a payload must reference a secret,
      store a reference and resolve it inside the handler.
- [ ] `removeOnComplete` / `removeOnFail` are bounded, so payloads do not accumulate in
      Redis indefinitely.
- [ ] `shutdown.drainTimeoutMs` exceeds your worst-case job runtime, so a normal deploy
      does not force-close work that was about to finish.

---

## 🛡️ Security Table

| Layer             | Implementation                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials       | Injected options only; never read from `process.env`, never logged, never placed in an exception; held in a non-enumerable accessor and private fields, so serializing a service omits them |
| Error payloads    | `QueueException.details` restricted to scalar values — no `job.data`, no connection object                                                                                                  |
| Job payloads      | Treated as opaque; never deep-merged (prototype-pollution guard), never logged                                                                                                              |
| Namespacing       | `prefix` applied uniformly to `Queue`, `Worker`, `QueueEvents` and `FlowProducer`                                                                                                           |
| Connection policy | `maxRetriesPerRequest: null` confined to duplicated consumer connections; producers keep finite retries, a command deadline and no offline queue (Mode B)                                   |
| Delivery          | At-least-once with a bounded drain; unacknowledged work is re-queued by BullMQ's stalled check                                                                                              |
| Supply chain      | SHA-pinned third-party Actions, OSV-Scanner, TruffleHog, OpenSSF Scorecard; npm publish over OIDC                                                                                           |
| Input validation  | Options validated at bootstrap; cron patterns validated by BullMQ's own parser, never a hand-rolled regex                                                                                   |

---

## 🧱 Tech Stack

[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs&logoColor=white)](https://nestjs.com)
[![BullMQ](https://img.shields.io/badge/BullMQ-6-DC382D?style=flat-square)](https://bullmq.io)
[![ioredis](https://img.shields.io/badge/ioredis-6-DC382D?style=flat-square&logo=redis&logoColor=white)](https://github.com/redis/ioredis)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Jest](https://img.shields.io/badge/Jest-30-C21325?style=flat-square&logo=jest)](https://jestjs.io)
[![Testcontainers](https://img.shields.io/badge/Testcontainers-E2E-2496ED?style=flat-square&logo=docker&logoColor=white)](https://testcontainers.com)
[![Stryker](https://img.shields.io/badge/Stryker-Mutation_Testing-red?style=flat-square)](https://stryker-mutator.io)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)
[![tsup](https://img.shields.io/badge/tsup-8-orange?style=flat-square)](https://tsup.egoist.dev)

---

## 🧪 Testing & Quality

- **100% line/branch coverage** on every implemented file (hard CI gate).
- **Mutation score 100.00%** (Stryker `break 100`) — see [`docs/mutation_testing_results.md`](docs/mutation_testing_results.md).
- **Real-Redis E2E** via Testcontainers (workers, flows, schedulers, deduplication, retries,
  DLQ, graceful shutdown).
- **Type-level API tests** (`pnpm test:types`) pin the published signatures, so a refactor
  that widens or loosens one fails the build instead of reaching consumers.
- **Published-shape gates**: `pnpm check:exports` resolves every entrypoint the way each
  module-resolution mode would (all four `attw` quadrants green, `node10` included), and
  `pnpm smoke` resolves the packed tarball from a real consumer in ESM _and_ CommonJS.
- **Bundle budgets** enforced by `pnpm size`.

```bash
pnpm typecheck && pnpm test:types && pnpm lint && pnpm test:cov:all && \
  pnpm build && pnpm size && pnpm check:exports && pnpm check:published && pnpm smoke
```

---

## 📖 API Reference

### `QueueService`

The central interaction point with BullMQ queues.

```typescript
import { QueueService } from '@bymax-one/nest-queue'
import type {
  Job,
  JobsOptions,
  JobSchedulerRepeatOptions,
  QueueMetrics,
} from '@bymax-one/nest-queue'
```

| Method               | Signature                                                                                    | Description                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `enqueue`            | `<TData, TResult>(queue, name, data, opts?) → Promise<Job<TData, TResult>>`                  | Add a single job                                                                           |
| `enqueueBulk`        | `<TData, TResult>(queue, jobs) → Promise<Job<TData, TResult>[]>`                             | Add up to 1 000 jobs in one Redis roundtrip                                                |
| `getJob`             | `<TData, TResult>(queue, jobId) → Promise<Job<TData, TResult> \| null>`                      | Get job by ID; `null` when it does not exist                                               |
| `getJobs`            | `<TData, TResult>(queue, status, start?, end?) → Promise<Job<TData, TResult>[]>`             | Page jobs in one status (default `0`–`50`)                                                 |
| `getMetrics`         | `(queue) → Promise<QueueMetrics>`                                                            | Uncached snapshot of job counts per status, with a collection timestamp                    |
| `pauseQueue`         | `(queue) → Promise<void>`                                                                    | Pause a queue                                                                              |
| `resumeQueue`        | `(queue) → Promise<void>`                                                                    | Resume a paused queue                                                                      |
| `cleanQueue`         | `(queue, gracePeriodMs, limit, status?) → Promise<string[]>`                                 | Remove up to `limit` jobs older than `gracePeriodMs` (`0` = no limit); returns removed ids |
| `upsertJobScheduler` | `<TData, TResult>(queue, id, repeat, template?) → Promise<Job<TData, TResult> \| undefined>` | Create or update a recurring Job Scheduler; returns the first scheduled job                |
| `removeJobScheduler` | `(queue, id) → Promise<boolean>`                                                             | Remove a Job Scheduler by ID                                                               |
| `getJobSchedulers`   | `(queue, start?, end?, asc?) → Promise<JobSchedulerJson[]>`                                  | Page the schedulers registered on a queue                                                  |
| `getOrCreateQueue`   | `<TData, TResult>(queue, overrides?) → Queue<TData, TResult>`                                | Return the cached raw `Queue` instance                                                     |
| `getCachedQueues`    | `() → ReadonlyMap<string, Queue>`                                                            | Read-only view of every queue created so far                                               |

### `WorkerRegistry`

Programmatic API to create and manage BullMQ workers at runtime.

```typescript
import path from 'node:path'
import { WorkerRegistry } from '@bymax-one/nest-queue'
import type { ProgrammaticWorkerConfig, SandboxedWorkerConfig } from '@bymax-one/nest-queue'

// Register an in-process worker
registry.register({
  queueName: 'email',
  handler: async (job) => {
    /* … */
  },
  options: { concurrency: 4 },
})

// Register a sandboxed (out-of-process) processor
registry.registerSandboxed({
  queueName: 'heavy-compute',
  processorFile: path.resolve(__dirname, 'compute.processor.js'),
  options: { concurrency: 2 },
})
```

### `FlowService` (opt-in)

Enable flows in the module options and inject the service:

```typescript
BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  flows: { enabled: true },
})

// Then inject:
import { FlowService } from '@bymax-one/nest-queue'
import type { FlowJob, JobNode } from '@bymax-one/nest-queue'

const tree: JobNode = await this.flows.add({
  name: 'process-order',
  queueName: 'orders',
  data: { orderId: '123' },
  children: [
    { name: 'charge-payment', queueName: 'payments', data: {} },
    { name: 'send-confirmation', queueName: 'email', data: {} },
  ],
})
```

### `MetricsService` (opt-in)

Provide a per-queue snapshot with a configurable TTL cache:

```typescript
BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  metrics: { enabled: true, cacheTtlMs: 5_000 },
})

import { MetricsService } from '@bymax-one/nest-queue'
import type { QueueMetrics } from '@bymax-one/nest-queue'

const metrics: QueueMetrics = await this.metricsService.get('email')
const all: readonly QueueMetrics[] = await this.metricsService.getAll()
```

### Other exports

| Export                                                                                                                                | What it is                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `WorkerRegistry.unregister(queue)`, `list()`                                                                                          | Stop and remove a worker and its connection; list the queue names that have a worker                         |
| `FlowService.addBulk(flows)`, `getProducer()`, `close()`                                                                              | Add several flows at once; the underlying BullMQ `FlowProducer`; close it (a no-op while flows are disabled) |
| `MetricsService.invalidate(queue?)`                                                                                                   | Drop the cached snapshot of one queue, or of all of them                                                     |
| `QueueEventsRegistry`                                                                                                                 | The shared `QueueEvents` per queue (`getOrCreate`, `list`), used by `@OnQueueEvent`                          |
| `BYMAX_QUEUE_OPTIONS`, `BYMAX_QUEUE_RESOLVED_OPTIONS`                                                                                 | Injection tokens for the options as given and with the defaults applied                                      |
| `BYMAX_QUEUE_REDIS_CLIENT`, `BYMAX_QUEUE_CONNECTION_MODE`                                                                             | Injection tokens for the Queue-role ioredis client and for `'mode-a-byo'` or `'mode-b-owned'`                |
| `DEFAULT_WORKER_CONCURRENCY`, `MAX_WORKER_CONCURRENCY`                                                                                | The worker concurrency used when none is given, and its ceiling                                              |
| `DEFAULT_JOB_OPTIONS`, `DEFAULT_METRICS_CACHE_TTL_MS`, `DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`                                            | The defaults of the Configuration table                                                                      |
| `QUEUE_ERROR_MESSAGES`                                                                                                                | The default message of each error code                                                                       |
| `BymaxQueueModuleOptions`, `BymaxQueueModuleAsyncOptions`, `BymaxQueueOptionsFactory`, `QueueConnectionConfig`, `QueueConnectionMode` | The option and connection types behind `forRoot` and `forRootAsync`                                          |
| `ProcessorMetadata`, `ProcessHandlerMetadata`, `QueueEventListenerMetadata`                                                           | The reflection metadata the decorators write                                                                 |
| `JobStatus`, `JOB_STATUS`, `BulkJob`, `SandboxedJob`, `WorkerEventName`, `QueueEventName`, `WorkerOptions`                            | Constants and types for the APIs above                                                                       |

---

## 🚨 Error Code Catalog

Whatever **this library rejects** is a `QueueException` carrying a stable,
transport-independent `code`. Branch on the code, never on the HTTP status or the
message text — the code is the contract.

Whatever **fails underneath it** is not wrapped at all. A dropped connection, a
timeout or any other operational fault reaches you as the original error, with its
own type and message, rather than being relabelled as invalid input. So the catalog
below is a complete list of the library's own rejections, and deliberately not a
complete list of everything a call can throw.

```typescript
import { QueueException, QUEUE_ERROR_CODES } from '@bymax-one/nest-queue'

try {
  await queue.enqueue('email', 'welcome', { userId })
} catch (err) {
  if (err instanceof QueueException) {
    const { code } = (err.getResponse() as { error: { code: string } }).error
    if (code === QUEUE_ERROR_CODES.BULK_ENQUEUE_FAILED) {
      /* … */
    }
  }
}
```

| Code                                     | HTTP | When thrown                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | :--: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue.invalid_options`                  | 500  | Module options failed bootstrap validation — missing `connection`, mutually exclusive connection arms, non-positive `shutdown.drainTimeoutMs`, or negative `metrics.cacheTtlMs`                                                                                                                   |
| `queue.connection_invalid`               | 500  | The resolver has no usable client: not yet initialized, Mode A's injected client is in an unusable `status`, or a Mode B client was refused by the server (`WRONGPASS`, `NOAUTH`) or stopped reconnecting during startup                                                                          |
| `queue.connection_requires_null_retries` | 500  | A consumer connection could not be coerced to `maxRetriesPerRequest: null`                                                                                                                                                                                                                        |
| `queue.connection_timeout`               | 500  | Mode B: Redis did not reach `ready` within `connectionReadyTimeoutMs` (`details` carries `timeoutMs` and the last error's `lastErrorCode`), or `enqueue`/`enqueueBulk` got no answer within `enqueueTimeoutMs` (`details` carries `operation` and `timeoutMs`; the job may still have been added) |
| `queue.invalid_repeat_options`           | 400  | A Job Scheduler schedule was rejected — invalid cron pattern, or neither `pattern` nor `every`                                                                                                                                                                                                    |
| `queue.duplicate_processor`              | 500  | Two `@Processor` classes claim the same queue name                                                                                                                                                                                                                                                |
| `queue.flow_disabled`                    | 503  | `FlowService` used without `flows.enabled`                                                                                                                                                                                                                                                        |
| `queue.metrics_disabled`                 | 503  | `MetricsService` used without `metrics.enabled`                                                                                                                                                                                                                                                   |
| `queue.bulk_enqueue_failed`              | 500  | `enqueueBulk` exceeded the 1 000-job cap, or the underlying `addBulk` failed                                                                                                                                                                                                                      |
| `queue.worker_registration_failed`       | 500  | A worker could not be constructed, started, or closed                                                                                                                                                                                                                                             |

### Reserved codes

These are part of the published catalog and stable, but nothing currently throws them.
They are listed so a consumer writing an exhaustive `switch` over `QueueErrorCode`
compiles today and keeps compiling when a future release starts emitting them.

| Code                              | Why it is not thrown today                                            |
| --------------------------------- | --------------------------------------------------------------------- |
| `queue.queue_not_found`           | Queues are created on demand by name, so a lookup never misses        |
| `queue.job_not_found`             | `getJob` resolves to `null` rather than throwing                      |
| `queue.invalid_job_data`          | Payloads are opaque; the library does not validate them               |
| `queue.shutdown_timeout_exceeded` | Exceeding the drain deadline force-closes workers rather than raising |

The same catalog is exported from `@bymax-one/nest-queue/shared` with no dependencies,
so a frontend can map codes to messages without importing the server surface.

---

## 🩺 Troubleshooting

### `ERR_PNPM_IGNORED_BUILDS: msgpackr-extract` on install (pnpm 11)

pnpm 11 blocks the build script of `msgpackr-extract`, a native optional dependency of BullMQ, and fails the
install. Approve it once with `pnpm approve-builds`, or in `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - msgpackr-extract
```

Skipping the build is also fine: `msgpackr` falls back to pure JavaScript, only without the native accelerator.

### `CONNECTION_REQUIRES_NULL_RETRIES`

BullMQ workers need `maxRetriesPerRequest: null` to block on Redis operations rather
than giving up after a few retries. The library does not ask you to configure it: every
Worker and `QueueEvents` connection is a `duplicate()` of the client you pass, made with
`maxRetriesPerRequest: null`, and in Mode A it checks that a duplicate really comes back
that way. This error means one did not — measured with ioredis, a client created with
`maxRetriesPerRequest: 3` duplicates to `null`, so a stock client never triggers it.

If you see it, the client you passed is not a plain ioredis client (a wrapper or a test
double whose `duplicate()` ignores its options). Pass the ioredis client itself, or let the
library open its own connection with Mode B. The producer keeps the client's own retry
policy; with a finite `maxRetriesPerRequest` that is what lets it fail fast during an outage, and
`enqueue` is bounded by `enqueueTimeoutMs` whatever the client does.

### Jobs get stuck (not processed after restart)

Stalled jobs are re-queued automatically by BullMQ's stalled-job check. If workers
do not pick them up:

1. Verify `drainTimeoutMs` is larger than the worst-case job runtime.
2. Verify `lockDuration` (in the `options` you pass to `@Processor` or `register`) covers
   the handler execution time — a worker that runs longer than `lockDuration` will have its
   lock stolen, marking the job as stalled.
3. BullMQ re-queues a stalled job up to its `maxStalledCount` times (default `1`) and then
   fails it; this library does not expose that setting.

---

## 🚫 What This Library Does NOT Do

- **NestJS only** — does not work with plain Express, standalone Fastify, or other frameworks.
- **Node.js only** — Deno and Bun are not supported.
- **BullMQ `^6.0` only** — the library targets BullMQ 6 (with `bullmq-otel ^2` for telemetry)
  and does not support BullMQ 5. See the BullMQ version policy in [`CHANGELOG.md`](CHANGELOG.md).
- **No Redis Cluster sharding** — BullMQ's cluster support is not exercised by this library.
- **No built-in DLQ helper** — use the `@OnWorkerEvent('failed')` pattern above.
- **No Prometheus metrics export** — `getMetrics()` returns snapshots; publish them
  via `prom-client` in your own health endpoint.

---

## 🤝 Contributing

Pull requests are welcome. Please open an issue first for significant changes.

- Run the full gate listed in [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.
- Conventional Commits are enforced by `commitlint.config.cjs`.

---

## 🔒 Security Policy

If you discover a security vulnerability, please **do not** open a public issue. Instead, email us
at **support@bymax.one** with details. We take security seriously and will respond promptly. See
[`SECURITY.md`](SECURITY.md) for the full policy.

---

## 📄 License

[MIT](./LICENSE) © [Bymax One](https://github.com/bymaxone)

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://github.com/bymaxone">Bymax One</a></sub>
</p>
