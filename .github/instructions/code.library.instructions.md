---
applyTo: 'src/**/*.ts,package.json'
---

# Code Review Instructions — @bymax-one/nest-queue (publishable library)

## Supply-chain contract

- **`dependencies` in `package.json` stays empty** — everything runtime is a
  `peerDependency`. Adding a real dependency is a breaking change to the
  supply-chain contract; flag it.
- The **subpath export model** is authoritative: the root (`.`) is server-only;
  dependency-free types and constants ship under `./shared`. Nothing under
  `src/shared/` may import `bullmq`, `ioredis`, or `@nestjs/*`.
- The `exports` map declares **`types` per condition** — `require` resolves to
  `.d.cts`, `import` to `.d.ts`. A single shared `types` key hands ESM
  declarations to a CommonJS consumer.
- Do not import `@nestjs/bullmq` — this library provides that role.

## NestJS shape

- Dynamic module via `forRoot` + `forRootAsync({ useFactory, useClass, useExisting })`.
- **DI injection tokens are `Symbol()`**, never string literals — string tokens
  collide silently across modules.
- **Every injectable constructor parameter carries an explicit `@Inject`.** The
  package ships bundled, where emitted design-time metadata cannot be relied on.
- Ports are `interface`; unions are `type`. Singletons only; no `console.*` in `src/`.

## TypeScript

- `strict` with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`.
- **Zero `any`** — use `unknown` with type guards; generics for typed APIs.
- Import types with `import type { … }` when the value is not used at runtime.
- No suppression comments without a written justification.
- Every exported symbol carries JSDoc with `@param`, `@returns`, and an
  `@example` where non-trivial. Every file carries `@fileoverview` + `@layer`.
- Functions ≤ 50 lines; files ≤ 800 lines; one responsibility per unit.
- Layered dependency order: `shared` < `server/constants` < `server/config`
  < `server/utils` < `server/services` < `server/decorators` < `server/lifecycle`
  < `server/index`.

## BullMQ API rules

Each of these failures is silent — nothing throws, and the symptom surfaces far
from the cause.

- Recurring jobs use `upsertJobScheduler` / `removeJobScheduler` /
  `getJobSchedulers`. **Never `addRepeatable` / `removeRepeatable`** — removed in
  BullMQ v6.
- Cron validation is delegated to BullMQ's `cron-parser`; never a hand-rolled
  regex, and `cron-parser` is never added as a direct dependency.
- `maxRetriesPerRequest: null` applies **only** to the duplicated Worker and
  QueueEvents connections. On the Queue or FlowProducer connection it turns a
  Redis outage into a hanging producer instead of a fast failure.
- The configured `prefix` must reach **`Queue`, `Worker`, `QueueEvents` and
  `FlowProducer`**. Applied to only some of them, producers and consumers land on
  separate keyspaces and jobs are never consumed.
- Job data is opaque — never deep-merged (prototype-pollution guard).

## Security rules

- No secrets, tokens, or credentials in any file.
- Connection strings come from injected options, never `process.env` directly,
  and are masked before reaching a log line or an error message.
- `QueueException.details` carries only scalar configuration values — never
  `job.data`, a connection string, or a password.

## Style rules

- English-only identifiers, comments, JSDoc, and error messages.
- Timeless content — no roadmap/task references in committed code or docs.
- Conventional Commits; never a `Co-Authored-By` or AI-attribution trailer.
