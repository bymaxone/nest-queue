# Copilot Review Instructions — @bymax-one/nest-queue

Organization baseline followed by this repository's domain rules. Path-specific
rules live alongside this file:

- `.github/instructions/code.library.instructions.md` — the publishable library source
- `.github/instructions/tests.instructions.md` — test suites
- `.github/agents/agent-code-reviewer.agent.md` — the reviewer agent definition

---

## Universal core (Bymax org baseline)

### CRITICAL — block the PR

- **Zero `any`** (`any`, `as any`) in TypeScript; use `unknown` with type guards.
- **No suppression comments** without a written justification: `@ts-ignore`,
  `@ts-expect-error`, `eslint-disable`.
- **No secrets, tokens, or credentials** in any committed file — only local/dev
  fixtures (test values). **Never log** secrets, tokens, or PII.
- The transport layer **maps internal errors to a stable envelope** and never
  leaks an internal error string to the client.

### HIGH — block unless justified

- Every exported symbol carries **JSDoc** (with an `@example` where non-trivial).
- **Functions ≤ 50 lines; files ≤ 800 lines**; one responsibility per unit.
- **100% coverage** (statements, branches, functions, lines) on files that carry
  logic; non-executable glue is out of scope.
- **Reuse `@bymax-one/*` libraries verbatim** — never reimplement a shared capability.

### MEDIUM — flag for discussion

- **Conventional Commits**; never a `Co-Authored-By` or any AI-attribution trailer.
- **English-only, timeless** comments and identifiers — describe what the code does
  and why, never which roadmap step or task produced it.
- **Mutation-aware tests** — no generic matchers (`toBeDefined()`, `toBeTruthy()`)
  where a concrete value assertion is possible.

---

## Repository context

A public NestJS dynamic module wrapping BullMQ. Peer deps: `@nestjs/common ^11`,
`@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata ^0.2`; optional
`bullmq-otel ^1`. Zero runtime dependencies (`dependencies: {}`). Node >= 24, pnpm 11.
Two subpaths: `.` (server) and `./shared` (dependency-free types and constants).

## Domain rules — queueing correctness

These are the failures this library exists to prevent. Each one is silent: nothing
throws, and the symptom appears far from the cause.

- **Job Schedulers only.** Recurring jobs go through `upsertJobScheduler` /
  `removeJobScheduler` / `getJobSchedulers`. `addRepeatable` and `removeRepeatable`
  were removed in BullMQ v6 — flag any reintroduction.
- **Cron is validated by BullMQ's own parser**, never a hand-rolled regex, and
  `cron-parser` is never added as a direct dependency.
- **`maxRetriesPerRequest: null` belongs only to the duplicated Worker and
  QueueEvents connections.** Applying it to the Queue or FlowProducer connection
  turns a Redis outage into a hanging producer instead of a fast failure.
- **The configured `prefix` must reach `Queue`, `Worker`, `QueueEvents` _and_
  `FlowProducer`.** A prefix applied to only some of them splits producers and
  consumers onto separate keyspaces: jobs are enqueued and never consumed, with
  no error anywhere.
- **Explicit `@Inject` on every injectable constructor parameter.** The library
  ships as bundled ESM+CJS, where emitted design-time metadata cannot be relied
  on; implicit token resolution breaks inside a consumer's build.
- **Job data is opaque** — never deep-merged (prototype-pollution guard) and never
  written to a log line or an exception `details` payload.

## Domain rules — supply chain and packaging

- **`dependencies` stays `{}`.** Adding a runtime dependency is a breaking change
  to the supply-chain contract.
- **`@nestjs/bullmq` is never imported** — this library fills that role.
- **The `exports` map declares `types` per condition.** `require` must resolve to
  `.d.cts` and `import` to `.d.ts`; a single shared `types` key hands ESM
  declarations to a CommonJS consumer. The `pnpm check:exports` gate enforces it.
- **Connection strings come from injected options**, never `process.env` directly,
  and are masked before reaching a log line or an error message.

## Local gates a PR must pass

```
pnpm typecheck && pnpm test:types && pnpm lint && pnpm test:cov:all && \
  pnpm build && pnpm size && pnpm check:exports && pnpm smoke
```
