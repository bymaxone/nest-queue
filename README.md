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
import type { Job, JobsOptions, JobSchedulerRepeatOptions, QueueMetrics } from '@bymax-one/nest-queue'
```

| Method | Signature | Description |
|---|---|---|
| `enqueue` | `<TData, TResult>(queue, name, data, opts?) → Promise<Job<TData, TResult>>` | Add a single job |
| `enqueueBulk` | `<TData, TResult>(queue, jobs) → Promise<Job<TData, TResult>[]>` | Add up to 1 000 jobs atomically |
| `getJob` | `<TData, TResult>(queue, jobId) → Promise<Job<TData, TResult> \| undefined>` | Get job by ID |
| `getJobs` | `<TData, TResult>(queue, statuses, start?, end?) → Promise<Job<TData, TResult>[]>` | Get jobs by status |
| `getMetrics` | `(queue) → Promise<QueueMetrics>` | Snapshot of counts + processed/failed rates |
| `pauseQueue` | `(queue) → Promise<void>` | Pause a queue |
| `resumeQueue` | `(queue) → Promise<void>` | Resume a paused queue |
| `cleanQueue` | `(queue, grace, limit, status?) → Promise<string[]>` | Remove finished jobs older than `grace` ms |
| `upsertJobScheduler` | `(queue, id, repeat, template?) → Promise<void>` | Create or update a recurring Job Scheduler |
| `removeJobScheduler` | `(queue, id) → Promise<boolean>` | Remove a Job Scheduler by ID |
| `getJobSchedulers` | `(queue, opts?) → Promise<JobSchedulerJson[]>` | List all Job Schedulers for a queue |
| `getOrCreateQueue` | `<TData, TResult>(queue, overrides?) → Queue<TData, TResult>` | Return the cached raw `Queue` instance |

### `WorkerRegistry`

Programmatic API to create and manage BullMQ workers at runtime.

```typescript
import { WorkerRegistry } from '@bymax-one/nest-queue'
import type { ProgrammaticWorkerConfig, SandboxedWorkerConfig } from '@bymax-one/nest-queue'

// Register an in-process worker
registry.register({
  queueName: 'email',
  processor: async (job) => { /* … */ },
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
await this.queue.enqueue('email', 'welcome', { userId }, {
  deduplication: { id: `welcome:${userId}` },
})

// Throttle: ignore duplicates for 30 seconds
await this.queue.enqueue('email', 'welcome', { userId }, {
  deduplication: { id: `welcome:${userId}`, ttl: 30_000 },
})

// Debounce: keep only the latest; each duplicate resets the TTL
await this.queue.enqueue('email', 'welcome', { userId }, {
  deduplication: { id: `welcome:${userId}`, ttl: 5_000, extend: true, replace: true },
})
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

## 📦 Subpath Exports

| Subpath | Entry | Description |
|---|---|---|
| `.` | `@bymax-one/nest-queue` | Full server surface: module, services, decorators, types |
| `./shared` | `@bymax-one/nest-queue/shared` | Zero-dependency types and constants; safe in any runtime |

### Peer dependency matrix

| Subpath | Required peers |
|---|---|
| `.` (server) | `@nestjs/common ^11`, `@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata ^0.2` |
| `./shared` | None |
| Optional | `bullmq-otel ^1` (OpenTelemetry) |

---

## 🤔 Why over `@nestjs/bullmq`

| Concern | `@nestjs/bullmq` (official) | `@bymax-one/nest-queue` |
|---|---|---|
| Module setup | `BullModule.forRoot()` + `registerQueue()` per queue | Single `forRoot`/`forRootAsync`; queues created on demand by name |
| Connection | Manual ioredis + `maxRetriesPerRequest` wiring | Dual mode (BYO / lib-owned); correct per-role retry policy applied automatically |
| Job defaults | Per `registerQueue` | Centralized opinionated defaults with per-queue/per-job overrides |
| Producer API | `@InjectQueue` + raw `queue.add` | Typed `enqueue<TData, TResult>()`, `enqueueBulk`, `upsertJobScheduler` |
| Shutdown | Framework closes workers | Explicit bounded-drain protocol; force-close + stalled accounting |
| Observability | Manual | `telemetry` passthrough (OpenTelemetry) + `MetricsService` |

**Choose this library** when you want a single opinionated setup, the `@bymax-one/nest-cache`
connection-sharing story, enforced defaults, and a tested bounded-shutdown protocol.

**Choose `@nestjs/bullmq`** when you want the thinnest official binding and prefer to
wire connection and defaults yourself.

---

## 🧱 Tech Stack

- **Runtime:** Node.js 24+
- **Framework:** NestJS 11 (`ConfigurableModuleBuilder` + `setExtras`)
- **Queue engine:** BullMQ `^5.16` (peer) over `ioredis ^5` (peer)
- **Telemetry:** `bullmq-otel ^1` (optional peer)
- **Build:** tsup (ESM + CJS dual subpath, `.d.ts` for both)
- **Tests:** Jest + `@testcontainers/redis` (E2E) + Stryker (mutation)
- **TypeScript:** 5.x strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zero `any`

---

## 🧪 Testing & Quality

- **100% line/branch coverage** on every implemented file (hard CI gate).
- **Mutation score 98.99%** (Stryker `break 95`) — see [`docs/mutation_testing_results.md`](docs/mutation_testing_results.md).
- **Real-Redis E2E** via Testcontainers (workers, flows, schedulers, deduplication, retries,
  DLQ, graceful shutdown).
- **Bundle budgets** enforced (`pnpm size`): server ≤ 18 KiB brotli, shared ≤ 2.5 KiB.
- **Supply chain:** SHA-pinned GitHub Actions, OSV-Scanner, TruffleHog, OpenSSF Scorecard,
  npm publish with provenance (OIDC).

```bash
pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size
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
- **BullMQ `^5.16` (0.1.x floor)** — v6 promotion is planned once the E2E suite is
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
- Read [`docs/development_plan.md`](docs/development_plan.md) for the phased roadmap.
- Run the full gate: `pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size`
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
