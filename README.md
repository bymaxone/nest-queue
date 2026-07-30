<p align="center">
  <img src="https://img.shields.io/badge/%40bymax--one-nest--queue-000000?style=for-the-badge&logo=nestjs&logoColor=E0234E" alt="@bymax-one/nest-queue" />
</p>

<h1 align="center">@bymax-one/nest-queue</h1>

<p align="center">
  <strong>Typed BullMQ queues for NestJS</strong><br />
  <sub>BullMQ 5 · Workers · Flows · Job Schedulers · Deduplication · OpenTelemetry · Graceful Shutdown · Zero Runtime Dependencies</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bymax-one/nest-queue"><img src="https://img.shields.io/npm/v/@bymax-one/nest-queue?style=flat-square&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@bymax-one/nest-queue"><img src="https://img.shields.io/npm/dm/@bymax-one/nest-queue?style=flat-square&colorA=000000&colorB=000000" alt="npm downloads" /></a>
  <a href="https://github.com/bymaxone/nest-queue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bymaxone/nest-queue/ci.yml?branch=main&style=flat-square&colorA=000000&label=CI" alt="CI status" /></a>
  <a href="https://github.com/bymaxone/nest-queue/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&colorA=000000" alt="coverage" /></a>
  <a href="https://github.com/bymaxone/nest-queue/blob/main/docs/mutation_testing_results.md"><img src="https://img.shields.io/badge/mutation-98.99%25-brightgreen?style=flat-square&colorA=000000" alt="mutation score" /></a>
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
  <a href="https://github.com/bymaxone/nest-queue/tree/main/examples/nest-queue-example">Example App</a>
</p>

---

## ✨ Overview

`@bymax-one/nest-queue` is a NestJS dynamic module that wraps **BullMQ 5** behind a typed,
opinionated surface. Instead of wiring `ioredis` connections, per-queue registration, and
`maxRetriesPerRequest` policy by hand, you install one library and get typed producers,
decorator-based workers, flows, recurring **Job Schedulers**, native deduplication,
OpenTelemetry passthrough, and a tested bounded graceful-shutdown protocol.

The library has **zero direct dependencies** — `bullmq`, `ioredis`, and `@nestjs/*` arrive as
peer dependencies, so you control exact versions and the supply-chain surface stays minimal.

### Why nest-queue?

- **One setup, every queue.** A single `forRoot`/`forRootAsync`; queues are created on demand by
  name — no `registerQueue()` per queue.
- **Correct connections by default.** Dual-mode (bring-your-own client or lib-owned) with the
  per-role `maxRetriesPerRequest` policy applied automatically — the Queue connection keeps
  default retries (fail fast), only the duplicated Worker/QueueEvents connections force `null`.
- **Current BullMQ API only.** Recurring jobs use Job Schedulers (`upsertJobScheduler`), never the
  removed `addRepeatable`. Cron is validated by BullMQ's own parser, never a hand-rolled regex.
- **Safe shutdown.** A bounded-drain protocol with at-least-once semantics, force-close, and
  stalled-job accounting — verified against a real Redis (Testcontainers) E2E suite.

---

## 🔥 Features

- **Typed producer API** — `enqueue<TData, TResult>()`, `enqueueBulk` (bounded), `getJob`,
  `getJobs`, `getMetrics`, `pauseQueue`/`resumeQueue`/`cleanQueue`.
- **Decorator workers** — `@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`, discovered
  automatically from your providers; plus a programmatic `WorkerRegistry` and file-based sandboxed
  processors.
- **Flows** — opt-in `FlowService` over BullMQ `FlowProducer` with correct fail-parent semantics.
- **Job Schedulers** — cron (incl. 6-field seconds) and interval recurrence via `upsertJobScheduler`.
- **Deduplication** — native BullMQ simple/throttle/debounce modes, passed straight through.
- **OpenTelemetry** — optional `bullmq-otel` telemetry passthrough across enqueue → handler.
- **Metrics** — opt-in `MetricsService` with a configurable TTL cache.
- **Graceful shutdown** — bounded drain → force-close, wired via NestJS `onApplicationShutdown`.
- **Dual subpath exports** — `.` (server) and `./shared` (zero-dependency types/constants).

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

| Subpath      | Required peers                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `.` (server) | `@nestjs/common ^11`, `@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata ^0.2` |
| `./shared`   | None                                                                                            |
| Optional     | `bullmq-otel ^1` (OpenTelemetry)                                                                |

---

> [!TIP]
> A runnable reference application lives in
> [`examples/nest-queue-example`](https://github.com/bymaxone/nest-queue/tree/main/examples/nest-queue-example) —
> a NestJS app that consumes this library and exercises producers, decorated
> processors, and a health endpoint against a real Redis.

---

## 🚀 Quick Start

```bash
pnpm add @bymax-one/nest-queue bullmq ioredis
```

Wire the module in your root `AppModule`:

```typescript
import { Module } from '@nestjs/common'
import { BymaxQueueModule } from '@bymax-one/nest-queue'

@Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: process.env.REDIS_URL },
      isGlobal: true,
    }),
  ],
})
export class AppModule {}
```

Enqueue a job from any service:

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

Process jobs with a decorated handler:

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

Register the processor in your module alongside `BymaxQueueModule`:

```typescript
@Module({
  providers: [EmailProcessor],
})
export class EmailModule {}
```

---

## ⚙️ Configuration

Every option passed to `forRoot` / `forRootAsync`. Only `connection` is required.

| Option                     | Type                                             | Default                                                                                                                                    | Description                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`               | `{ client } \| { url, options? } \| { options }` | —                                                                                                                                          | **Required.** Mode A supplies an existing `ioredis` client; Mode B lets the library open its own. The three arms are mutually exclusive.                                    |
| `prefix`                   | `string`                                         | `'bull'`                                                                                                                                   | Redis key namespace. Applied to the `Queue`, `Worker`, `QueueEvents` **and** `FlowProducer` — see [Architecture](#-architecture).                                           |
| `defaultJobOptions`        | `JobsOptions`                                    | `attempts: 3` · exponential backoff `2000` ms · `removeOnComplete: { age: 24 h, count: 1000 }` · `removeOnFail: { age: 7 d, count: 5000 }` | Merged into every job enqueued through the service; per-job options win. The bounded `removeOn*` caps are what keep Redis from growing without limit under a failure storm. |
| `queueOptions`             | `Partial<QueueOptions>`                          | `{}`                                                                                                                                       | Extra BullMQ `Queue` options. `connection`, `defaultJobOptions` and `prefix` are owned by the library and cannot be set here.                                               |
| `flows.enabled`            | `boolean`                                        | `false`                                                                                                                                    | Registers `FlowService`. Injecting it while disabled throws `FLOW_DISABLED`.                                                                                                |
| `metrics.enabled`          | `boolean`                                        | `false`                                                                                                                                    | Registers `MetricsService`. Injecting it while disabled throws `METRICS_DISABLED`.                                                                                          |
| `metrics.cacheTtlMs`       | `number`                                         | `5_000`                                                                                                                                    | TTL of the metrics snapshot cache. `0` disables caching. Must be `>= 0`.                                                                                                    |
| `telemetry`                | `Telemetry`                                      | —                                                                                                                                          | A BullMQ `Telemetry` instance (typically `new BullMQOtel(...)` from the optional `bullmq-otel` peer), attached to every `Queue` and `Worker`.                               |
| `shutdown.drainTimeoutMs`  | `number`                                         | `30_000`                                                                                                                                   | Upper bound on the graceful drain before workers are force-closed. Must be `> 0`.                                                                                           |
| `shutdown.drainOnShutdown` | `boolean`                                        | `false`                                                                                                                                    | Wait for the queue to drain, not just for in-flight jobs to finish.                                                                                                         |
| `connectionReadyTimeoutMs` | `number`                                         | `10_000`                                                                                                                                   | Mode B only: how long to wait for Redis `ready` before failing with `CONNECTION_TIMEOUT`.                                                                                   |
| `isGlobal`                 | `boolean`                                        | `true`                                                                                                                                     | Register the module globally, so `QueueService` is injectable without re-importing.                                                                                         |

Invalid options are rejected at bootstrap with `QueueException(INVALID_OPTIONS)` — never
silently corrected. A misconfigured queue fails when the application starts, not when the
first job is enqueued.

---

## 🔌 Mode A — Bring Your Own Connection (recommended with `@bymax-one/nest-cache`)

Mode A accepts an existing `ioredis` client injected from your cache or connection layer.
Worker and QueueEvents connections are duplicated from this client with
`maxRetriesPerRequest: null` applied automatically; the Queue connection uses ioredis defaults.

```typescript
import { BymaxQueueModule } from '@bymax-one/nest-queue'
import { CACHE_REDIS_CLIENT } from '@bymax-one/nest-cache'
import type { Redis } from 'ioredis'

BymaxQueueModule.forRootAsync({
  inject: [CACHE_REDIS_CLIENT],
  useFactory: (queueRedis: Redis) => ({
    connection: { client: queueRedis },
    isGlobal: true,
  }),
})
```

Mode A is the recommended setup when you already have `@bymax-one/nest-cache` in the app.
One client is shared; the lib duplicates it per role and applies the correct retry policy
without touching your cache connection.

---

## 🔌 Mode B — Lib-Owned Connection

Mode B lets the library own the Redis connections. Pass either a URL or raw ioredis options:

```typescript
// URL form
BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL },
  isGlobal: true,
})

// Options form
BymaxQueueModule.forRoot({
  connection: {
    options: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD,
      tls: {},
    },
  },
  isGlobal: true,
})
```

The library opens one connection for queues and one per worker/QueueEvents listener, each
with `maxRetriesPerRequest: null` where BullMQ requires it.

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

| Method               | Signature                                                                                    | Description                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `enqueue`            | `<TData, TResult>(queue, name, data, opts?) → Promise<Job<TData, TResult>>`                  | Add a single job                                                                     |
| `enqueueBulk`        | `<TData, TResult>(queue, jobs) → Promise<Job<TData, TResult>[]>`                             | Add up to 1 000 jobs in one Redis roundtrip                                          |
| `getJob`             | `<TData, TResult>(queue, jobId) → Promise<Job<TData, TResult> \| null>`                      | Get job by ID; `null` when it does not exist                                         |
| `getJobs`            | `<TData, TResult>(queue, status, start?, end?) → Promise<Job<TData, TResult>[]>`             | Page jobs in one status (default `0`–`50`)                                           |
| `getMetrics`         | `(queue) → Promise<QueueMetrics>`                                                            | Uncached snapshot of job counts per status, with a collection timestamp              |
| `pauseQueue`         | `(queue) → Promise<void>`                                                                    | Pause a queue                                                                        |
| `resumeQueue`        | `(queue) → Promise<void>`                                                                    | Resume a paused queue                                                                |
| `cleanQueue`         | `(queue, graceMs, limit, status?) → Promise<string[]>`                                       | Remove up to `limit` jobs older than `graceMs` (`0` = no limit); returns removed ids |
| `upsertJobScheduler` | `<TData, TResult>(queue, id, repeat, template?) → Promise<Job<TData, TResult> \| undefined>` | Create or update a recurring Job Scheduler; returns the first scheduled job          |
| `removeJobScheduler` | `(queue, id) → Promise<boolean>`                                                             | Remove a Job Scheduler by ID                                                         |
| `getJobSchedulers`   | `(queue, start?, end?, asc?) → Promise<JobSchedulerJson[]>`                                  | Page the schedulers registered on a queue                                            |
| `getOrCreateQueue`   | `<TData, TResult>(queue, overrides?) → Queue<TData, TResult>`                                | Return the cached raw `Queue` instance                                               |
| `getCachedQueues`    | `() → ReadonlyMap<string, Queue>`                                                            | Read-only view of every queue created so far                                         |

### `WorkerRegistry`

Programmatic API to create and manage BullMQ workers at runtime.

```typescript
import { WorkerRegistry } from '@bymax-one/nest-queue'
import type { ProgrammaticWorkerConfig, SandboxedWorkerConfig } from '@bymax-one/nest-queue'

// Register an in-process worker
registry.register({
  queueName: 'email',
  processor: async (job) => {
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
  connection: { url: process.env.REDIS_URL },
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
  connection: { url: process.env.REDIS_URL },
  metrics: { enabled: true, cacheTtlMs: 5_000 },
})

import { MetricsService } from '@bymax-one/nest-queue'
import type { QueueMetrics } from '@bymax-one/nest-queue'

const metrics: QueueMetrics = await this.metricsService.getMetrics('email')
const all = await this.metricsService.getAll(['email', 'notifications'])
```

---

## 🚨 Error Code Catalog

Every failure raised by this library is a `QueueException` carrying a stable,
transport-independent `code`. Branch on the code, never on the HTTP status or the
message text — the code is the contract.

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

| Code                                     | HTTP | When thrown                                                                                                                                                                     |
| ---------------------------------------- | :--: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue.invalid_options`                  | 500  | Module options failed bootstrap validation — missing `connection`, mutually exclusive connection arms, non-positive `shutdown.drainTimeoutMs`, or negative `metrics.cacheTtlMs` |
| `queue.connection_invalid`               | 500  | The resolver has no usable client: not yet initialized, or Mode A's injected client is in an unusable `status`                                                                  |
| `queue.connection_requires_null_retries` | 500  | A consumer connection could not be coerced to `maxRetriesPerRequest: null`                                                                                                      |
| `queue.connection_timeout`               | 500  | Mode B: Redis did not reach `ready` within `connectionReadyTimeoutMs`                                                                                                           |
| `queue.invalid_repeat_options`           | 400  | A Job Scheduler schedule was rejected — invalid cron pattern, or neither `pattern` nor `every`                                                                                  |
| `queue.duplicate_processor`              | 500  | Two `@Processor` classes claim the same queue name                                                                                                                              |
| `queue.flow_disabled`                    | 503  | `FlowService` used without `flows.enabled`                                                                                                                                      |
| `queue.metrics_disabled`                 | 503  | `MetricsService` used without `metrics.enabled`                                                                                                                                 |
| `queue.bulk_enqueue_failed`              | 500  | `enqueueBulk` exceeded the 1 000-job cap, or the underlying `addBulk` failed                                                                                                    |
| `queue.worker_registration_failed`       | 500  | A worker could not be constructed, started, or closed                                                                                                                           |

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

### `@OnQueueEvent(eventName)`

Listens to BullMQ `QueueEvents` (global, cross-process events). Requires `queueEvents: { enabled: true }` in module options.

```typescript
@OnQueueEvent('completed')
onCompleted(jobId: string, returnValue: string): void {
  console.log(`Job ${jobId} completed`)
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

---

## 🔁 Deduplication & Telemetry

### Deduplication

Pass the `deduplication` option directly on `enqueue` — the library delegates the behavior entirely to BullMQ:

```typescript
// Simple: collapse duplicates until the first in-flight job completes
await this.queue.enqueue(
  'email',
  'welcome',
  { userId },
  {
    deduplication: { id: `welcome:${userId}` },
  },
)

// Throttle: ignore duplicates for 30 seconds
await this.queue.enqueue(
  'email',
  'welcome',
  { userId },
  {
    deduplication: { id: `welcome:${userId}`, ttl: 30_000 },
  },
)

// Debounce: keep only the latest; each duplicate resets the TTL
await this.queue.enqueue(
  'email',
  'welcome',
  { userId },
  {
    deduplication: { id: `welcome:${userId}`, ttl: 5_000, extend: true, replace: true },
  },
)
```

### OpenTelemetry

Pass a `bullmq-otel` telemetry instance (optional peer dep) to trace spans from `enqueue` through the handler:

```typescript
import { BullMQOtel } from 'bullmq-otel'

BymaxQueueModule.forRoot({
  connection: { url: process.env.REDIS_URL },
  telemetry: new BullMQOtel('my-service', tracer),
})
```

---

## 🛑 Graceful Shutdown

`QueueLifecycle` is registered and invoked automatically via NestJS `onApplicationShutdown`.
It implements a **bounded drain protocol** with at-least-once semantics:

1. All workers are closed with a grace period (`drainTimeoutMs`, default 30 s).
2. A `Promise.race` resolves either when the worker drains normally or when the
   timeout fires — whichever comes first.
3. On timeout, the worker is force-closed (`worker.close(true)`), preserving stalled
   jobs for reprocessing by the next instance.
4. In Mode B, Redis connections are disconnected after all workers are closed.

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
  connection: { url: process.env.REDIS_URL },
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

| Principle                           | Description                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔌 **Connections are role-shaped**  | BullMQ blocks a connection for consumers. Only the duplicated `Worker`/`QueueEvents` connections get `maxRetriesPerRequest: null`; the `Queue` and `FlowProducer` connection keeps ioredis' default retries, so a producer fails fast during a Redis outage instead of hanging a request. |
| 🏷️ **One namespace, four objects**  | The configured `prefix` reaches `Queue`, `Worker`, `QueueEvents` and `FlowProducer`. BullMQ defaults an omitted prefix to `bull`, so a partial application splits producers from consumers silently.                                                                                      |
| 💥 **Fail at boot, not at runtime** | Options are validated before any connection is opened, and every rejection carries a distinct reason.                                                                                                                                                                                     |
| 🧬 **Explicit DI tokens**           | Tokens are `Symbol()` and every injectable constructor parameter carries an explicit `@Inject`. The package ships bundled, where design-time metadata is not emitted — implicit resolution would break inside your build, not ours.                                                       |
| 📅 **Current BullMQ API only**      | Recurring jobs use Job Schedulers; the `addRepeatable` API removed in BullMQ v6 is never called. Cron is validated by BullMQ's own parser.                                                                                                                                                |
| 🧊 **Zero runtime dependencies**    | `dependencies` is `{}`. You choose the exact `bullmq` and `ioredis` versions, and the supply-chain surface stays yours.                                                                                                                                                                   |

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
configuration values (`{ actualValue, expectedValue, limit, received }`), never a
connection object and never `job.data`.

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

`QueueLifecycle` drains in-flight work under a deadline and then force-closes. A job still
running when the deadline expires is **not** acknowledged, so BullMQ's stalled-job check
re-queues it and it runs again. Delivery is at-least-once by design: **every handler must
be idempotent.** A handler that charges a card or sends an email without an idempotency
key will do it twice at some point.

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

| Layer             | Implementation                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Credentials       | Injected options only; never read from `process.env`, never logged, never placed in an exception           |
| Error payloads    | `QueueException.details` restricted to scalar configuration values — no `job.data`, no connection object   |
| Job payloads      | Treated as opaque; never deep-merged (prototype-pollution guard), never logged                             |
| Namespacing       | `prefix` applied uniformly to `Queue`, `Worker`, `QueueEvents` and `FlowProducer`                          |
| Connection policy | `maxRetriesPerRequest: null` confined to duplicated consumer connections; producers keep fail-fast retries |
| Delivery          | At-least-once with a bounded drain; unacknowledged work is re-queued by BullMQ's stalled check             |
| Supply chain      | `dependencies: {}`; SHA-pinned Actions, OSV-Scanner, TruffleHog, OpenSSF Scorecard; npm publish over OIDC  |
| Input validation  | Options validated at bootstrap; cron patterns validated by BullMQ's own parser, never a hand-rolled regex  |

> [!IMPORTANT]
> **Delivery is at-least-once, and `prefix` is not an access boundary.** Handlers must be
> idempotent, and anything with credentials for the Redis instance can read every
> namespace on it.

---

## 🧱 Tech Stack

- **Runtime:** Node.js 24+
- **Framework:** NestJS 11 (`ConfigurableModuleBuilder` + `setExtras`)
- **Queue engine:** BullMQ `^5.16` (peer) over `ioredis ^5` (peer)
- **Telemetry:** `bullmq-otel ^1` (optional peer)
- **Build:** tsup — ESM + CJS per subpath, with `.d.ts` _and_ `.d.cts` declarations
- **Tests:** Jest + `@testcontainers/redis` (E2E) + Stryker (mutation)
- **TypeScript:** 5.x strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zero `any`

---

## 🧪 Testing & Quality

- **100% line/branch coverage** on every implemented file (hard CI gate).
- **Mutation score 98.99%** (Stryker `break 95`) — see [`docs/mutation_testing_results.md`](docs/mutation_testing_results.md).
- **Real-Redis E2E** via Testcontainers (workers, flows, schedulers, deduplication, retries,
  DLQ, graceful shutdown).
- **Type-level API tests** (`pnpm test:types`) pin the published signatures, so a refactor
  that widens or loosens one fails the build instead of reaching consumers.
- **Published-shape gates**: `pnpm check:exports` resolves every entrypoint the way each
  module-resolution mode would (all four `attw` quadrants green, `node10` included), and
  `pnpm smoke` resolves the packed tarball from a real consumer in ESM _and_ CommonJS.
- **Bundle budgets** enforced (`pnpm size`): server ≤ 18 KiB brotli, shared ≤ 2.5 KiB.
- **Supply chain:** SHA-pinned GitHub Actions, OSV-Scanner, TruffleHog, OpenSSF Scorecard,
  npm publish with provenance (OIDC).

```bash
pnpm typecheck && pnpm test:types && pnpm lint && pnpm test:cov:all && \
  pnpm build && pnpm size && pnpm check:exports && pnpm smoke
```

---

## 🩺 Troubleshooting

### `CONNECTION_REQUIRES_NULL_RETRIES`

This error fires in Mode A when the injected client was not configured with
`maxRetriesPerRequest: null`. BullMQ workers require this setting to block on
Redis operations rather than giving up after a few retries.

If you use `@bymax-one/nest-cache`, pass a queue-dedicated client with `maxRetriesPerRequest: null`:

```typescript
// In your cache module, create a second ioredis client for the queue
const queueRedis = new Redis({ ..., maxRetriesPerRequest: null })
```

The library duplicates the client you pass and applies the correct setting; ensure
the **original** client passed to Mode A is usable as a duplication source (ioredis
allows duplicate on any state).

### Jobs get stuck (not processed after restart)

Stalled jobs are re-queued automatically by BullMQ's stalled-job check. If workers
do not pick them up:

1. Verify `drainTimeoutMs` is larger than the worst-case job runtime.
2. Verify `lockDuration` (in `workerOptions`) covers the handler execution time —
   a worker that runs longer than `lockDuration` will have its lock stolen, marking
   the job as stalled.
3. Check `worker.maxStalledCount` is `> 0` (default `1`) so stalled jobs re-queue.

---

## 🚫 What This Library Does NOT Do

- **NestJS only** — does not work with plain Express, standalone Fastify, or other frameworks.
- **Node.js only** — Deno and Bun are not supported.
- **BullMQ `^5.16` (1.x floor)** — v6 promotion is planned once the E2E suite is
  green on the v5 + v6 matrix; see the BullMQ version policy in
  [`CHANGELOG.md`](CHANGELOG.md).
- **No Redis Cluster sharding** — BullMQ's cluster support is not exercised by this library.
- **No built-in DLQ helper** — use the `@OnWorkerEvent('failed')` pattern above.
- **No Prometheus metrics export** — `getMetrics()` returns snapshots; publish them
  via `prom-client` in your own health endpoint.

For the full list of limitations and their alternatives, see
[`docs/technical_specification.md § 16`](docs/technical_specification.md).

---

## 🤝 Contributing

Pull requests are welcome. Please open an issue first for significant changes.

- Read [`docs/technical_specification.md`](docs/technical_specification.md) for architecture decisions.
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
