# Contributing to @bymax-one/nest-queue

Thank you for your interest in contributing! This document describes the workflow
and quality gates for this library. By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting security issues

**Do not open public issues for security vulnerabilities.** Follow the private
reporting process described in [SECURITY.md](./SECURITY.md). A leaked Redis
credential, a way to make one tenant's jobs land in another tenant's keyspace, or
a path that lets job data escape into a log line is a security report, not a bug
report.

## Prerequisites

- Node.js >= 24
- pnpm 11 (`corepack enable`)
- Docker — required only for the E2E suite, which starts a real Redis via
  Testcontainers

## Getting started

```bash
pnpm install
pnpm build
```

## Development workflow

This is a published npm library, not an application. Keep `dependencies` empty —
`bullmq`, `ioredis`, `@nestjs/*` and `reflect-metadata` all arrive as peer
dependencies so the consumer controls the exact versions and the supply-chain
surface stays minimal. Conventions live in [CLAUDE.md](./CLAUDE.md) and
[AGENTS.md](./AGENTS.md); the architecture is in
[docs/technical_specification.md](./docs/technical_specification.md).

1. Create a branch from `main`.
2. Make your change; add or update co-located `*.spec.ts` tests (TDD — 100%
   coverage is a hard gate, not a target). Mock BullMQ and ioredis in unit tests —
   a real Redis connection belongs in the E2E suite, never in a unit test.
3. If you change or add a public type, update `test/types/public-api.test-d.ts`:
   the published signatures are part of the contract.
4. Run the full verification suite before opening a PR.

### Invariants a change must preserve

- **Job Schedulers only.** Recurring jobs go through `upsertJobScheduler` /
  `removeJobScheduler` / `getJobSchedulers`. `addRepeatable` and
  `removeRepeatable` were removed in BullMQ v6 and must never be reintroduced.
- **Cron is validated by BullMQ's own parser**, never by a hand-rolled regex — a
  regex accepts patterns the scheduler then silently refuses to fire.
- **`maxRetriesPerRequest: null` is applied only to Worker and QueueEvents
  connections**, via `duplicate()`. The Queue and FlowProducer connection keeps
  ioredis' default retry policy so a producer fails fast instead of hanging a
  request.
- **The configured `prefix` reaches every BullMQ object** — `Queue`, `Worker`,
  `QueueEvents` and `FlowProducer`. A prefix applied to only some of them splits
  producers and consumers onto separate keyspaces, and nothing fails loudly: jobs
  are simply never consumed.
- **Explicit `@Inject` on every injectable constructor parameter.** The library
  ships as bundled ESM+CJS where emitted design-time metadata cannot be relied on;
  implicit token resolution breaks in a consumer's build.
- **No runtime dependencies.** Everything is a peer dependency or a `node:`
  builtin.

## Verification — run before every PR

```bash
pnpm typecheck && pnpm test:types && pnpm lint && pnpm test:cov:all && \
  pnpm build && pnpm size && pnpm check:exports && pnpm smoke
```

All of the following must pass:

- **Typecheck** — `tsc --noEmit` (strict, zero errors)
- **Type API** — `test/types/` compiles, locking the published signatures
- **Lint** — ESLint (zero `any`, no suppression comments)
- **Coverage** — 100% statements / branches / functions / lines
- **Build** — tsup produces ESM + CJS + `.d.ts` + `.d.cts` for every subpath
- **Size** — every subpath stays within the budget in `scripts/check-size.mjs`
- **Exports** — `attw` resolves every entrypoint correctly in ESM and CJS
- **Smoke** — the packed tarball resolves from a real consumer in both formats

The E2E suite (`pnpm test:e2e`) needs Docker and runs against a real Redis; CI
runs it on every PR.

Mutation testing (`pnpm mutation`) is a **release gate**, run on a push to `main`
and manually before tagging a version — never on every PR.

## Commits — Conventional Commits

Commit messages are validated by commitlint via the `commit-msg` hook:

```
<type>(<scope>): <subject>
```

Types: `feat | fix | docs | refactor | perf | test | build | ci | chore | revert`.
The `pre-commit` hook runs lint-staged (ESLint + Prettier on staged files).

## Pull requests

- Keep PRs focused and small.
- Record user-facing changes under the `Unreleased` section of `CHANGELOG.md`.
- All CI checks (`ci`, `codeql`, `scorecard`, `osv-scanner`) must be green.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
