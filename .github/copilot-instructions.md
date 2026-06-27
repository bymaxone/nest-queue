# Copilot Review Instructions — @bymax-one/nest-queue

This file configures GitHub Copilot code review for the `@bymax-one/nest-queue` repository.

## Project context

A public NestJS dynamic module wrapping BullMQ. Peer deps: `@nestjs/common ^11`,
`@nestjs/core ^11`, `bullmq ^5.16`, `ioredis ^5`, `reflect-metadata ^0.2`; optional
`bullmq-otel ^1`. Zero runtime dependencies (`dependencies: {}`). Node >= 24, pnpm 11.

## Critical rules (block any PR that violates these)

- **No `any`** in TypeScript source. Use `unknown` with type guards instead.
- **No `@ts-ignore`, `@ts-expect-error`, or `eslint-disable`** in source files.
- **No new entries in `dependencies`** — all packages must be peer or dev.
- **No `addRepeatable`/`removeRepeatable`** — use `upsertJobScheduler` only.
- **`maxRetriesPerRequest: null` only on worker/QueueEvents connections** — never on Queue.
- **No secrets, tokens, or credentials** in any committed file.
- **No hardcoded connection strings** — all config via injected options.

## Code quality rules

- Functions must be ≤ 50 lines; files ≤ 800 lines.
- Every exported symbol must carry JSDoc (`@param`, `@returns`, `@example`).
- Every source file must have an `@fileoverview` + `@layer` header.
- English-only identifiers, comments, and JSDoc.
- Conventional Commits format enforced by `commitlint.config.cjs`.

## Test rules

- 100% line and branch coverage on every implemented file.
- Tests must be deterministic — no `Date.now()` or `Math.random()` without mocking.
- No fake mocks that hide real branches; test the actual behavior.

## BullMQ-specific

- Recurring jobs via `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` only.
- Workers must use `maxRetriesPerRequest: null` via `duplicate()`.
- Cron patterns validated by BullMQ, not a hand-rolled regex.
