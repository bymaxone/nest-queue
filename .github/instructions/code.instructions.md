---
applyTo: "src/**/*.ts"
---

# Code Review Instructions — @bymax-one/nest-queue

## TypeScript strict rules

- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are active.
- Zero `any` — use `unknown` with type guards; use generic parameters for typed APIs.
- No `@ts-ignore` or `@ts-expect-error` in source; no `eslint-disable` comments.
- Import types with `import type { … }` when the value is not used at runtime.

## Architecture rules

- Every source file must carry an `@fileoverview` and `@layer` JSDoc header.
- Every exported symbol must carry JSDoc. Include `@param`, `@returns`, and `@example`.
- Functions must be ≤ 50 lines; files must be ≤ 800 lines.
- One responsibility per file and function; split when the limit is approached.
- Follow the layered dependency order: `shared` < `server/config` < `server/utils`
  < `server/services` < `server/decorators` < `server/lifecycle` < `server/index`.

## BullMQ API rules

- Recurring jobs must use `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers`.
- Never use `addRepeatable`/`removeRepeatable` — these are removed in BullMQ v6.
- `maxRetriesPerRequest: null` applies only to worker/QueueEvents connections via `duplicate()`.
- Cron validation is delegated to BullMQ's `cron-parser`; do not add `cron-parser` as a dep.
- Job data is treated as opaque — never deep-merge objects (prototype-pollution guard).

## Dependency rules

- `package.json.dependencies` must remain `{}` — zero runtime dependencies.
- All packages must be peer or optional-peer deps.
- Do not import `@nestjs/bullmq` — this library provides that role.

## Security rules

- No secrets, tokens, or credentials in any file.
- Connection strings must come from injected options, never from `process.env` directly.
- Connection strings must be masked before logging or error messages.

## Style rules

- English-only identifiers, comments, JSDoc, and error messages.
- Timeless content — no roadmap/task references in committed code or docs.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
