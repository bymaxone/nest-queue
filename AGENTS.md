# AGENTS.md — @bymax-one/nest-queue

Agent guidance for `@bymax-one/nest-queue`. This file mirrors `CLAUDE.md` and applies to all agent frameworks (Anthropic Claude, OpenAI Codex, GitHub Copilot Workspace, and similar tools).

---

## Required reading

Before making any change, read these sections (use partial-read tools where available — the files are large):

| Document | When to read |
|---|---|
| `docs/technical_specification.md` | Architecture, API contracts, design decisions |
| `docs/development_plan.md` §1.2 | Guiding principles and coding standards |
| `docs/tasks/` (relevant phase file) | Per-task acceptance criteria |

---

## Universal rules

- **TypeScript strict** — `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; zero `any`; no `@ts-ignore`, no `eslint-disable`.
- **JSDoc on every export** — every `export` (class, function, interface, constant) carries JSDoc with `@example` where applicable.
- **`@fileoverview` + `@layer` header** on every source file.
- **English-only, timeless comments** — no language other than English; no roadmap/phase/task references in committed code or docs.
- **Functions ≤ 50 lines, files ≤ 800 lines** — split by responsibility when over the limit.
- **Conventional Commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`. No `Co-Authored-By` or attribution trailers.
- **Zero runtime dependencies** — `package.json` ships `"dependencies": {}`.
- **Official docs first** — verify the current API via authoritative sources before coding.

---

## BullMQ rules

- Recurring jobs: `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` **only** — never `addRepeatable`/`removeRepeatable`.
- `maxRetriesPerRequest: null` is applied **only** to worker/QueueEvents connections.
- Cron patterns delegated to BullMQ's `cron-parser` — no hand-rolled regex.

---

## Quality gates

```bash
pnpm typecheck && pnpm lint && pnpm test:cov:all && pnpm build && pnpm size
```

100% line/branch coverage on every implemented file is a hard gate on every PR.

---

## Public API surface

The public surface is frozen at `src/server/index.ts` and `src/shared/index.ts`. Do not add or remove exports without a deliberate versioned decision.
