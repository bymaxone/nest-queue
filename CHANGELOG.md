# Changelog

All notable changes to `@bymax-one/nest-queue` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.2] — 2026-07-30

### Security

- **Peer floors raised to exclude known-vulnerable NestJS versions.** The declared
  ranges were `@nestjs/common ^11.0.0` and `@nestjs/core ^11.0.0`, and both
  admitted versions with published advisories:

  | Peer             | Advisory                                                                                                                                    | Vulnerable                    | New floor  |
  | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
  | `@nestjs/common` | [GHSA-cj7v-w2c7-cp7c](https://github.com/advisories/GHSA-cj7v-w2c7-cp7c) — remote code execution via the `Content-Type` header              | `>= 11.0.0-next.1, < 11.0.16` | `^11.0.16` |
  | `@nestjs/core`   | [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75) — improper neutralization of special elements in downstream output | `<= 11.1.17`                  | `^11.1.18` |

  A peer range is a statement about which versions this library supports. Leaving
  the floor below a published advisory tells a consumer that a vulnerable install
  is a supported one, and nothing in their tooling contradicts it.

  Shipped as a **patch**, which is where a security fix belongs. Choosing a minor
  would have bought nothing: `^1.0.1` — what a consumer almost always declares —
  accepts `1.1.0` just as readily as `1.0.2`, so the same installs are affected
  either way. Only a major would hold it back, and holding a security floor behind
  a major migration is the opposite of what it is for.

  No runtime behaviour changed, and the repository's own dev dependencies were
  already above both floors. A consumer below them sees a peer warning telling
  them to upgrade off a version with a published RCE advisory — which is the
  intended outcome, not collateral damage.

---

## [1.0.1] — 2026-07-30

First release published by CI, and therefore the first carrying an npm provenance
attestation: `1.0.0` had to be published from a maintainer's machine because npm
trusted publishing requires the package to already exist.

### Documentation

- Troubleshooting entry for `ERR_PNPM_IGNORED_BUILDS: msgpackr-extract` on
  install. `msgpackr-extract` is a native optional dependency of BullMQ, and pnpm
  blocks build scripts by default — pnpm 10 warns and installs anyway, pnpm 11
  turns the same block into an error, so it appears on a pnpm upgrade with no
  change on the consumer's side. The entry says whose dependency it is, shows both
  the interactive and the declarative way to approve it, and notes that skipping
  the build is fine because `msgpackr` falls back to a pure-JavaScript
  implementation.

### Internal

- The dogfood smoke test installs its throwaway consumer with `--ignore-scripts`
  and reports the full `spawnSync` outcome — status, signal, spawn error and both
  streams — on failure. Not shipped in the package; recorded because it is what
  made the `v1.0.0` release workflow fail after the publish had already succeeded.

---

## [1.0.0] — 2026-07-30

First public release. The library is feature-complete for the surface described
in `docs/technical_specification.md`, holds 100% line/branch/function/statement
coverage, and ships with zero runtime dependencies.

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
- `'error'` as a subscribable `@OnQueueEvent` name. It carries a real `Error`
  instance rather than the serialized payload every other queue event delivers,
  because it reports a connection fault rather than a job transition
- Peer deps: `@nestjs/common ^11`, `@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`,
  `reflect-metadata ^0.2`; optional `bullmq-otel ^1`
- E2E tests with Testcontainers Redis

### Fixed

- **The configured `prefix` now reaches every BullMQ object.** Only the producer
  `Queue` received `options.prefix`; the `Worker`, `QueueEvents` and `FlowProducer`
  were constructed without it and fell back to BullMQ's default `bull` prefix. With
  any non-default prefix, producers and consumers diverged onto separate keyspaces —
  workers never consumed jobs, event listeners never fired, and flow jobs were
  enqueued where no worker polled. Nothing threw.
- **Explicit `@Inject` on every injectable constructor parameter.** The package
  ships as a tsup/esbuild bundle, and esbuild does not emit
  `emitDecoratorMetadata`. Providers resolved purely by reflected type metadata
  (`QueueService`, `WorkerRegistry`, `QueueEventsRegistry`,
  `ProcessorDiscoveryService`, `QueueLifecycle`) could not be instantiated from
  the built `dist` by a consumer's Nest container.
- **The `exports` map hands CommonJS consumers CommonJS declarations.** With
  `"type": "module"`, TypeScript reads a bare `.d.ts` as ESM, so a `require()`
  consumer landed on ESM declarations. `types` is now declared per condition,
  `main`/`module`/`types` are present for legacy resolution, `./package.json` is
  exported, and the package passes `attw` at the strict profile.

- **Every BullMQ emitter the library creates carries a fallback `error` listener.**
  `Queue`, `Worker`, `QueueEvents` and `FlowProducer` extend Node's `EventEmitter`,
  where emitting `'error'` with no listener **throws** rather than being delivered.
  The library constructs all four on the consumer's behalf, so a transient Redis
  fault surfaced as an uncaught exception in an application that never asked for
  the emitter. The fallback logs and does not consume the event — an
  `@OnWorkerEvent('error')` or `@OnQueueEvent('error')` handler still runs.
- **One owner for shutdown.** `QueueService`, `FlowService` and `ConnectionResolver`
  each exposed `onModuleDestroy`, and NestJS binds lifecycle hooks by method name,
  so Nest invoked them on its own schedule while `QueueLifecycle` also called two
  of them inside its ordered sequence: the flow producer closed twice, and queues
  could close before the bounded drain finished with them. They now expose plain
  methods — `QueueService.closeAll()`, `FlowService.close()`,
  `ConnectionResolver.teardown()` — and `QueueLifecycle` is the only lifecycle hook.
- **Operational failures no longer masquerade as a bad cron.** `upsertJobScheduler`
  wrapped every failure in `INVALID_REPEAT_OPTIONS` with HTTP 400 and "pattern must
  be a valid cron expression", so an unreachable Redis was reported as a client
  mistake — with a status telling the caller not to retry. Faults carrying a string
  `code` now propagate untouched.
- **A malformed `repeat` raises the documented error instead of a `TypeError`.**
  The union forbids it for a TypeScript caller, but plain JavaScript and any
  payload cast from `unknown` reached the `in` operator unchecked. `null`,
  `undefined`, strings, numbers and arrays are rejected as
  `INVALID_REPEAT_OPTIONS`, as is a blank `pattern`.
- **`QueueEventsRegistry.getConnections()` returns a copy.** `ReadonlyMap` is a
  compile-time claim only; the live registry could be cast and mutated.

### Security

- Release pipeline gated behind a manual-approval environment, with SHA-pinned
  actions, tag/version verification, and OIDC provenance from the second release
  onward.

---

## BullMQ version policy

### 1.x — floor `bullmq ^5.16.0`

The `1.x` series floors `peerDependencies.bullmq` at `^5.16.0`, the release that
introduced the Job Schedulers API (`upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`).
Current recommended peer: `5.79.1`.

### Forward compatibility with BullMQ v6

This library is **forward-compatible with BullMQ v6 by design**. It exclusively uses
Job Schedulers for recurring jobs and never calls the removed `addRepeatable`/`removeRepeatable`
API, so no public-API break is expected on promotion to v6.

**Promotion trigger.** When the E2E suite is green on both the v5 and v6 matrix, the peer
range will be widened to `^5.16.0 || ^6.0.0` in a minor release. No adapter is needed because
the recurring-jobs surface is unchanged.

**Fallback.** If another API used by the library breaks in BullMQ v6 without a trivial adapter,
a parallel branch will keep the `1.x` line on `^5.16` only, and a `2.x` series will track the
v6 peer range.

---

[1.0.2]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.2
[1.0.1]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.0
