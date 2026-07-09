# CLAUDE.md — @bymax-one/nest-queue

Agent guidance for `@bymax-one/nest-queue`. Read the canonical docs before coding.

---

## Required reading

Before making any change, read these sections (use `Read` with `offset`/`limit` — the files are large):

| Document | When to read |
|---|---|
| `docs/technical_specification.md` | Architecture, API contracts, design decisions |
| `docs/development_plan.md` §1.2 | Guiding principles and coding standards |
| `docs/tasks/` (relevant phase file) | Per-task acceptance criteria and agent prompt |

---

## Universal rules (TypeScript track)

- **TypeScript strict** — `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; zero `any`; no `@ts-ignore`, no `eslint-disable`.
- **JSDoc on every export** — every `export` (class, function, interface, constant) carries JSDoc with `@example` where applicable.
- **`@fileoverview` + `@layer` header** on every source file.
- **English-only, timeless comments** — no language other than English in identifiers, comments, JSDoc, or error messages; no roadmap/phase/task references in runtime source, user-facing docs (README/JSDoc), or `.github/**` config. The planning docs under `docs/` (spec, plan, task files) intentionally track phases and are exempt.
- **Functions ≤ 50 lines, files ≤ 800 lines** — split by responsibility when over the limit.
- **Conventional Commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`. No `Co-Authored-By` or attribution trailers.
- **No new runtime dependencies** — `package.json` ships `"dependencies": {}`. Everything via peer dep.
- **Official docs first** — before coding against any library/SDK/CLI (BullMQ, ioredis, NestJS), verify the current API via `context7`. Trained memory goes stale.

---

## BullMQ API rules

- Recurring jobs go through `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` **only** — never `addRepeatable`/`removeRepeatable` (removed in BullMQ v6).
- `maxRetriesPerRequest: null` is applied **only** to worker/QueueEvents connections (via `duplicate()`); the Queue/FlowProducer connection keeps default retries.
- Cron patterns are validated by BullMQ's own `cron-parser` — never a hand-rolled regex.

---

## Quality gates (run after every change)

```bash
pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size
```

100% line/branch coverage on every implemented file is a hard gate. Mutation testing runs automatically post-merge on `main` via the shared reusable (`bymaxone/.github` → node-lib-ci) plus an optional manual `pnpm mutation`.

---

## Public API surface

The public surface is frozen at what `src/server/index.ts` and `src/shared/index.ts` export. Do not add or remove exports without a deliberate versioned decision.
