# Changelog

All notable changes to `@bymax-one/nest-queue` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.10] — 2026-08-06

**Documentation and tooling only.** `dist/` is byte-identical to `1.0.9`; no source file
changed.

### Fixed

- The quality bullet claimed "no suppression comments" while the source carries five
  `// Stryker disable` comments. The claim was about type suppressions and read as false to
  anyone who grepped for it; it now says what is true — no `@ts-ignore` and no
  `eslint-disable`.

### Security

- **The OSV scan was passing because it had nothing to read.** The workflow ran
  `osv-scanner` with no `actions/checkout` step, so it walked an empty workspace and
  reported "No package sources found" and "No lockfiles found" before exiting 0. A green
  check meant the scanner found no files, which is indistinguishable from finding no
  vulnerabilities. With the checkout in place it scans the lockfile, which is how the next
  item was found.
- **`js-yaml` is patched to the fixed release** (GHSA-5p4m-2wfm-xmqj, CVSS 7.5). The
  override floors here already scoped it per major but admitted `3.15.0` and `4.3.0`, both
  covered by the advisory; they are raised to `^3.15.1` and `^4.3.1`. It reaches this repo
  only through `jest` -> `babel-plugin-istanbul` -> `@istanbuljs/load-nyc-config`, and
  `dependencies` is empty, so nothing here ships it and no consumer was exposed. `dist/` is
  unaffected.

### Added

- `check:mutants` gate (`scripts/check-mutation-directives.mjs`) — validates every
  `// Stryker` comment against the grammar Stryker's own parser accepts, rejecting a reason
  written after `--` instead of a colon (silently dropped, and the report then shows
  `Ignored using a comment`), a reason wrapped onto a second comment line (the report keeps
  only the first fragment), and a mutator name Stryker does not know, which matches nothing
  and so silences nothing. Wired into CI and `prepublishOnly`.
- `docs/mutation_testing_plan.md` carries the suppression policy now shared, word for word,
  across the `@bymax-one/nest-*` libraries.

## [1.0.9] — 2026-08-06

**Published-artifact change, not a behavioural one.** `dist/` differs from `1.0.8` — this
bundler preserves comments and the source gained mutation-suppression notes — but no runtime
path changed. Measured by building both revisions and diffing the output.

### Documentation

- The mutation badge and README said **99.06%**; the measured score is **99.68%**.

### Tests

- The withheld Redis connection now has the shape of its guarantee asserted: that the property is
  non-enumerable, that redefining it throws, and that the URL's password stays out of both
  `JSON.stringify` and `inspect({ showHidden: true })`.

## [1.0.8] — 2026-08-04

**Runtime change.** `dist/` differs from `1.0.7`.

### Security

- The Redis credentials are no longer disclosed when a service that holds them is
  serialized. `connection` moves from a plain field on the resolved options to a
  non-enumerable accessor, and `ConnectionResolver` keeps the ioredis client and the
  consumer's module options in ECMAScript private fields, as do the maps holding the
  `Queue`, `Worker` and `QueueEvents` instances. Those objects were all reachable by
  walking a service: a `url` carries the password inline, and an ioredis instance carries
  `options.password` as a plain field, so `JSON.stringify`, object spread and
  `util.inspect` on `QueueService` emitted the password in plaintext — which is what a
  structured logger does when it renders a provider it was handed, and what an error
  reporter does when it captures the scope of a throw.

Reading on purpose is unchanged: `options.connection` resolves as before, and no public
type or export changed.

## [1.0.7] — 2026-08-04

**Runtime change.** `dist/` differs from `1.0.6`: the four decorators no longer carry
a `reflect-metadata` side-effect import, so the built bundle no longer references the
package at all.

### Fixed

- **The application owns the `reflect-metadata` polyfill.** `@Processor`, `@Process`,
  `@OnWorkerEvent` and `@OnQueueEvent` each imported it for its side effect. None of
  the other eight `@bymax-one` libraries does — the polyfill is global state the
  application initialises once in `main.ts`, and NestJS pulls it in regardless:
  importing `@nestjs/common` alone takes `Reflect.defineMetadata` from `undefined` to
  `function`. Nothing here needed to load it.

  Carrying it also contradicted this package's own `"sideEffects": false`, which
  asserts that no module has a side effect while importing something whose entire
  purpose is one.

  The cost was measurable in a consumer's bundle: with the import present, esbuild
  inlines the polyfill, taking a minimal bundle from **53 kB to 95 kB** even when the
  application had already loaded it.

  Nothing changes for a correctly wired application. The decorators are reachable
  only through the `.` subpath, whose bundle imports `@nestjs/common` on its first
  line — so the polyfill is present before any decorator body runs, which the tests
  and a real consumer both confirm.

### Changed

- **The Quick Start shows the `main.ts` entry point**, with `import 'reflect-metadata'`
  as its first line, and the peer matrix states plainly that the polyfill belongs to
  the application. Previously the README named `reflect-metadata` only as a peer, which
  was survivable while the library loaded it and is not now.

---

## [1.0.6] — 2026-08-02

Metadata only. `dist/` is byte-identical to `1.0.5` — verified by diffing a fresh
build against the published tarball — so there is no runtime change.

### Fixed

- **The npm package page showed no documentation.** `1.0.5` reached the registry
  with an empty `readme` field, so the page rendered nothing, even though
  `README.md` was in the tarball all along. Publishing goes through the npm CLI
  now instead of `pnpm publish`, and this release is what carries the README to
  the registry.

  The cause is measurable: across the five published `@bymax-one/*` libraries,
  every package released under pnpm 11 landed with an empty `readme` and no
  `_npmVersion`, while every one released under pnpm 10 — which delegated to the
  npm CLI — carries both. `nest-realtime@1.0.1` confirmed it, restoring both
  fields in a single release by switching the command.

---

## [1.0.5] — 2026-08-01

Documentation only. `dist/` is byte-identical to `1.0.4` — verified by diffing a
fresh build against the published tarball — so there is no runtime change.

### Fixed

- **The README's configuration examples did not compile in a strict project.**
  Eight snippets passed `process.env.REDIS_URL` where a `string` is required:

  ```
  TS2322: Type 'string | undefined' is not assignable to type 'string'.
  ```

  `process.env.X` is `string | undefined` under `strict`, so anyone copying the
  Quick Start into a strict TypeScript project — the configuration this library
  itself uses and recommends — got a type error out of the box. Now shown with a
  fallback, which is what the code has to do anyway:

  ```ts
  connection: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379'
  }
  ```

  Found by `pnpm check:published`, added in the same release, which compiles the
  README's own snippets against the built package. Nobody had reported it, and
  nothing before this would have.

### Added

- **`pnpm check:published`** — a gate that verifies the published surface matches
  the documentation, before a tag rather than after it. It scaffolds a throwaway
  consumer, symlinks the package into its own `node_modules` so resolution runs
  through the `exports` map into `dist/`, and then checks that the README's links
  resolve, that its TypeScript snippets and the type tests compile against the
  built package, and that every `v*.*.*` tag has a `## [x.y.z]` CHANGELOG section.

  Each of those exists because its absence let a defect reach npm: the 404 link
  corrected in `1.0.3`, the exported type that rejected the README's own snippet
  corrected in `1.0.4`, and a deleted heading that would have turned release notes
  into the generic fallback.

  It runs in CI, in `release.yml`, and inside `prepublishOnly` — the last one
  because the first publish of a package is manual by design, which is precisely
  the path that bypasses the tag workflow.

---

## [1.0.4] — 2026-08-01

### Fixed

- **`BymaxQueueModuleAsyncOptions.useFactory` rejected the factory this library
  documents.** It was declared `(...args: unknown[]) => …`, and a parameter typed
  `unknown` accepts no narrower parameter under `strictFunctionTypes`. So the
  shape shown in the README and in `BymaxQueueModule`'s own `@example`:

  ```ts
  useFactory: (client: Redis) => ({ connection: { client } })
  ```

  failed to typecheck **against the exported interface**:

  ```
  TS2322: Type '(client: Redis) => …' is not assignable to
          type '(...args: unknown[]) => …'
  ```

  Scope, precisely: `forRootAsync` is typed by NestJS's `ASYNC_OPTIONS_TYPE`, not
  by this interface, so passing the object **inline** always compiled. Only a
  consumer who annotated it — extracting the options into a
  `const opts: BymaxQueueModuleAsyncOptions = { … }` — hit the error. The
  interface was stricter than the module it describes.

  It is now declared with **method syntax**. `strictFunctionTypes` makes
  parameters contravariant for function-typed _properties_ but leaves method
  parameters bivariant, so the interface accepts a factory that names its
  injected types. This **widens** what is accepted: every factory that compiled
  before still does, the variadic `(...args: unknown[])` form included. Nothing
  needs changing in consumer code.

  Method syntax rather than a looser parameter type, because the factory has to
  stay **callable**: NestJS invokes it with the values `inject` resolves, and a
  consumer may call it directly in a unit test. A `never[]` rest parameter would
  have bought the same assignability and silently cost that —
  `options.useFactory(client)` fails with `TS2345: Argument of type 'Redis' is
not assignable to parameter of type 'never'`.

  Pinned by seven cases in `test/types/public-api.test-d.ts` — typed parameter,
  async, several parameters, zero parameters, the pre-1.0.4 variadic form, and
  two for callability — where `useFactory` was previously pinned by nothing,
  which is why this went unnoticed. Red-checked against **both** rejected
  signatures: the original property form fails the assignability cases, and
  `never[]` fails the callability ones.

  No runtime change, verified rather than asserted: diffed against the published
  `1.0.3` tarball, all four emitted runtime files (`server` and `shared`, `.mjs`
  and `.cjs`) are byte-identical, and only `dist/server/index.d.ts` / `.d.cts`
  differ. The altered source declares types only, so it produces no Stryker
  mutants and the 99.06% score stands.

---

## [1.0.3] — 2026-08-01

Documentation only. `dist/` is byte-identical to `1.0.2` — verified by unpacking
the published tarball and diffing it against a fresh build — so there is no
runtime change of any kind for consumers.

### Fixed

- **The "Example App" link in the README pointed at a path that no longer
  exists.** It resolved to
  `github.com/bymaxone/nest-queue/tree/main/examples/nest-queue-example`, a
  directory that was renamed to `test/consumer-app` in this repository. The link
  returned **404** for anyone reading the package page on npm, which is where a
  README link matters most and where a broken one is least visible to us.

  It now points at [`bymaxone/nest-queue-example`](https://github.com/bymaxone/nest-queue-example),
  the actual reference application.

### Changed

- **The README no longer implies that `test/consumer-app` is a demo.** The two
  artifacts had been sharing one name, and only one of them is something to copy
  from:

  |                                 | What it is                                                                                                                                                                                                |
  | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `bymaxone/nest-queue-example`   | The reference application — an API and a web console exercising every public export against a real Redis. **Start here.**                                                                                 |
  | `test/consumer-app` (this repo) | A typecheck fixture. CI compiles it against the freshly built library on every pull request to catch an ergonomic break in the decorator API that a signature test cannot see. Not published, not a demo. |

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

[1.0.10]: https://github.com/bymaxone/nest-queue/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/bymaxone/nest-queue/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/bymaxone/nest-queue/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/bymaxone/nest-queue/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.6
[1.0.5]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.5
[1.0.4]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.3
[1.0.2]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.2
[1.0.1]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-queue/releases/tag/v1.0.0
