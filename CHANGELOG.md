# Changelog

All notable changes to `@bymax-one/nest-queue` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-06-27

### Added

- `BymaxQueueModule.forRoot()` and `.forRootAsync()` dynamic module (built on
  `ConfigurableModuleBuilder`; `isGlobal` mapped to `DynamicModule.global` via `setExtras`)
- `QueueService` with typed `enqueue` (native `deduplication` options), `enqueueBulk`,
  `getJob`, `getJobs`, `getMetrics`, `pauseQueue`/`resumeQueue`/`cleanQueue`, and Job
  Schedulers `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`
- `@Processor`, `@Process`, `@OnWorkerEvent` (worker-local, full `Job`), `@OnQueueEvent`
  (global) decorators plus automatic discovery via `DiscoveryService`; `job.updateProgress()`
  and progress event support
- `WorkerRegistry` programmatic API, including `registerSandboxed` for file-based
  out-of-process processors
- `FlowService` (opt-in via `options.flows.enabled`)
- `MetricsService` with TTL cache (opt-in via `options.metrics.enabled`)
- Optional OpenTelemetry `telemetry` passthrough (via `bullmq-otel`, an optional peer dep)
- `QueueLifecycle` bounded graceful-shutdown protocol (bounded drain via `Promise.race` +
  `worker.close(true)`, optional drain, Redis disconnect on Mode B); at-least-once semantics
  documented
- Dual-mode connection (Mode A: bring-your-own ioredis / Mode B: lib-owned), with per-role
  `maxRetriesPerRequest` policy applied automatically
- Subpaths: `.` (server), `./shared` (zero-dep types and constants)
- Peer deps: `@nestjs/common ^11`, `@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`,
  `reflect-metadata ^0.2`; optional `bullmq-otel ^1`
- E2E tests with Testcontainers Redis

---

## BullMQ version policy

### 0.1.x — floor `bullmq ^5.16.0`

The `0.1.x` series floors `peerDependencies.bullmq` at `^5.16.0`, the release that
introduced the Job Schedulers API (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`).
Current recommended peer: `5.79.1`.

### Forward compatibility with BullMQ v6

This library is **forward-compatible with BullMQ v6 by design**. It exclusively uses
Job Schedulers for recurring jobs and never calls the removed `addRepeatable`/`removeRepeatable`
API, so no public-API break is expected on promotion to v6.

**Promotion trigger.** When the E2E suite is green on both the v5 and v6 matrix, the peer
range will be widened to `^5.16.0 || ^6.0.0` in a patch release. No adapter is needed because
the recurring-jobs surface is unchanged.

**Fallback.** If another API used by the library breaks in BullMQ v6 without a trivial adapter,
a parallel `v6` branch will be created to keep `0.1.x`/`0.2.x` on `^5.16` only, and a `1.x`
series will track the v6 peer range.

---

[0.1.0]: https://github.com/bymaxone/nest-queue/releases/tag/v0.1.0
