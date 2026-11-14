# Changelog

All notable changes to `@bymax-one/nest-queue` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.2.15] — 2026-11-14

Against 1.2.14 the built declarations gain `ConnectionResolver.awaitReady()`; nothing else in the public API changes.

### Fixed

- **A call made while the connection is down now reports the documented error.** With the owned connection's offline queue off, a call on a queue already in use during a refused-connection outage rejected at once with ioredis's plain `Stream isn't writeable and enableOfflineQueue options is false`, so a host retrying on `CONNECTION_TIMEOUT` as documented never retried. It is now `CONNECTION_TIMEOUT` with `details.operation` and `details.reason: 'offline'`, and the ioredis error as `cause`.
- **The first call on a queue no longer waits for Redis without a deadline.** `getMetrics`, `getJob`, `getJobs`, the scheduler calls, `pauseQueue`, `resumeQueue` and `cleanQueue` on a queue name not yet used waited in BullMQ for the client to be ready, with no bound, for as long as the outage lasted. Every `QueueService` call is now bounded by `enqueueTimeoutMs` and rejects with `CONNECTION_TIMEOUT`.
- **Shutdown no longer leaves a worker running after its drain budget.** A handler that never settled kept the worker's lock-renewal timer alive after `app.close()`: the process did not exit by itself and logged `Connection is closed.` repeatedly. BullMQ ignores a forced close once a graceful one has started, so the worker is now paused first and closed with `close(true)` as its first close when the budget runs out. What the abandoned handler produces after the budget, a result or a failure, is dropped, so BullMQ cannot resume the stopped worker and reopen its connection. The handler's own promise still keeps running, since user code cannot be cancelled. A sandboxed worker is the exception: BullMQ cleans only idle child processes, so a job still running in its child when the budget ends leaves that process, and the host process, running until the child exits.

### Documentation

- `enqueueTimeoutMs` is documented as the per-call deadline of every `QueueService` call, and `queue.connection_timeout` as covering a connection that is down.

#### Apply to a derived backend

- If you match the ioredis error `Stream isn't writeable and enableOfflineQueue options is false` on a call, match `CONNECTION_TIMEOUT` instead; `details.reason` is `'offline'` and the original error is its `cause`.
- If a `getMetrics`, `getJob`, `getJobs`, scheduler, pause, resume or clean call relied on waiting out an outage on a queue's first use, it now rejects with `CONNECTION_TIMEOUT` after `enqueueTimeoutMs`; raise the option to wait longer.
- If you replace `ConnectionResolver` with your own implementation, add `awaitReady(): Promise<void>`: `QueueService` calls it before the first call on each queue name.
- If you parse the shutdown log lines, the wording changed: `forcing close` is gone and the summary reads `N worker(s) stopped without draining`.

---

## [1.2.14] — 2026-11-14

Several defaults change in this release, so read the Apply note below. A boot that succeeds, an
enqueue that Redis answers and a job that completes behave as before.

### Fixed

- **A failed Mode B startup no longer leaves a client reconnecting.** When Redis was not ready in
  time the library rejected the boot but kept the `ioredis` client it had opened, which kept
  reconnecting and held the process open. The
  client is now closed on every startup failure.
- **`connectionReadyTimeoutMs` is a budget, not a first-error limit.** The first connection error
  used to reject the boot at once with the raw `ioredis` error, so a
  Redis restarting during a deploy failed the application. Errors while the client is
  reconnecting are now waited through until the budget ends; the boot then rejects with
  `queue.connection_timeout` whose `details` carry `timeoutMs` and `lastErrorCode` (for example
  `ECONNREFUSED`), never the message, which can name the host. A refused credential
  (`WRONGPASS`, `NOAUTH`) or a client that stopped reconnecting rejects at once with
  `queue.connection_invalid`. Code that matched the raw `ioredis` error of a failed boot should
  match the `QueueException` code instead.

### Changed

- **A producer call can no longer hang on a Redis that does not answer.** On the connection the
  library opens, every command now carries a 5 s deadline (`commandTimeoutMs`, or the ioredis
  `commandTimeout` you set), and `enqueue` and `enqueueBulk` reject with `CONNECTION_TIMEOUT` after
  `enqueueTimeoutMs` (10 s) in either connection mode. A command that hits the connection's deadline
  is reported the same way, as `CONNECTION_TIMEOUT` with `details.operation` and `timeoutMs` and the
  original error as `cause`.
- **The owned connection no longer buffers commands during an outage.** Its offline queue is off, so
  a call made while Redis is down fails at once instead of waiting in memory. Set `options.enableOfflineQueue: true` to keep the old
  behaviour. Worker and QueueEvents connections keep their offline queue and have no command deadline.
- **A shared client with `maxRetriesPerRequest: null` is reported at boot.** Calls other than `enqueue` and
  `enqueueBulk` then wait for as long as an outage lasts; the library warns and does not refuse.
- **Shutdown is bounded by one budget, not one per worker.** Workers are closed in parallel and the
  queue-events and connection steps share what is left of `drainTimeoutMs`; a connection that has not
  quit by then is disconnected. With several stuck workers the previous sequence took the budget once
  for each.
- **`unregister` releases the connection even when the worker's `close()` throws.** It then rethrows
  that error; the registry entry is dropped and the socket closed either way.
- **`jobTimeoutMs` bounds a handler that never settles.** It is a new worker option with no default,
  a whole number of milliseconds from 1 to 2 147 483 647, as are `commandTimeoutMs` and `enqueueTimeoutMs`.
  When it passes, the job fails with a `queue.job_timeout` error, retries under its `attempts` and
  `backoff`, and its concurrency slot is free again. Handlers receive an `AbortSignal` as a second
  argument, which aborts at that moment or when BullMQ cancels the job (`worker.cancelJob()`,
  `worker.cancelAllJobs()`); closing the worker does not abort it. Before, a hung handler held its
  slot for good and the rest of the queue waited.
- **Retries are spread by default.** The default backoff now carries 50% jitter: a retry waits between
  half of its exponential delay and the whole of it, so jobs that failed together no longer retry in
  the same instant after an outage. A `backoff` you set yourself is used as given.
- **`getJobs` reads a bounded window.** At most 1 000 jobs per call, with integer bounds and
  `0 <= start <= end`; an `end` of `-1`, which BullMQ reads as the whole list, is refused with
  `INVALID_OPTIONS`.

### Documentation

- **Queue names are documented as keys, not user input**, because each distinct name keeps a queue and
  its Redis resources for the life of the process.
- **The `prefix` option's JSDoc says it is a namespace, not an access control**.
- **A timed-out `enqueue` may still have been added**, and the README says to pass a deterministic
  `jobId` for anything that must not run twice.
- **The README no longer says a Redis outage fails fast regardless of configuration.** It now states
  what bounds a producer call and when the bound does not apply.

#### Apply to a derived backend

- If you matched ioredis's `Command timed out` error on a producer or inspection call, match
  `CONNECTION_TIMEOUT` instead; the original error is its `cause`.
- If you rely on an `enqueue` waiting out a Redis outage, it now rejects with `CONNECTION_TIMEOUT`
  after `enqueueTimeoutMs` (the add may still complete in Redis afterwards, so retry with a stable
  `jobId` or `deduplication`); raise the option to keep waiting longer.
- If you assert exact retry delays, expect them between 50% and 100% of the computed value; set
  `defaultJobOptions.backoff` without `jitter` to keep exact delays.
- If you call `getJobs` with an `end` of `-1` or a window over 1 000 jobs, those calls now throw
  `INVALID_OPTIONS`. Page through the list with several calls of at most 1 000 jobs, for example
  `getJobs(queue, status, start, start + 499)` in a loop until a page comes back short; the README
  has the loop.
- Nothing changes until you set `jobTimeoutMs`. If you do, a handler that runs longer than it is
  failed and retried while its own promise keeps running unless it honours the `AbortSignal`, so keep
  handlers idempotent. If you wrap `ProgrammaticWorkerConfig.handler`, accept the new optional second
  parameter.
- If you relied on shutdown taking up to one `drainTimeoutMs` per stuck worker, it now takes at most
  one in total; raise `drainTimeoutMs` if jobs need longer.
- If your Mode B code calls a `QueueService` method during a Redis outage and expected it to wait for
  the reconnect, it now rejects at once, since the owned connection has no offline queue; set
  `connection.options.enableOfflineQueue: true` to restore that.
- A command that takes longer than 5 s on the owned connection (a very large `getJobs` range, for
  example) now rejects; raise `commandTimeoutMs`.

---

## [1.2.13] — 2026-11-12

No action required. Measured with `diff -r` of the unpacked 1.2.12 tarball against a fresh
`npm pack`, the files that differ are `README.md`, `CHANGELOG.md` and the `version` field of
`package.json`; `dist/` is byte-identical, so the public API, the declaration files and the peer
ranges are those of 1.2.12.

### Documentation

- **The bundle budgets are no longer misquoted.** The Testing section gave "server ≤ 18 KiB brotli,
  shared ≤ 2 500 B"; the gate sets 9 200 B and 440 B. The README now points at `pnpm size` instead of
  restating the numbers.
- **The tech stack names the real end-to-end dependency.** It listed `@testcontainers/redis`, which
  is not a dependency; the suite uses `testcontainers`.
- **The Quick Start no longer implies `isGlobal: true` is needed.** It is the default, so the option is
  gone from the snippet and the step says `QueueService` is injectable without it.
- **The connection-release claim covers only what the library opens.** In Mode A the shared client is
  yours and the library never closes it.
- **Mode A, Mode B and the connection budget are one Connections section**, the deduplication examples
  are one block, and the msgpackr entry is a short paragraph. API Reference and the error catalog now
  follow Testing, the tech stack is a badge row, and the Quick Start is numbered.
- **Removed what a reader of the package does not need:** a note about an internal test fixture, a
  history line about a BullMQ state, the pnpm 10 versus 11 narration, and the pointers to the technical
  specification.

---

## [1.2.12] — 2026-11-09

No action required. The public API, the declaration files and the peer ranges are unchanged
(`check-api-surface` reports no difference against 1.2.11); the runtime bundles (`index.mjs`,
`index.cjs`) differ in code, measured with `diff -r` of a fresh build against the unpacked 1.2.11
tarball. The package also ships a corrected README.

### Fixed

- **An outage on a connection the library opens no longer prints `[ioredis] Unhandled error event`
  to stderr.** In Mode B the owned connection listened for `error` only while it waited for
  `ready`, so until BullMQ built something on it (BullMQ adds its own listener to a client it is
  handed) a later outage reached ioredis with no listener, and ioredis wrote one line per
  reconnect attempt to raw stderr, outside the structured logger. The owned connection now keeps a
  listener for its whole life that logs through the module's logger. The same holds for the
  duplicate opened for each `QueueEvents` (BullMQ listens on its own copy, not on this one) and for
  the probe the Mode A check duplicates. Every error is logged as it arrives, with no throttling.
  A client you pass in Mode A is yours and the library adds no listener to it.

### Documentation

- **The README's Mode A example now compiles and runs.** It imported `CACHE_REDIS_CLIENT` from
  `@bymax-one/nest-cache`, a name that package does not export. The example now injects
  `ConnectionManager` and passes `cache.getClient()`, and says that `getClient()` is typed
  `Redis | Cluster` while Mode A takes a standalone `Redis`.

---

## [1.2.11] — 2026-11-06

Action required only if you extend or replace `QueueLifecycle`, or rely on the order in which the
library closes its resources: the producer side now closes after the HTTP server stops, see the Apply
note. Healthy use is unchanged. The public API and the peer ranges are unchanged; the declaration
files differ because `QueueLifecycle` now also implements `OnApplicationShutdown` (and in JSDoc).
Measured with `diff -r` of a fresh build against the unpacked 1.2.10 tarball, the runtime bundles
(`index.mjs`, `index.cjs`) differ in code.

### Fixed

- **A request still being served when the application closed could not enqueue.** NestJS runs every
  `onModuleDestroy` hook before it stops the HTTP server, and `QueueLifecycle` closed the flow
  producer, the cached queues and the library-owned Redis connection in that hook. A request that
  enqueued in the window between the two (a request in flight during `app.close()`, or a
  `SIGTERM` with shutdown hooks enabled) failed with `Connection is closed.` in Mode B. Those three
  resources are now released in `onApplicationShutdown`, which NestJS runs after the server has
  stopped. Consumption still stops first: workers drain within `shutdown.drainTimeoutMs`, then
  queue-events and the connections opened for workers and queue-events close, all in
  `onModuleDestroy`. `shutdown.drainOnShutdown` now runs in `onApplicationShutdown` too, right before
  the queues close, so a job enqueued late is drained with the rest. The log line `Queue shutdown
complete in Nms (forced N worker(s))` is now written once, at the end, and its time covers both
  hooks. In Mode A the consumer's client is untouched, as before.

### Changed

- **The shipped bundles no longer carry comments.** `dist/server/index.mjs` and `index.cjs` are
  smaller; the declaration files keep their JSDoc, and the comment removal does not change the
  runtime behaviour of the bundles.

### Documentation

- **The README describes the two shutdown hooks** and when each resource closes.

#### Apply to a derived backend

- If you subclass or wrap `QueueLifecycle`, or call `onModuleDestroy()` yourself to tear the library
  down in a test, also call `onApplicationShutdown()` afterwards: the flow producer, the cached
  queues and the library-owned connection are no longer closed by `onModuleDestroy()`. Nest calls
  both when the application closes.
- If you enqueue from a hook that runs after the library's `onModuleDestroy` (for example your own
  `beforeApplicationShutdown`), the enqueue now succeeds instead of failing with
  `Connection is closed.`; if you worked around that failure, the workaround can go.

---

## [1.2.10] — 2026-11-01

Action required only if code relies on the status of a failed schedule: `upsertJobScheduler` no
longer reports every failure as `INVALID_REPEAT_OPTIONS` (400), see the Apply note. Healthy use is
unchanged. The public API, the types (the declaration files differ only in JSDoc comments) and the
peer ranges are unchanged. Measured with `diff -r` of a fresh build against the unpacked 1.2.9 tarball,
the runtime bundles (`index.mjs`, `index.cjs`) differ in code.

### Fixed

- **A failed schedule write was reported as an invalid cron.** `upsertJobScheduler` turned every
  error without a string `code` into `INVALID_REPEAT_OPTIONS` (400, "pattern must be a valid cron
  expression"). A Redis reply error carries no `code`, so a replica refusing the write (`READONLY`),
  an out-of-memory server (`OOM`) or a missing login (`NOAUTH`) was reported as the caller's mistake,
  and the caller was told not to retry. The pattern is now checked first with BullMQ's own repeat
  strategy, a pure function with no Redis call, and only a pattern it refuses is
  `INVALID_REPEAT_OPTIONS`; every failure of the write itself reaches the caller as it is. A
  consumer-supplied `settings.repeatStrategy` replaces the parser, so the pattern is not checked.
  A malformed pattern on a schedule whose iteration `limit` is already reached is now rejected as
  well; BullMQ's own upsert returns before parsing such a schedule and silently accepts it.
- **A failing `@OnWorkerEvent` or `@OnQueueEvent` handler could end the process.** The listener was
  bound straight onto the emitter, which neither awaits it nor catches a throw: an async handler
  that rejected became an unhandled rejection, which ends a Node process by default, and a
  synchronous throw was re-emitted as `error`. The failure is now logged with the handler's name
  and the code `queue.event_handler_failed`, and the process carries on.
- **`drainOnShutdown` failed silently.** A queue whose drain failed kept its waiting jobs with no
  trace in the log; it now logs a warning naming the queue and the cause.
- **A worker whose close failed was logged as a drain timeout.** Any rejection of the graceful
  close was reported as "exceeded the drain budget"; a real error, such as a lost connection, now
  has its own message with the cause. The worker is force-closed either way.

### Documentation

- **A duplicate does not add a job.** The README and the JSDoc of `enqueue`, `enqueueBulk` and the
  flow methods now say that when a custom `jobId` already exists, or a `deduplication` rule keeps
  the job already there, BullMQ answers with the id of the existing job together with the data of
  this call, so the returned object does not describe what is stored; `getJob` returns it.
- **The scheduler and event-handler behaviour above is described in the README.**
- **Correction to 1.2.9.** On 1.2.8 only the `FlowProducer` listener could end the process; on
  `Queue`, `Worker` and `QueueEvents` BullMQ's wrapper re-emitted the `TypeError` and the error was
  reported with a misleading log line. 1.2.9 fixes both.

#### Apply to a derived backend

- If you branch on `INVALID_REPEAT_OPTIONS` to detect any failure of `upsertJobScheduler`, change
  it: a valid pattern whose write fails now throws the original error (a Redis reply error, a
  connection error), not a 400 `QueueException`. An unparseable pattern is still
  `INVALID_REPEAT_OPTIONS`, now thrown before Redis is asked.
- A listener that fails is now logged instead of ending the process. If something relied on the
  crash to stop a faulty deploy, watch for the log code `queue.event_handler_failed`.

---

## [1.2.9] — 2026-11-01

No action required: behaviour for an `Error` with a string `message` is unchanged, and the public API, the types
(`index.d.ts` and `index.d.cts` are identical) and the peer ranges are unchanged. Measured with
`diff -r` of a fresh build against the unpacked 1.2.8 tarball, only the two runtime bundles
(`index.mjs`, `index.cjs`) differ.

### Fixed

- **The fallback `error` listener no longer throws on an emission that is not an `Error`.** The
  listener the library attaches to every `Queue`, `Worker` and `QueueEvents`, and to the `FlowProducer` when flows are enabled, read
  `err.message` directly, so `emit('error', undefined)` or `emit('error', null)` threw a `TypeError`
  out of the listener, and out of `emit` to its caller, which can end the process. It now logs
  whatever value arrived, falling back to a fixed phrase for one it cannot print.
- **A rejected `enqueueBulk` with a non-`Error` reason still produces `BULK_ENQUEUE_FAILED`.**
  The cause was read with `(err as Error).message`, which threw a `TypeError` for a `null` or
  `undefined` rejection, replacing the typed exception; it now carries a string cause for any
  rejected value.

---

## [1.2.8] — 2026-11-01

No action required: behaviour, the public API, the types and the peer ranges are unchanged.
Measured with `diff -r` of a fresh build against the unpacked 1.2.7 tarball, `dist/` is identical;
the package otherwise changes in `README.md`, this file and the version in `package.json`.

### Documentation

- **The README now states how many Redis connections the library holds.** A new "Redis connections"
  section gives the budget measured against Redis 8: 1 for the module in Mode B and none of its own
  in Mode A, 2 per worker, 2 per queue observed with `@OnQueueEvent`, and none for producers and
  flows, all released on close. It carries a worked example (20 workers and 5 observed queues hold
  51 connections in Mode B) and a note on connection quotas of managed Redis plans.
- **The Mode B description of the connections was wrong.** It said the library opens one connection
  per worker and per observed queue; each of those holds two, a blocking connection and a command
  connection.

---

## [1.2.7] — 2026-10-31

Action required if your `connection.url` can be empty or malformed: an invalid or empty
`connection.url` now fails the boot with `INVALID_OPTIONS`; before 1.2.7 it silently connected to
`localhost:6379`. A valid `url` needs no change. The public API, the types (`index.d.ts` and
`index.d.cts` are identical) and the peer ranges are unchanged. Measured with `diff -r` of a fresh
build against the unpacked 1.2.6 tarball, only the two runtime bundles (`index.mjs`, `index.cjs`)
differ.

### Fixed

- **`connection.url` is now validated.** `forRoot` refuses a `url` that is not a non-empty string
  with `INVALID_OPTIONS` ("connection.url must be a non-empty string"). Before, `ioredis` read an
  absent, empty, whitespace-only, `null` or object `url` as no url at all and connected to
  `localhost:6379`, and a number as a port, so a missing `REDIS_URL` surfaced as a connection to the
  wrong server instead of an error. A string `ioredis` cannot parse (`not a url`, `redis://h:abc`)
  is refused the same way ("connection.url is not a valid Redis URL"), where it used to throw a raw
  `Invalid URL` from the client constructor. Unix socket paths, `host:port` and `redis://` /
  `rediss://` URLs, with or without `options`, are unaffected.
- **A worker that fails to start no longer hides the failure behind a second error.** The
  `WORKER_REGISTRATION_FAILED` details were built with `String(cause)`, which throws a `TypeError`
  for a null-prototype value; the cause is now described by a helper that cannot throw, so the
  registration failure reaches the caller as the typed exception.

---

## [1.2.6] — 2026-10-31

No action required: behaviour, the public API, the types and the peer ranges are unchanged.
Measured with `diff -r` of a fresh build against the unpacked 1.2.5 tarball, `dist/` is identical;
the package otherwise changes in `README.md`, this file and the version in `package.json`.

### Documentation

- **The README Quick Start now shows where `EmailService` and the processor are registered.** The
  `AppModule` snippet imports an `EmailModule` that lists both as providers, so a reader who copies
  the snippets in order ends with a module graph that resolves, instead of a service no module provides
  and a processor module the root never imports.

### Tests

- **The README Quick Start now runs.** A spec boots a Nest application context from the module
  options, the `QueueService` enqueue and the `@Processor` / `@Process` handler copied from the
  README (handler body aside), with BullMQ and ioredis replaced by in-memory doubles, and asserts
  the job the service enqueues is the job the decorated handler receives. The snippet gate only
  compiles the README; this executes it, so a wrong argument shape or an unresolved dependency fails
  a test.

---

## [1.2.5] — 2026-10-31

No action required: behaviour, the public API, the types and the peer ranges are unchanged.
Measured with `diff -r` of a fresh build against the unpacked 1.2.4 tarball, `dist/` differs in
one comment line only, the description of the `drainOnShutdown` step, which sits in the bundles
(`index.mjs`, `index.cjs`) and in the declarations (`index.d.ts`, `index.d.cts`); the package
otherwise changes in `README.md`, this file and the version in `package.json`.

### Documentation

- **Several statements in `README.md` described behaviour the code does not have.** The prose and the
  tables were checked against the source, which the snippet gate does not do:
  - `shutdown.drainOnShutdown` was described as waiting for the queue to drain. It calls `drain()`
    on every cached queue after the workers close, which removes the waiting jobs, so it is for
    development and tests only.
  - `@OnQueueEvent` was said to need `queueEvents: { enabled: true }`. No such option exists; the
    library opens the `QueueEvents` connection when it discovers the first listener.
  - Graceful Shutdown named `onApplicationShutdown`; `QueueLifecycle` runs from `onModuleDestroy`.
  - The Troubleshooting entry for `CONNECTION_REQUIRES_NULL_RETRIES` told Mode A users to pass a
    client built with `maxRetriesPerRequest: null`. Worker connections are `duplicate()` calls that
    force it, so a stock ioredis client never triggers the error; the entry now says so.
  - The stuck-jobs entry pointed `lockDuration` at `workerOptions` (the `options` of `@Processor`
    and `register` are what a consumer sets) and at a `maxStalledCount` setting the library does not
    expose.
  - The Testing section and the badge quoted a mutation score of 99.68% against `break 95`; the
    suite is held at 100.00% against `break 100`. The shared bundle budget is 2 500 B, not 2.5 KiB, and the gate
    chain now includes `pnpm check:published`.
  - `QueueException.details` was described by four keys; it carries more, always scalar. The
    `cleanQueue` row named its second parameter `graceMs`, which is `gracePeriodMs`.

- A warning callout under the Configuration table now says plainly that `shutdown.drainOnShutdown`
  deletes the waiting jobs of every queue the process created and must not be enabled
  in production; the table cell alone was easy to miss.

- **Two README examples did not compile against the published types.** The OpenTelemetry example
  built `new BullMQOtel('my-service', tracer)`, the `bullmq-otel` 1.x signature; the `^2` peer takes
  an options object, so it is now `new BullMQOtel({ tracerName: 'my-service' })`. The
  `WorkerRegistry.register` example passed `processor:`; the property is `handler`. Two fragments
  also used `path` and `Module` without importing them.

- **Further README statements were wrong, and the exports nothing described are now listed.** The
  Configuration table said that injecting `FlowService` or `MetricsService` while disabled throws;
  both are always provided and every method throws `FLOW_DISABLED` or `METRICS_DISABLED`, except
  `FlowService.close()`, which is a no-op while flows are disabled. The
  `@OnQueueEvent` example declared `(jobId, returnValue)`, but the handler receives one serialized
  payload object (`completed` carries `{ jobId, returnvalue, prev? }`), so the example and the prose
  above it now say so. An "Other exports" table now covers the exports the README never named.

### Tests

- `pnpm check:published` now fails on a wrong method, option or field anywhere in the README.
  It reads syntactic and semantic diagnostics together, compiles every snippet, not only those
  that import the package, types the names the prose introduces in
  `scripts/readme-prelude.d.ts`, resolves a relative import to the snippet that exports it and
  fails one that no snippet satisfies. The prelude is compiled as a `.ts` file, so a type in it that
  stops resolving is an error instead of `any`, and no syntax error is tolerated: a snippet that
  shortens an example with a bare `...` fails and is written out in full.
- The Mode A null-retries probe is exercised with real ioredis clients: a stock client with finite
  retries is accepted, a client whose `duplicate()` ignores the override is refused with
  `CONNECTION_REQUIRES_NULL_RETRIES`, the probe is closed in both cases, and BullMQ itself refuses
  a Worker on the connection the probe rejected.
- A spec fails when a name exported from `src/server/index.ts` or `src/shared/index.ts` is not
  named in the README, so an export nobody documented cannot ship unnoticed again.
- The README's option-defaults table and error-code catalog are now parsed and compared with
  `applyDefaults`, `DEFAULT_JOB_OPTIONS` and `QUEUE_ERROR_CODES`, so a default or a code that drifts
  fails the suite instead of reaching the npm page.

---

## [1.2.4] — 2026-10-30

No action required: behaviour, the public API, the types and the peer ranges are unchanged.

The status codes a `QueueException` carries are the same as in 1.2.3, but the bundle under `dist/`
is not byte-identical, and the differences are listed below so a reader does not have to take
"no change" on trust.

### Changed

- `QueueException` is now thrown with the named `HttpStatus` members (`BAD_REQUEST`,
  `INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE`) instead of the numbers 400, 500 and 503, at every
  call site. The values are the same; the change satisfies `no-unsafe-enum-assignment`. Against a
  fresh build of 1.2.3, the CommonJS bundle is identical once those members are replaced by their
  numeric values, the ES module bundle differs only in the order of its `@nestjs/common` imports and
  in line wrapping, and the type declarations differ in one JSDoc line (`FlowService`, which now
  names `HttpStatus.SERVICE_UNAVAILABLE`).

### Security

Not shipped:

- Dependency resolution of the tooling the repository builds and tests with was raised to patched
  versions: `fastify`, `undici`, `fast-uri`, `js-yaml`, `brace-expansion`, `qs`, `zod`,
  `handlebars`, `@grpc/grpc-js` and `@nestjs/platform-fastify`. None of these ships in the package,
  which still declares `"dependencies": {}`; they reach it only through development and example-app
  tooling.
- `osv-scanner.toml` ignores `GHSA-gcqx-w48m-w2h4` (`deepmerge` 4.3.1, no patched release) until
  2027-01-27. The package is reached only through `jest-config`, a development dependency.

### Documentation

- The README supply-chain wording now says that third-party GitHub Actions are pinned to a commit SHA,
  which is what the workflows do; the organisation's own reusable workflows follow a version tag.

### Internal

Not shipped:

- Tests kill the four mutants that survived the full mutation run, and the one equivalent mutant is
  disabled in place with the reason beside it. The mutation score is 100%.
- The README snippet check (`scripts/check-published-surface.mjs`) decides whether a snippet
  declares a receiver from the parsed snippet rather than from its text, so decorated constructor
  parameters, object-literal keys and JSX are classified correctly.
- Development and GitHub Actions dependencies were updated (Stryker, Jest, ts-jest, Prettier,
  typescript-eslint, testcontainers, NestJS 11.2.x, and the CodeQL, pnpm, harden-runner, TruffleHog
  and setup-node actions).
- The shared review-rules block in `AGENTS.md` was synchronised with its canonical copy.
- `SECURITY.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md` and the mutation-testing documents were
  brought in line with the current configuration.

---

## [1.2.3] — 2026-09-05

**Nothing that runs in this package changed.** A fresh build of the release commit was packed and
compared against the published 1.2.2 tarball: `dist/` is identical file for file, and `package.json`
differs only in the version string. The remaining difference is this CHANGELOG entry, which ships
because `CHANGELOG.md` does.

It exists because the estate releases on a cadence, so a library whose artifact is unchanged
publishes anyway and says so rather than implying a benefit it does not deliver. **There is no
reason to upgrade from 1.2.2**, and a consumer on `^1.2.0` gains nothing by resolving to it.

### Internal

Not shipped — `files` is `dist`, `LICENSE`, `README.md`, `CHANGELOG.md`, and the only file touched
since 1.2.2 is `AGENTS.md`:

- The shared review-rules block was synchronised with its canonical copy, bringing in an invariant
  for keys built from more than one field — the generalised form of the deduplication defect this
  package corrected in 1.2.2.
- Two repository-specific review rules were corrected: one rested its case on a defect that had
  since been fixed, so the claim had become false; the other required an authorship finding to
  quote a resolvable commit id, a criterion the shared block superseded by placing author and
  committer identity out of scope entirely.

## [1.2.2] — 2026-09-04

**1.2.1 was tagged but never published**, so this release carries its documentation fix as well
as the one below. `dist/` changes here for the first time since 1.2.0 — JSDoc reaches the emitted
`.d.ts`, so a doc-block correction is a change to the published types.

### Fixed

- **The `enqueue` deduplication example asserted a safety property it did not provide.** It showed
  `` `${tenantId}:reindex:${term}` `` and stated that "one tenant's term cannot suppress another's".
  Two variable fields joined by a delimiter either may contain do not produce a unique key: with
  `` `${tenantId}:${term}` ``, the pairs `('a', 'b:c')` and `('a:b', 'c')` both yield `a:b:c`. The
  guidance now percent-encodes every variable field, and the claim states what the construction
  delivers. This is documentation a consumer copies into their own key-building code, which is why
  the shape mattered more than whether `:reindex:` in particular was reachable.
- Carried from 1.2.1: **the `MetricsService` example in `README.md` called two methods that do not
  exist**, `getMetrics(name)` and `getAll([names])`, where the service exposes `get(name)` and a
  no-argument `getAll()`.

### Internal

Not shipped, listed because the tag covers them: bullmq raised from 6.0.10 to 6.3.4 in the
workspace override; `fast-uri`, `qs` and `fastify` floors raised past published advisories; the
README-snippet gate now type-checks through receivers; `AGENTS.md` and its sync workflow added.

## [1.2.1] — 2026-08-30

Documentation only. `dist/` is byte-identical to `1.2.0`; the published tarball was unpacked and
diffed against a fresh build to confirm it rather than assert it. The release exists because
`README.md` ships inside the package, so a fix that stays on `main` leaves the npm page — where
the example is actually read — still wrong.

### Fixed

- **The `MetricsService` example in `README.md` called two methods that do not exist.** It showed
  `getMetrics(name)` and `getAll([names])`; the service exposes `get(name)` and a no-argument
  `getAll()` returning `readonly QueueMetrics[]` for every queue currently cached by
  `QueueService`. Code copied from that example failed to compile, and the wrong `getAll` signature
  also implied a per-call queue filter the API does not offer. Every other call in the README was
  checked against the source in the same pass and is correct.

## [1.2.0] — 2026-08-10

**Breaking, shipped as a minor by choice.** The peer ranges move to the next major of each
Redis/BullMQ package and the `'paused'` job state is removed from the public status surface —
changes that would normally warrant a major. They ship under a minor because the package has no
downstream consumer yet; every breaking detail is called out below so a first adopter sees it.

### Changed

- **Peer dependencies migrated to the next major:** `bullmq` `^5` → `^6`, `bullmq-otel` `^1` →
  `^2`, and `ioredis` `^5` → `^6`. A consumer must upgrade all three together. `ioredis` 6 keeps
  `'legacy'` reply mapping by default, so BullMQ's reply-shape assumptions are unaffected; it does
  require Node.js ≥ 20, already covered by this package's `engines`.

### Removed

- **`'paused'` is no longer a job status.** BullMQ 6 dropped `'paused'` from its job-state set —
  jobs on a paused queue now live in `'wait'`. It is therefore removed from the `JobStatus` union,
  from the `JOB_STATUS` constant (`JOB_STATUS.PAUSED` no longer exists), and from the
  `getMetrics().counts` shape, which now reports the five remaining statuses (`waiting`, `active`,
  `completed`, `failed`, `delayed`). The queue-lifecycle `'paused'`/`'resumed'` **events**
  (`@OnQueueEvent`) and the `pauseQueue`/`resumeQueue` methods are unchanged — those describe the
  queue, not a job.

### Internal

- Dev-tooling bumps: `eslint` `^10`, `typescript` `^6`, `@types/node` `^26`, plus `@eslint/js`
  `^10`. These do not ship and do not change `dist/`. The package's `engines` stays at Node ≥ 24.
- Mutation gate tightened: Stryker `break`/`high` raised from 95/99 → **100** (the run is at 100%,
  0 survivors).

## [1.0.11] — 2026-08-10

**Documentation only.** The shipped declaration comments change (`dts` preserves them); no runtime
code changed.

### Fixed

- The deduplication example — in the `QueueService` JSDoc and in
  `docs/technical_specification.md` — now scopes the dedup `id` by tenant
  (`` `${tenantId}:reindex:${term}` ``). The `id` is a shared key across the queue, so a
  multi-tenant producer keying on the value alone lets one tenant's enqueue suppress another
  tenant's job for the same value; the example previously demonstrated exactly that.

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

[Unreleased]: https://github.com/bymaxone/nest-queue/compare/v1.2.15...HEAD
[1.2.15]: https://github.com/bymaxone/nest-queue/compare/v1.2.14...v1.2.15
[1.2.14]: https://github.com/bymaxone/nest-queue/compare/v1.2.13...v1.2.14
[1.2.13]: https://github.com/bymaxone/nest-queue/compare/v1.2.12...v1.2.13
[1.2.12]: https://github.com/bymaxone/nest-queue/compare/v1.2.11...v1.2.12
[1.2.11]: https://github.com/bymaxone/nest-queue/compare/v1.2.10...v1.2.11
[1.2.10]: https://github.com/bymaxone/nest-queue/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/bymaxone/nest-queue/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/bymaxone/nest-queue/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/bymaxone/nest-queue/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/bymaxone/nest-queue/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/bymaxone/nest-queue/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/bymaxone/nest-queue/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/bymaxone/nest-queue/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/bymaxone/nest-queue/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/bymaxone/nest-queue/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/bymaxone/nest-queue/compare/v1.0.11...v1.2.0
[1.0.11]: https://github.com/bymaxone/nest-queue/compare/v1.0.10...v1.0.11
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
