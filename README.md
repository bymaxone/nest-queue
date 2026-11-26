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
- ✅ **Bounded graceful shutdown** — a single ordered sequence drains every worker under one deadline and then stops any that are still busy, whose jobs stall and are retried; delivery is at-least-once by design, so handlers must be idempotent
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

| Subpath               | Import                                | Purpose                                                                      |                                  Dependencies                                  |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------- | :----------------------------------------------------------------------------: |
| **`.`**               | `@bymax-one/nest-queue`               | Full server surface: module, services, decorators, types                     |                           NestJS · BullMQ · ioredis                            |
| **`./shared`**        | `@bymax-one/nest-queue/shared`        | Job-status union, error codes, metric and scheduler types                    |                                      none                                      |
| **`./observability`** | `@bymax-one/nest-queue/observability` | Prometheus metrics, a readiness indicator and OpenTelemetry spans (optional) | the main entry · `@bymax-one/nest-core` · `prom-client` · `@opentelemetry/api` |

```
@bymax-one/nest-queue          (server — NestJS + BullMQ + ioredis)
        │
        └── re-exports ──▶ @bymax-one/nest-queue/shared   (zero dependencies)
```

Every entry point ships ESM **and** CommonJS with declarations for each format, so a
`require()` consumer receives CommonJS declarations rather than ESM ones. The
`pnpm check:exports` gate verifies this against the packed tarball.

### Peer dependency matrix

| Subpath           | Required peers                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.` (server)      | `@nestjs/common ^11.0.16`, `@nestjs/core ^11.1.18`, `bullmq ^6.0`, `ioredis ^6.0`, `reflect-metadata ^0.2`                                                            |
| `./shared`        | None                                                                                                                                                                  |
| `./observability` | The main entry's peers, plus `@bymax-one/nest-core ^1.6.10`, `prom-client ^15` and `@opentelemetry/api ^1.9` (all optional: install them only to import this subpath) |
| Optional          | `bullmq-otel ^2` (OpenTelemetry)                                                                                                                                      |

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

| Option                     | Type                                             | Default                                                                                                                                                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connection`               | `{ client } \| { url, options? } \| { options }` | —                                                                                                                                                          | **Required.** Mode A supplies an existing `ioredis` client; Mode B lets the library open its own. The arms are mutually exclusive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `prefix`                   | `string`                                         | `'bull'`                                                                                                                                                   | Redis key namespace. Applied to the `Queue`, `Worker`, `QueueEvents` **and** `FlowProducer` — see [Architecture](#-architecture).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `defaultJobOptions`        | `JobsOptions`                                    | `attempts: 3` · exponential backoff `2000` ms with 50% jitter · `removeOnComplete: { age: 24 h, count: 1000 }` · `removeOnFail: { age: 7 d, count: 5000 }` | Merged into every job enqueued through the service; per-job options win. Checked at setup: `attempts`, `delay`, `priority`, `backoff` (or its `delay`) and `removeOn*` (a number, or its `age` and `count`) must be whole numbers `>= 0` that a double holds exactly (up to `2 ** 53 - 1`; `priority` up to 2 097 151, BullMQ's own ceiling), and `backoff.jitter` between 0 and 1, or `forRoot` throws `INVALID_OPTIONS` naming the option and what it received (a finite number itself, `null`, or otherwise only a description of its type, never any other value). To keep every job say `false`, not `-1`. The bounded `removeOn*` caps are what keep Redis from growing without limit under a failure storm. |
| `queueOptions`             | `Partial<QueueOptions>`                          | `{}`                                                                                                                                                       | Extra BullMQ `Queue` options. `connection`, `defaultJobOptions` and `prefix` are owned by the library and cannot be set here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `flows.enabled`            | `boolean`                                        | `false`                                                                                                                                                    | `FlowService` is always provided; while disabled, every method except `close()` throws `FLOW_DISABLED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `metrics.enabled`          | `boolean`                                        | `false`                                                                                                                                                    | `MetricsService` is always provided; while disabled, every method throws `METRICS_DISABLED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `metrics.cacheTtlMs`       | `number`                                         | `5_000`                                                                                                                                                    | TTL of the metrics snapshot cache, in milliseconds. `0` disables caching. A whole number `>= 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `telemetry`                | `Telemetry`                                      | —                                                                                                                                                          | A BullMQ `Telemetry` instance (typically `new BullMQOtel(...)` from the optional `bullmq-otel` peer), attached to every `Queue` and `Worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `shutdown.drainTimeoutMs`  | `number`                                         | `30_000`                                                                                                                                                   | Upper bound on the graceful drain before workers are force-closed. A whole number from 1 to 2 147 483 647.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `shutdown.drainOnShutdown` | `boolean`                                        | `false`                                                                                                                                                    | Development and test only: once the HTTP server has stopped, call `drain()` on every cached queue, which **removes** its waiting jobs (delayed and active jobs are left alone). Leave it `false` in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `connectionReadyTimeoutMs` | `number`                                         | `10_000`                                                                                                                                                   | Mode B only: the budget for Redis to reach `ready`, a whole number from 1 to 2 147 483 647. A connection error while the client is still reconnecting does not end the wait; when the budget ends, startup fails with `CONNECTION_TIMEOUT` carrying `timeoutMs` (the error that was last raised is the exception's `cause`, never in the response) and the client the library opened is closed.                                                                                                                                                                                                                                                                                                                    |
| `commandTimeoutMs`         | `number`                                         | `5_000`                                                                                                                                                    | Mode B only: the deadline for one Redis command on the connection the library opened (ioredis `commandTimeout`); an `options.commandTimeout` wins. A call that hits it rejects with `CONNECTION_TIMEOUT` (`details` carries `operation` and `timeoutMs`), as when `enqueueTimeoutMs` passes. Worker and QueueEvents connections have none. A value shorter than the Redis round trip makes every command fail, the readiness check included, so startup then fails with `CONNECTION_TIMEOUT` after `connectionReadyTimeoutMs`.                                                                                                                                                                                     |
| `enqueueTimeoutMs`         | `number`                                         | `10_000`                                                                                                                                                   | The deadline for one `QueueService` or `FlowService` call that reaches Redis, in either mode, including the wait for the client to be ready on a queue's first call; it rejects with `CONNECTION_TIMEOUT`, and an `enqueue` may still complete in Redis, so retry with a stable `jobId` or `deduplication`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isGlobal`                 | `boolean`                                        | `true`                                                                                                                                                     | Register the module globally, so `QueueService` is injectable without re-importing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> [!WARNING]
> **`shutdown.drainOnShutdown` deletes jobs.** When it is `true`, shutdown calls `drain()` on every
> queue this process created, which removes all of that queue's waiting jobs from
> Redis, including the ones other instances were about to process. It exists for development and
> tests that need an empty queue. Never enable it in production.

Invalid options are rejected at bootstrap with `QueueException(INVALID_OPTIONS)` — never
silently corrected. A misconfigured queue fails when the application starts, not when the
first job is enqueued.

An option that holds `undefined` or `null` is treated as not given, in every group (`defaultJobOptions`, `flows`, `metrics`, `shutdown`), and keeps its default: it does not overwrite the default with nothing. The switches are the exception: each must be a boolean or absent, and `null`, a string such as `'false'` (which is what an environment variable holds, and is truthy) or any other value is refused, naming the option and the type and never the value, with `INVALID_OPTIONS` for a switch of the module and `WORKER_REGISTRATION_FAILED` for a worker's `autorun`. A getter, own or inherited from a class, counts as a value, and the options are read once, so the value that was validated is the value that is applied: the connection, the queue options, a worker's options, the schedule of a job scheduler and the jobs of a bulk enqueue are copied when they are read, and what you handed over is not read again. A read that throws (a getter or a Proxy trap of your own) is refused with the library's own code and keeps your error as the `cause`. A key planted on `Object.prototype` is not a value of your options, and neither is a key held only by an ancestor you built with no prototype, which cannot be told from the root; give such a value as an own property or through a class getter.

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

Discovery finds a processor by the `constructor` of each provider instance and registers it only when the class's prototype is in the provider's prototype chain: a `useValue` value without it is ignored, even when its `constructor` property names a `@Processor` class.

Known limit: the same instance reached through several tokens, such as a `useExisting` alias, is one processor. A provider whose factory returns a wrapper object without the `@Processor` class's prototype in its chain is not registered, and nothing is logged, because its `constructor` property alone does not say which class it stands for; provide the class itself, or register the worker with `WorkerRegistry.register()`.

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

A custom `jobId` is stored at `<prefix>:<queue>:<jobId>`, next to the keys BullMQ keeps for the queue itself, so an id that equals one of those names (`active`, `wait`, `failed`, `completed`, `delayed`, `id`, `meta`, `events`, …) would overwrite or collide with it. `enqueue`, `enqueueBulk` and the flow methods refuse such an id with `INVALID_JOB_ID` (400) before BullMQ is called, and `getJob` answers `null` for it. The list comes from BullMQ's own key names, so it follows an upgrade; BullMQ already refuses an id that contains `:` (other than the three-part form) or is a whole number.

When a custom `jobId` already exists, or a `deduplication` rule keeps the job that is already there (a rule with `replace` swaps it for the new one instead), `enqueue`, `enqueueBulk` and the flow methods add nothing: BullMQ answers with the id of the **existing** job together with the data and options of **this** call, so the returned object does not describe what is stored. Call `QueueService.getJob` when you need the stored job.

### A timed-out `enqueue` may still have been added

When Redis does not answer in time, whether within `commandTimeoutMs` on the connection the library opened or within `enqueueTimeoutMs`, or the connection is down, `enqueue` and `enqueueBulk` reject with `CONNECTION_TIMEOUT`, but the library cannot cancel the command: if Redis applies it late, the job exists anyway. Retrying a call that timed out can therefore add the job twice. For anything that must not run twice, pass a deterministic `jobId` (for example one derived from the business key): BullMQ ignores a second add with the same `jobId` for as long as the first job is still stored, so a retry inside that window is safe. A completed job is removed by `removeOnComplete`, and from then on the same `jobId` adds a new job, so keep the retry inside that window or keep the handler idempotent. A `deduplication` rule gives the same guarantee for work that is allowed to repeat after a window.

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

## 🔭 Observability

The main entry imports no metrics or tracing library. What watches the queue is an observer registered on `QueueObserverRegistry`, and the optional `@bymax-one/nest-queue/observability` subpath ships one that feeds Prometheus through `@bymax-one/nest-core`, a readiness indicator, and OpenTelemetry spans. Import its module next to `BymaxQueueModule`:

```typescript
import { Module } from '@nestjs/common'
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import { BymaxQueueObservabilityModule } from '@bymax-one/nest-queue/observability'

@Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
      metrics: { enabled: true },
    }),
    BymaxQueueObservabilityModule,
  ],
})
export class AppModule {}
```

### Metrics

`QueueMetricsContributor` registers them on the registry `@bymax-one/nest-core` serves, when the application enables its metrics endpoint. Labels come from closed sets: the queue name you configured, the outcome and the state. No job id, job name, data or error text is ever a label.

| Metric                             | Type      | Labels             | Meaning                                                                                                                                                                                                                              |
| ---------------------------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bymax_queue_jobs_total`           | counter   | `queue`, `outcome` | Attempts that ended in this process: `completed`, `failed` (the last attempt, or an `UnrecoverableError`) or `retried` (BullMQ runs the job again).                                                                                  |
| `bymax_queue_job_duration_seconds` | histogram | `queue`            | Time the processor ran for one attempt, with the default `prom-client` buckets.                                                                                                                                                      |
| `bymax_queue_depth`                | gauge     | `queue`, `state`   | Jobs in a queue by `waiting`, `active`, `delayed` or `failed`, read from `MetricsService`, so a scrape reads Redis at most once per `metrics.cacheTtlMs`. It has no samples while `metrics.enabled` is off or Redis does not answer. |

Known limit: `bymax_queue_jobs_total` has no `dead_lettered` outcome. A dead-letter queue is a recipe in this README, not something the library knows, so count its jobs from that queue.

- The `failed` outcome does not say whether your listener moved a job to a dead-letter queue.
- BullMQ fails some jobs without running the processor: an unscheduled one that stalled more often than `maxStalledCount` allows, or a flow parent whose child failed with `failParentOnFailure`. The `failed` event fires, so the dead-letter recipe can move them, and the counter does not change. A sandboxed worker's jobs are not counted either.
- With the `metrics` option on, `bymax_queue_depth` has series for the dead-letter queue in a process that has opened it, as the recipe's `enqueue` does. They show its `waiting`, `active`, `delayed` and `failed` counts from the cached snapshot, not how many jobs were ever moved there.

`bymax_queue_depth` has four series per queue. Refreshing its cached snapshot reads Redis for every queue the library has opened, about seven commands per queue (measured with BullMQ 6.3.4 and Redis 7), so 100 queues are 400 series and about 700 commands per refresh. A scrape inside `metrics.cacheTtlMs` costs no read, so with many queues raise `metrics.cacheTtlMs` to spread the reads, or leave `metrics.enabled` off to have no depth samples at all.

A job that a worker hands back to BullMQ with `DelayedError`, `WaitingError`, `WaitingChildrenError` or `RateLimitError` is not counted: it did not fail. A sandboxed worker runs in another process and is not observed.

### Readiness

`QueueHealthIndicator` (named `queue`, also exported as `QUEUE_HEALTH_INDICATOR_NAME`) sends one `PING` on the connection the queue works through and answers `up`, or `down` after two seconds or on any error. It reports the connection mode and never an error text, and it sends and reads no job. `@bymax-one/nest-core` discovers it when its health auto-discovery is on.

### Traces

`QueueTracingObserver` opens the spans. `queue.enqueue` (producer) wraps `enqueue`, `enqueueBulk` and each tree of `FlowService.add` and `addBulk`; `queue.process` (consumer) wraps each attempt of a job. Their attribute is `bymax.queue.name`; a failed span carries the library's error code (or `error`) as its status message and never the text of the error. An attempt the processor hands back to BullMQ with `DelayedError`, `WaitingChildrenError`, `RateLimitError` or `WaitingError` is normal flow, not a failure: its `queue.process` span has no error status and the attribute `bymax.queue.outcome` is `delayed`, `waiting_children`, `rate_limited` or `waiting`. The W3C trace context of `queue.enqueue` is stored with the job in `opts.telemetry.metadata`, apart from its data, and `queue.process` continues it, so a request, the job it enqueued and the work the job does read as one trace. With no OpenTelemetry SDK registered the API does nothing and no header is stored.

A job that already carries metadata keeps it, and `queue.process` continues the trace it holds: BullMQ's telemetry writes the same JSON of W3C headers, so metadata it wrote is a parent like any other. If you set the module's own `telemetry` option (BullMQ's `bullmq-otel`), BullMQ stores its own metadata and the library leaves it alone; the spans above are still opened. Propagation uses the global propagator, so an `OTEL_PROPAGATORS` setting that leaves out `tracecontext` breaks it; that is a host choice the library does not override.

### Log events

Every operational log line is an object handed to the Nest `Logger`, `{ event, message, ...fields }`, with fields of closed or numeric values only, so `@bymax-one/nest-logger` writes them as data and Nest's console logger prints them readably. `message` holds the library's own text only. When an error caused the event, it is carried as the error itself under `err`, where a logger that knows errors serialises and redacts it, and never as text in `message`. A logger you set with `app.useLogger` that throws is absorbed, so it does not end the process or fail the code that was reporting. A promise that your logger returns is not: Nest's `Logger` does not hand it to the library, so the rejection of an asynchronous transport is dropped, becomes an unhandled rejection and ends the process with exit code 1 unless your application handles `unhandledRejection`.

| Code                               | Level | When                                                                                                                                       | Fields                          |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `QUEUE_SHUTDOWN_COMPLETE`          | log   | The module finished closing its workers, queues, flow producer and connection                                                              | `durationMs`, `forcedWorkers`   |
| `QUEUE_WORKER_DRAIN_TIMEOUT`       | warn  | A worker did not drain within the shutdown budget and was stopped                                                                          | `queue`, `drainTimeoutMs`       |
| `QUEUE_WORKER_CLOSE_FAILED`        | warn  | A worker failed to close and was stopped                                                                                                   | `queue`, `err`                  |
| `QUEUE_SANDBOX_SHUTDOWN_UNGUARDED` | warn  | A sandboxed worker was registered on a BullMQ whose `Worker` the library cannot wrap, so a job's outcome after the shutdown is not dropped | `queue`                         |
| `QUEUE_DRAIN_FAILED`               | warn  | A queue could not be drained on shutdown (`drainOnShutdown`)                                                                               | `queue`, `err`                  |
| `QUEUE_OBSERVER_FAILED`            | warn  | An observer threw or rejected from a hook; it is ignored and the job is not affected                                                       | `hook`                          |
| `QUEUE_CLIENT_ERROR`               | error | A Redis connection the module uses emitted an error                                                                                        | `role`, `err`                   |
| `QUEUE_EMITTER_ERROR`              | error | A `Queue`, `Worker`, `QueueEvents` or `FlowProducer` emitted an error                                                                      | `kind`, `queue`, `err`          |
| `QUEUE_EVENT_HANDLER_FAILED`       | error | An `@OnWorkerEvent` or `@OnQueueEvent` handler threw or rejected                                                                           | `decorator`, `eventName`, `err` |
| `QUEUE_CONCURRENCY_DEFAULTED`      | warn  | A `@Processor` that gave no concurrency got the default                                                                                    | `queue`, `concurrency`          |
| `QUEUE_UNBOUNDED_RETRIES`          | warn  | The shared client has `maxRetriesPerRequest: null`, so a command waits for as long as an outage lasts                                      | none                            |
| `QUEUE_GUARD_REFUSED`              | error | The prototype guard refused on a path that cannot throw (a readiness ping, the teardown), so it failed closed: `down`, or a disconnect     | `site`, `err`                   |
| `QUEUE_JOB_DEFERRED_GUARD_REFUSED` | warn  | The prototype guard refused before a job ran, so it went back to the delayed set; at most one line a minute for each worker                | `queue`, `deferred`             |

### Your own observer

```typescript
import { QueueObserverRegistry } from '@bymax-one/nest-queue'
import type { QueueObserver } from '@bymax-one/nest-queue'

export function observe(observers: QueueObserverRegistry): () => void {
  const observer: QueueObserver = {
    jobFinished: ({ queue, outcome, durationSeconds }) => {
      console.log(queue, outcome, durationSeconds)
    },
  }
  return observers.register(observer)
}
```

A hook must not break the job it watches, and the registry holds it to that. A hook that throws, or that returns a promise which rejects (an `async` function is accepted for any hook), is ignored and logged as `QUEUE_OBSERVER_FAILED` with the hook's name, unless it only rethrows the error of the operation; nothing it threw is logged. For `traceEnqueue` and `traceProcess` that means the enqueue or the attempt still runs once, and the error of the enqueue or of the processor reaches the caller as it is whatever the observer does with it, and an operation the observer starts and does not await can never leave an unhandled rejection. Each observer receives its own frozen copy of the `jobFinished` event, so one observer cannot change what the next one hears. A promise returned by `jobFinished` is not awaited.

---

## 🛑 Graceful Shutdown

`QueueLifecycle` runs automatically when NestJS closes the application context, through its `onModuleDestroy` and `onApplicationShutdown` hooks (call `app.enableShutdownHooks()` so that a termination signal closes the context).
It implements a **bounded drain protocol** with at-least-once semantics:

1. All workers are closed **in parallel**, within one budget (`drainTimeoutMs`, default 30 s) that
   covers steps 1 to 4 together: however many workers are stuck, consumption stops after one budget,
   not one per worker.
2. Each worker is paused (it stops fetching and waits for its active jobs) and then closed, or the
   budget runs out — whichever comes first.
3. On timeout, the worker is stopped with `worker.close(true)` as its first close, so it does not
   wait for the job and its lock renewal ends; the lock expires and the job stalls and is retried
   by the next instance. What the abandoned handler produces afterwards, a result or a failure, is
   dropped, so the stopped worker cannot restart its connection. The handler's own promise keeps
   running, because user code cannot be cancelled. The same holds for a sandboxed (file-based)
   worker: what its job produces after the stop is dropped, and the job is left to stall.
4. Queue-events and the connections the library opened for workers and queue-events are closed,
   each within what is left of the budget; a connection that has not quit by then is disconnected.
5. Once NestJS has stopped the HTTP server (`onApplicationShutdown`), the flow producer, the
   cached queues and, in Mode B, the library's own Redis connection are closed; its quit is bounded
   by what is left of the same budget, and never by less than one second, and an unanswered quit
   is followed by a disconnect. The library's own connection, and the worker and queue-events
   connections duplicated from it, are created with ioredis's `disconnectTimeout` at 1 ms (an
   explicit value in `connection.options` wins), so that disconnecting a client that is
   reconnecting does not hold the process for ioredis's default 2 s. A client you pass in Mode A
   keeps its own `disconnectTimeout`, and so do the connections duplicated from it: set it on that
   client if you want the same exit time. NestJS runs
   `onModuleDestroy` before it stops the HTTP server, so a request that is still being served can
   enqueue a job after step 4; those resources stay open until the server is down.

**Sandboxed jobs still running at the deadline.** The library does not kill the child process or
the worker thread; that is left to BullMQ, and what BullMQ does with a worker thread changed in
6.6.1. Measured on BullMQ 6.0.0, 6.3.4, 6.6.0, 6.6.1 and 6.7.10, with the processor file already
loaded:

- A child process, on every measured version, was sent a stop signal and allowed to finish its job:
  the host process exited when the child did, or when BullMQ killed the child about 30 s after the
  drain budget ran out, whichever came first. `drainTimeoutMs` does not bound that wait, so give
  the process manager's kill timeout room for it.
- A worker thread (`useWorkerThreads: true`) on 6.6.1 and 6.7.10 was treated the same way: it was
  allowed to finish its job, and was terminated about 30 s after the drain budget ran out if it had
  not. Give the process manager's kill timeout the same room.
- A worker thread on 6.0.0, 6.3.4 and 6.6.0, before that change, was terminated when the drain
  budget ran out, and the host exited.

Known limit: until the child process, or from BullMQ 6.6.1 the worker thread, ends, its job's code
keeps running, side effects included, although its outcome is dropped.

Known limit: a host process that is itself killed with `SIGKILL` leaves its forked child running;
in a measured run the child finished its job after the host was gone.

Known limit: once the stopped worker no longer renews the lock, a `lockDuration` shorter than what
is left of the job lets another instance start the same job while the old child process, or from
BullMQ 6.6.1 the old worker thread, still runs it; measured with a 3 s lock.

Known limit: a sandboxed processor still loading its file when the drain budget ends runs the job
once loaded and keeps the host process alive, because BullMQ does not signal that child or thread.
Use a drain budget longer than the processor takes to load, and keep the process manager's own stop
timeout.

**Handlers must be idempotent.** Use `jobId`, `deduplication`, or application-level
idempotency keys to guard against reprocessing a job that was partially handled before
a crash or a shutdown that outlasts the drain budget.

**DLQ pattern.** When BullMQ has given up on a job, move it to a dead-letter queue. The `failed` event also fires
for an attempt that BullMQ will retry, so the listener asks what BullMQ did with the job: a retried job is
`delayed`, `waiting` or `active` again, and a job it gave up on is `failed`, or already gone when `removeOnFail`
removed it, which `getState()` reports as `unknown`. Comparing `attemptsMade` with `attempts` misses an
`UnrecoverableError`, which ends a job before its attempts are used, and testing `instanceof UnrecoverableError`
misses an error BullMQ recognizes by its name alone. The id uses a hyphen because BullMQ refuses a custom job id that contains a
colon. A job whose keys are removed from Redis while it runs never reaches this listener: BullMQ reports an error
on the worker and emits no `failed` event.

```typescript
import { Inject, Injectable } from '@nestjs/common'
import { OnWorkerEvent, Process, Processor, QueueService } from '@bymax-one/nest-queue'
import type { Job } from 'bullmq'

@Injectable()
@Processor('orders')
export class OrdersProcessor {
  constructor(@Inject(QueueService) private readonly queue: QueueService) {}

  @Process()
  async handle(job: Job<{ orderId: string }>): Promise<void> {
    await this.fulfil(job.data.orderId)
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (!job) return
    // `failed` also fires for an attempt that will be retried. BullMQ has given up on the job when it is
    // `failed`, or already removed (`unknown`, with `removeOnFail`).
    const state = await job.getState()
    if (state === 'failed' || state === 'unknown') {
      // The dead-letter job keeps the original data and why the job failed, since a failed job that
      // `removeOnFail` removed leaves nothing else to ask.
      await this.queue.enqueue(
        `${job.queueName}-dlq`,
        job.name,
        { original: job.data, failedReason: job.failedReason },
        {
          // BullMQ refuses a custom job id that contains a colon.
          jobId: `dlq-${job.id}`,
        },
      )
    }
  }

  private async fulfil(orderId: string): Promise<void> {
    // Your work. A throw is a failed attempt, retried under the job's `attempts`.
    if (orderId === '') throw new Error('no order')
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

| Concern       | `@nestjs/bullmq` (official)                          | `@bymax-one/nest-queue`                                                                  |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Module setup  | `BullModule.forRoot()` + `registerQueue()` per queue | Single `forRoot`/`forRootAsync`; queues created on demand by name                        |
| Connection    | Manual ioredis + `maxRetriesPerRequest` wiring       | Dual mode (BYO / lib-owned); correct per-role retry policy applied automatically         |
| Job defaults  | Per `registerQueue`                                  | Centralized opinionated defaults with per-queue/per-job overrides                        |
| Producer API  | `@InjectQueue` + raw `queue.add`                     | Typed `enqueue<TData, TResult>()`, `enqueueBulk`, `upsertJobScheduler`                   |
| Shutdown      | Framework closes workers                             | Explicit bounded-drain protocol; stops a busy worker at the deadline; stalled accounting |
| Observability | Manual                                               | `telemetry` passthrough (OpenTelemetry) + `MetricsService`                               |

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
                     (bounded drain → stop → disconnect)
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
values — a reason, a limit, a queue or scheduler name, a status, and for a flow bulk
arrays of integer indexes into the batch — never a connection object and never `job.data`.

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

### Reading more than 1 000 jobs

`getJobs` reads at most 1 000 jobs per call, and refuses BullMQ's `-1` ("everything") with `INVALID_OPTIONS`, because that reads a status list of any size into memory in one reply. Page through it instead:

```typescript
import type { QueueService } from '@bymax-one/nest-queue'

async function inspectFailed(
  queueService: QueueService,
  inspect: (job: unknown) => Promise<void>,
): Promise<void> {
  const PAGE = 500
  for (let start = 0; ; start += PAGE) {
    const page = await queueService.getJobs('reports', 'failed', start, start + PAGE - 1)
    for (const job of page) await inspect(job)
    if (page.length < PAGE) break
  }
}
```

### A polluted `Object.prototype` is refused

BullMQ and ioredis build ordinary objects of their own and read names off them that the library never set, so a key planted on `Object.prototype` (prototype pollution in another dependency, or a `JSON.parse` of untrusted input merged unsafely) can be read as an option: a planted `path` or `tls` redirects or reconfigures the Redis connection. Two things cover two moments. **Before a client is built or connects**, the library refuses as a whole: while `Object.prototype` of the process holds a string key beyond the standard ones, or a standard method that was replaced, or while a built-in the options and job paths call (`Object`, `Reflect`, `Array`, `Number`, `String`, `Function`, `Symbol`, `JSON`, `Set`, `Map`, `RegExp`, `WeakMap`, `WeakSet`, `Boolean`, `BigInt`, their prototypes, the prototypes of the Array, Set, Map and String iterators and the iterator prototype above them, and the globals that name them; `Promise` and `Date` are left out, and a test suite that spies on or replaces one of the others, such as `JSON.stringify` (BullMQ serialises the options of a job with it), makes the library refuse until the spy is restored), or while a symbol key, enumerable or not, sits on `Object.prototype` (a planted `Symbol.iterator` changes how objects are iterated; the one exception is the registry symbol Jest puts there, while it is non-enumerable), is not what it was when the library loaded, it throws `INVALID_OPTIONS` with `details: { reason, count }` (the number of keys and replaced built-ins, never a name or a value). The check runs when the module boots, before every `enqueue`, `enqueueBulk`, `upsertJobScheduler` and flow `add` or `addBulk`, before every job an in-process worker runs and again when its handler settles (a sandboxed worker, which BullMQ runs from a file in a child process or thread, is not covered per job), in the turn that makes each `QueueService` Redis call and each flow `add`, after the observers' hooks (a job refused before its handler runs is not failed: it goes back to the delayed set for five seconds and runs once the prototype is clean, because BullMQ's failure path would read a planted `removeOnFail` and delete it; the options of the worker, a sandboxed worker's included, carry an own `undefined` for every name BullMQ reads while it finishes a job, and so do the options of each job an in-process worker runs, so a key planted while an in-process handler runs cannot delete a job either, and an in-process handler that settles under a polluted prototype fails the attempt instead of completing it; the jobs of a sandboxed worker get no per-job guard, no job-option shadow and no settle guard, and the `Object.prototype` of its child process or thread is never checked; if the move of a refused job itself fails, the attempt fails as any other), and, for a connection the library opens itself (Mode B), in the tick that opens each socket, on the first connect and on every reconnect, including the connections BullMQ duplicates for workers and queue events. A refused reconnect ends that client instead of connecting, and the library's connector is the one a client it opens uses (a Sentinel client builds its own, which is wrapped as described below), whatever `Connector` the options name. With Sentinel, the client and each duplicate of it are built lazy and their connector is checked before each connect and again once it resolves, destroying a socket opened under a polluted `Object.prototype`, and each client the connector opens to ask a sentinel for the master is built with the guarded connector and the own keys, so a key planted while that question is open does not send the sentinel password to the planted address. **After a client is built**, the options of a client the library opens carry an own `undefined` for every option name ioredis reads, so a key planted later is not read as that option, and the listener table of each socket the library opens is cut from `Object.prototype`. The shadow does not help for a key planted before the client is built: ioredis copies an enumerable planted key into any option that holds `undefined`, which is what the refusal above is for. Limits: of `Reflect` only the functions the language defines (`apply`, `construct`, `defineProperty`, `deleteProperty`, `get`, `getOwnPropertyDescriptor`, `getPrototypeOf`, `has`, `isExtensible`, `ownKeys`, `preventExtensions`, `set`, `setPrototypeOf`) and its `Symbol.toStringTag` are compared, so a copy of `reflect-metadata` that defines its own functions on `Reflect` after the library loaded is not a refusal; a client you pass in (Mode A) was built by you, so it carries no shadow and its own reconnects are not checked, only the calls above are; with Sentinel, a key planted while the sentinels are being asked can reach the one socket ioredis opens to the master at that moment, which is destroyed afterwards but may already have connected; a name added to a built-in prototype after the library loaded is not counted, only a replaced or removed one, and the prototype of `Buffer` is not covered; the refusal repeats on every call for as long as the state differs from what it was when the library loaded, and a key deleted or a built-in put back passes again, so fix the code that did it and restart the process rather than patch the state at run time; an in-process handler that settles under a polluted prototype fails the attempt after its side effects ran, so with `attempts` above 1 it runs again and must be idempotent, as every handler must be; a key planted after the last check is still read by the objects BullMQ builds afterwards; and a script that impersonates the engine before the library is imported is out of reach. Known limit: `QUEUE_JOB_DEFERRED_GUARD_REFUSED` is written at the first deferral of each window of a minute, and the count of a burst no later deferral follows is not written.

### The guards are best-effort, not a boundary against same-process code

Code that runs in your process is trusted, as in Node itself. The prototype and `Promise` guards catch pollution that arrives through a dependency and accidents; they do not stop code written to defeat them, for example one that replaces the `Promise[Symbol.species]` of a native promise or reproduces the intrinsic constructor's prototype and native source text. See the threat model in [`SECURITY.md`](SECURITY.md) and the known limits in the [CHANGELOG](CHANGELOG.md).

### Queue names are keys, not user input

Every queue name used with `QueueService` keeps a `Queue` object and its Redis resources for the life of the process, and names are never evicted. A name built from request data (a tenant id, a URL segment) lets whoever controls it grow memory without limit and create keys in your Redis. Take queue names from a fixed set in code or validate them against an allowlist before use.

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
- [ ] Redis runs with `maxmemory-policy noeviction`: under any other policy Redis can evict queue keys,
      and BullMQ prints `IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"` (with the
      policy your server has) when it connects. With `noeviction`, a Redis that has reached `maxmemory`
      refuses writes, and the library reports `STORAGE_FULL` (503) from `enqueue`, `enqueueBulk`,
      `upsertJobScheduler` and the flow methods, while reads keep answering. Alert on that code, and
      size `maxmemory` for the queue's backlog plus the retained completed and failed jobs.
- [ ] Persistence is chosen on purpose. Redis's default image saves an RDB snapshot at its save points
      (`save 3600 1 300 100 60 10000`): a clean restart keeps the queue, because the server saves on
      SIGTERM, but a crash or kill loses every job written since the last snapshot (measured: a key
      written after the last save was gone after `kill -9`). Only AOF (`appendonly yes`) keeps them
      across both; with the default `appendfsync everysec` the last second of writes can still be lost.

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
| `getJobs`            | `<TData, TResult>(queue, status, start?, end?) → Promise<Job<TData, TResult>[]>`             | Page jobs in one status (default `0`–`50`, at most 1 000 per call; `-1` is refused)        |
| `getMetrics`         | `(queue) → Promise<QueueMetrics>`                                                            | Uncached snapshot of job counts per status, with a collection timestamp                    |
| `pauseQueue`         | `(queue) → Promise<void>`                                                                    | Pause a queue                                                                              |
| `resumeQueue`        | `(queue) → Promise<void>`                                                                    | Resume a paused queue                                                                      |
| `cleanQueue`         | `(queue, gracePeriodMs, limit, status?) → Promise<string[]>`                                 | Remove up to `limit` jobs older than `gracePeriodMs` (`0` = no limit); returns removed ids |
| `upsertJobScheduler` | `<TData, TResult>(queue, id, repeat, template?) → Promise<Job<TData, TResult> \| undefined>` | Create or update a recurring Job Scheduler; returns the first scheduled job                |
| `removeJobScheduler` | `(queue, id) → Promise<boolean>`                                                             | Remove a Job Scheduler by ID                                                               |
| `getJobSchedulers`   | `(queue, start?, end?, asc?) → Promise<JobSchedulerJson[]>`                                  | Page the schedulers registered on a queue (at most 1 000 per call)                         |
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

`FlowService.add` and `addBulk` are held to `enqueueTimeoutMs` like every `QueueService` call and reject with `CONNECTION_TIMEOUT` when Redis does not answer in time. A flow that timed out may still have been added, so use a custom `jobId` when you retry.

`FlowService.addBulk` adds one tree per BullMQ call, with a bounded number in flight, instead of BullMQ's own bulk call: that call skips a tree whose result is an error, so when Redis refused a bulk (out of memory, for example) it resolved with ids of jobs that were never stored. After the first failure no further tree is started, and the call rejects with `details: { operation, landed, failed, notStarted, unknown }`, each an array of indexes into `flows`. `landed` was stored. `failed` was rejected (Redis refused it, or the connection was down), and may have left child jobs behind: when Redis refused the parent's key (a `WRONGTYPE` reply) its child was still added and **was processed without its parent**. `notStarted` was never handed to BullMQ and is safe to resend. `unknown` was in flight when `enqueueTimeoutMs` passed, or its command timed out, and may still land; resend it only with a stable `jobId`. The code is `STORAGE_FULL` when Redis was out of memory, `CONNECTION_TIMEOUT` for a timeout or a down connection, otherwise `BULK_ENQUEUE_FAILED` (500). A bulk is not atomic: the trees that landed stay stored, so a host that retries the whole call creates duplicates unless it uses stable `jobId`s; retry only `notStarted` and `failed`. `enqueueBulk` is not atomic either: when it rejects, for example with `STORAGE_FULL`, some of its jobs may already be stored, so retry it with stable `jobId`s. The options of every node (the root and each descendant, in a bulk or in `add`) are checked before the first tree is sent, and a bad one refuses the whole call with `INVALID_OPTIONS` and stores nothing, because BullMQ's own producer resolves with the node of a child it could not store. A tree that is not well formed is refused the same way: a `null` tree or child, `children` that is not an array, or a node that is its own ancestor. The options are read once and the checked copy is what is sent. A polluted `Object.prototype` that is found after the call started, just before one of its trees is sent, does not arrive as `INVALID_OPTIONS` either: the trees already sent stay stored, and the call rejects with `BULK_ENQUEUE_FAILED` and the `details` above, with the tree that met it in `failed` although it was never handed to BullMQ.

### Other exports

| Export                                                                                                                                          | What it is                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerRegistry.unregister(queue)`, `list()`                                                                                                    | Stop and remove a worker and its connection; list the queue names that have a worker                                                                                                                      |
| `FlowService.addBulk(flows)`, `getProducer()`, `close()`                                                                                        | Add up to 1 000 flows at once; the underlying BullMQ `FlowProducer`; close it (a no-op while flows are disabled)                                                                                          |
| `MetricsService.invalidate(queue?)`                                                                                                             | Drop the cached snapshot of one queue, or of all of them                                                                                                                                                  |
| `QueueEventsRegistry`                                                                                                                           | The shared `QueueEvents` per queue (`getOrCreate`, `list`), used by `@OnQueueEvent`                                                                                                                       |
| `QueueObserverRegistry`, `QueueObserver`, `JobFinishedEvent`, `JobOutcome`, `QueueObserveInfo`, `TraceCarrier`                                  | Where an observer registers, and the hooks, events and types it works with (see Observability)                                                                                                            |
| `ConnectionResolver.getMode()`, `isOwned()`, `awaitReady()`                                                                                     | The connection mode, whether the library owns the client and closes it, and a wait until the client can take a command (shared by every caller, so a health check that polls adds no listener per call)   |
| `ConnectionResolver.init()`, `teardown()`, `QueueService.closeAll()`, `WorkerRegistry.getConnections()`, `QueueEventsRegistry.getConnections()` | Called by the module's own shutdown sequence to open and close what the library created; a host does not call them (a hook with a lifecycle name would run on Nest's schedule, against the bounded drain) |
| `QueueMetricsContributor.registerMetrics()`, `QueueTracingObserver.onModuleInit()`                                                              | Called by `@bymax-one/nest-core` and by Nest when the observability module is imported; a host does not call them                                                                                         |
| `BYMAX_QUEUE_OPTIONS`, `BYMAX_QUEUE_RESOLVED_OPTIONS`                                                                                           | Injection tokens for the options as given and with the defaults applied                                                                                                                                   |
| `BYMAX_QUEUE_REDIS_CLIENT`, `BYMAX_QUEUE_CONNECTION_MODE`                                                                                       | Injection tokens for the Queue-role ioredis client and for `'mode-a-byo'` or `'mode-b-owned'`                                                                                                             |
| `DEFAULT_WORKER_CONCURRENCY`, `MAX_WORKER_CONCURRENCY`                                                                                          | The worker concurrency used when none is given, and its ceiling                                                                                                                                           |
| `DEFAULT_JOB_OPTIONS`, `DEFAULT_METRICS_CACHE_TTL_MS`, `DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS`                                                      | The defaults of the Configuration table                                                                                                                                                                   |
| `QUEUE_ERROR_MESSAGES`                                                                                                                          | The default message of each error code                                                                                                                                                                    |
| `BymaxQueueModuleOptions`, `BymaxQueueModuleAsyncOptions`, `BymaxQueueOptionsFactory`, `QueueConnectionConfig`, `QueueConnectionMode`           | The option and connection types behind `forRoot` and `forRootAsync`                                                                                                                                       |
| `ProcessorMetadata`, `ProcessHandlerMetadata`, `QueueEventListenerMetadata`                                                                     | The reflection metadata the decorators write                                                                                                                                                              |
| `JobStatus`, `JOB_STATUS`, `BulkJob`, `SandboxedJob`, `WorkerEventName`, `QueueEventName`, `WorkerOptions`                                      | Constants and types for the APIs above                                                                                                                                                                    |

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

The HTTP status follows the cause at the throw site: **503** when Redis or an opt-in feature is unavailable and a retry may help, **400** when a value an application passes per call is wrong, **500** for a wiring or configuration fault in the host (module options, worker options, the connection itself). A code can carry more than one status when its causes differ; the table lists each.

| Code                                     |   HTTP    | When thrown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | :-------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue.invalid_options`                  | 500 · 400 | **500:** module options failed bootstrap validation — missing `connection`, mutually exclusive connection arms, a `shutdown.drainTimeoutMs`, `connectionReadyTimeoutMs`, `commandTimeoutMs` or `enqueueTimeoutMs` that is not a whole number from 1 to 2 147 483 647, or a `metrics.cacheTtlMs` that is not a whole number `>= 0`. **400:** a `getJobs` or `getJobSchedulers` window that is not a bounded range of integers, or a per-job option BullMQ would drop or fail on (`attempts`, `delay`, `priority`, `backoff`, `removeOnComplete`, `removeOnFail`) on any node of a flow or in `enqueue` and `enqueueBulk`, the reason naming the option and the node                                                                                               |
| `queue.invalid_job_id`                   |    400    | A custom `jobId` that is one of the queue's own Redis key names (`active`, `wait`, `failed`, …), refused by `enqueue`, `enqueueBulk`, `FlowService.add` and `FlowService.addBulk` before BullMQ is called; or a `parent.id` that is one; the details are `{ field: 'jobId' }` or `{ field: 'parent.id' }` and never carry the value, which often comes from request data                                                                                                                                                                                                                                                                                                                                                                                         |
| `queue.storage_full`                     |    503    | Redis refused a write because used memory is above `maxmemory` under `noeviction` (`OOM command not allowed`): `enqueue`, `enqueueBulk`, `upsertJobScheduler`, the flow methods and every other call that writes. The details are `{ operation, reason: 'out_of_memory' }`, never Redis's text; retry later, after an operator frees memory or the queue drains                                                                                                                                                                                                                                                                                                                                                                                                  |
| `queue.connection_invalid`               |    500    | The resolver has no usable client: not yet initialized, Mode A's injected client is in an unusable `status`, or a Mode B client was refused by the server (`WRONGPASS`, `NOAUTH`) or stopped reconnecting during startup without an error that says Redis was unreachable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `queue.connection_requires_null_retries` |    500    | A consumer connection could not be coerced to `maxRetriesPerRequest: null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `queue.connection_timeout`               |    503    | Mode B: Redis did not reach `ready` within `connectionReadyTimeoutMs` (`details` carries `timeoutMs`; the last error is the exception's `cause`), or the client ended before it was ready because Redis could not be reached (a network error such as `ECONNREFUSED`, or the command timeout of the ready check; `details` carries `operation: 'connect'` and `reason: 'unavailable'`, and the error is the exception's `cause`), or a `QueueService`/`FlowService` call got no answer from Redis: it timed out (`commandTimeoutMs` on the owned connection, or `enqueueTimeoutMs`; `details` carries `operation` and `timeoutMs`) or the owned connection is down (`details` carries `operation` and `reason: 'offline'`); an enqueue may still have been added |
| `queue.invalid_repeat_options`           |    400    | A Job Scheduler schedule was rejected — invalid cron pattern, or neither `pattern` nor `every`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `queue.duplicate_processor`              |    500    | Two `@Processor` classes claim the same queue name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `queue.flow_disabled`                    |    503    | `FlowService` used without `flows.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `queue.metrics_disabled`                 |    503    | `MetricsService` used without `metrics.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `queue.bulk_enqueue_failed`              | 400 · 500 | **400:** `enqueueBulk` or `FlowService.addBulk` exceeded the 1 000 cap. **500:** the underlying `addBulk` failed, or a tree of `FlowService.addBulk` failed for a reason other than a timeout or a full Redis (its details then carry `landed`, `failed`, `notStarted` and `unknown`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `queue.worker_registration_failed`       |    500    | A worker could not be constructed, started, or closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Reserved codes

These are part of the published catalog and stable, but nothing currently throws them.
They are listed so a consumer writing an exhaustive `switch` over `QueueErrorCode`
compiles today and keeps compiling when a future release starts emitting them.

| Code                              | Why it is not thrown today                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `queue.queue_not_found`           | Queues are created on demand by name, so a lookup never misses                |
| `queue.job_not_found`             | `getJob` resolves to `null` rather than throwing                              |
| `queue.invalid_job_data`          | Payloads are opaque; the library does not validate them                       |
| `queue.shutdown_timeout_exceeded` | Exceeding the drain deadline stops the workers still busy rather than raising |

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
every `QueueService` call is bounded by `enqueueTimeoutMs` whatever the client does.

### A handler never settles (the queue stops moving)

A handler whose promise never settles holds its concurrency slot for as long as the process lives, and BullMQ keeps renewing its lock, so the stalled-job check never reclaims it: with every slot held, the rest of the queue waits. Set `jobTimeoutMs` in the worker `options` to bound it. When the time passes, the job fails with a `queue.job_timeout` error and retries under its `attempts` and `backoff`, and the slot is free again. The handler receives the job's `AbortSignal` as its second argument; it aborts at that moment, or when BullMQ cancels the job (`worker.cancelJob()`, `worker.cancelAllJobs()`), and closing the worker does not abort it; pass it to whatever the handler awaits so the work stops with the job. A handler that ignores the signal keeps running in the background, and its retry can overlap it, so it must stay idempotent. There is no default, and sandboxed workers do not accept the option. Once `jobTimeoutMs` has fired, `concurrency` no longer bounds how many handlers are alive: the slot is free for the next job while the timed-out handler may still be running, so a handler that ignores the signal can overlap its successors.

```typescript
@Processor('reports', { jobTimeoutMs: 60_000 })
export class ReportsProcessor {
  @Process()
  async build(job: Job, signal?: AbortSignal): Promise<void> {
    await fetch('https://reports.internal/build', { method: 'POST', signal: signal ?? null })
  }
}
```

### Jobs get stuck (not processed after restart)

Stalled jobs are re-queued automatically by BullMQ's stalled-job check. If workers
do not pick them up:

1. Verify `drainTimeoutMs` is larger than the worst-case job runtime.
2. Verify `lockDuration` (in the `options` you pass to `@Processor` or `register`; a whole
   number from 1000 to 2 147 483 647, as is `stalledInterval`; `concurrency` and the
   limiter values must be whole numbers too) covers
   the handler execution time — a worker that runs longer than `lockDuration` will have its
   lock stolen, marking the job as stalled.
3. BullMQ re-queues a stalled job up to `maxStalledCount` times (a worker option; default `1`)
   and then fails it; with `0` the first stall fails it. A job of a job scheduler is not failed by
   this limit. The value must be a whole number, `0` or more. A stalled re-run does not count
   against the job's `attempts`.

---

## 🚫 What This Library Does NOT Do

- **NestJS only** — does not work with plain Express, standalone Fastify, or other frameworks.
- **Node.js only** — Deno and Bun are not supported.
- **BullMQ `^6.0` only** — the library targets BullMQ 6 (with `bullmq-otel ^2` for telemetry)
  and does not support BullMQ 5. See the BullMQ version policy in [`CHANGELOG.md`](CHANGELOG.md).
- **No Redis Cluster sharding** — BullMQ's cluster support is not exercised by this library.
- **No built-in DLQ helper** — use the `@OnWorkerEvent('failed')` pattern above.
- **Prometheus metrics are opt-in** — the main entry exports none; `getMetrics()` returns
  snapshots, and the optional `@bymax-one/nest-queue/observability` subpath registers the
  metrics on the registry `@bymax-one/nest-core` serves (see Observability).

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
