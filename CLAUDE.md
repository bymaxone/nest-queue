# CLAUDE.md — @bymax-one/nest-queue

Agent guidance for `@bymax-one/nest-queue`. Read the canonical docs before coding.

---

## Required reading

Before making any change, read these sections (use `Read` with `offset`/`limit` — the files are large):

| Document                            | When to read                                  |
| ----------------------------------- | --------------------------------------------- |
| `docs/technical_specification.md`   | Architecture, API contracts, design decisions |
| `docs/development_plan.md` §1.2     | Guiding principles and coding standards       |
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
- Every BullMQ emitter the library constructs — `Queue`, `Worker`, `QueueEvents`, `FlowProducer` — gets a fallback `error` listener. These extend `EventEmitter`, where emitting `'error'` with no listener **throws**, so an emitter the consumer never asked for would crash their process on a transient Redis fault.
- `QueueLifecycle` is the ONLY class exposing `onModuleDestroy`. NestJS binds lifecycle hooks by method name, not by `implements`, so a collaborator with one runs on Nest's schedule and races the bounded drain. Collaborators expose `closeAll` / `close` / `teardown` instead.
- The configured `prefix` must reach **`Queue`, `Worker`, `QueueEvents` and `FlowProducer`**. BullMQ defaults an omitted prefix to `bull`, so applying it to only some of them puts producers and consumers on separate keyspaces — jobs are enqueued and never consumed, with nothing thrown anywhere.
- Every injectable constructor parameter carries an explicit `@Inject(TOKEN)`. The package ships as an esbuild bundle, which does not emit `design:paramtypes`, so reflection-based resolution works in this repo's tests and fails in a consumer's build.

---

## Quality gates (run after every change)

```bash
pnpm typecheck && pnpm test:types && pnpm lint && pnpm test:cov:all && \
  pnpm build && pnpm size && pnpm check:exports && pnpm check:published && pnpm smoke
```

100% line/branch coverage on every implemented file is a hard gate. Mutation testing runs automatically post-merge on `main` via the shared reusable (`bymaxone/.github` → node-lib-ci) plus an optional manual `pnpm mutation`.

- **`test:types`** compiles `test/types/public-api.test-d.ts`, which pins the published signatures. A new export, a new generic parameter, or a new union member belongs there.
- **`check:exports`** runs `attw` against the packed tarball. It must **not** be added to `prepublishOnly`: attw packs the tarball itself, and the nested pack inside `pnpm publish` fails with `ENOENT`.
- **`check:published`** scaffolds a throwaway consumer, symlinks the package into its own `node_modules` so resolution runs through the `exports` map into `dist/`, and then verifies three things. The README's links resolve and its internal anchors match real headings. The README's TypeScript snippets **and** `test/types/` compile against the built package — `test:types` maps the package to `./src` through tsconfig `paths` and can never see a divergence between the source and the published `.d.ts`, which is where the exported-type defect corrected in `1.0.4` lived. And every `v*.*.*` tag has a `## [x.y.z]` CHANGELOG section, tags being an outside source of truth the file cannot contradict about itself. Each check exists because its absence let a defect reach npm.
  It also runs inside `prepublishOnly`, so a manual `pnpm publish` cannot bypass it. Unlike `check:exports` it does not pack a tarball, so the nested-pack problem does not apply. In CI the job must check out with `fetch-depth: 0`, or the tag cross-check finds nothing and passes silently.
- **`smoke`** resolves the tarball from a real consumer in ESM _and_ CJS. It is the only gate that exercises the **built** artifact, so it is what catches DI or `exports` defects the source-based suite cannot see.

---

## Public API surface

The public surface is frozen at what `src/server/index.ts` and `src/shared/index.ts` export. Do not add or remove exports without a deliberate versioned decision.
