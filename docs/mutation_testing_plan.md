# Mutation Testing Plan

Mutation testing measures the **quality** of the test suite, not just its coverage:
Stryker rewrites the production code (a "mutant") and re-runs the tests; a mutant
that no test catches is a **survivor** and reveals a gap. This library targets a
high mutation score on its critical logic.

## Tooling

- **Runner:** Stryker (`@stryker-mutator/core`) with the Jest test runner
  (`@stryker-mutator/jest-runner`), driven by `jest.stryker.config.ts`.
- **Coverage analysis:** `perTest` — only the tests covering a mutant are run,
  keeping the suite fast without losing precision.
- **Concurrency:** pinned to `1` to stay memory-safe (the module graph is
  duplicated per worker), with `NODE_OPTIONS=--max-old-space-size=4096` as a guard.
- **Config:** `stryker.config.json`.

## Thresholds

| Level   | Value | Meaning                                                |
| ------- | ----- | ------------------------------------------------------ |
| `high`  | 99    | Score at or above this is reported as healthy (green). |
| `low`   | 95    | Below this is reported as a warning (yellow).          |
| `break` | 95    | The run **fails** below this score.                    |

The target is **100%** on the critical paths; `break: 95` is the hard floor.

## Cadence

Mutation testing is a **pre-release gate**, not a per-commit check — a full run
takes several minutes. It is run before cutting a release and whenever the
critical logic changes materially. Day-to-day quality is guarded by 100%
line/branch coverage on every implemented file.

## Targets (surviving mutants here are unacceptable)

These files carry the library's behavioral guarantees; a survivor indicates a
real test gap that must be closed:

- `services/connection-resolver.service.ts` — dual-mode resolution, ready timeout, ownership.
- `services/queue.service.ts` — enqueue/inspection, bulk bound, scheduler upsert.
- `services/worker-registry.service.ts` — worker creation, option validation, connection cleanup.
- `services/processor-discovery.service.ts` — discovery, dispatch, listener wiring.
- `services/metrics.service.ts` — TTL cache and guard.
- `lifecycle/queue-lifecycle.service.ts` — ordered bounded-drain shutdown.
- `config/validate-options.ts` — module option validation.
- `config/resolved-options.ts` — defaults resolution.
- `utils/validate-connection.ts` — blocking-connection / usability assertions.
- `utils/validate-job-scheduler-options.ts` — recurring-job (repeat) option validation.
- `utils/duplicate-connection.ts` — per-role connection duplication.

## Accepted exclusions

These are excluded from the `mutate` set because their mutants are either not
meaningful or are covered exhaustively by integration behavior elsewhere:

- **Barrel exports** (`**/index.ts`) — re-exports only, no executable logic.
- **Type-only interfaces** (`server/interfaces/**`) — erased at compile time.
- **Injection tokens / constant catalogs** (`server/bymax-queue.constants.ts`,
  `server/constants/**`) — `Symbol` descriptions and message strings have no
  behavioral assertions, so their mutants are equivalent.
- **Metadata-only decorators** (`server/decorators/**`) — they only read/write
  reflection metadata and are exercised end to end by processor discovery and
  the E2E suite; their unit specs already assert the metadata.

## Residual survivors

Any surviving mutant that is a **provable equivalent** (a change that cannot
alter observable behavior) is recorded in `mutation_testing_results.md` with a
justification. A survivor that is **not** equivalent is a defect in the suite and
must be fixed by adding a test — the threshold is never lowered to pass.

---

## Suppression policy

An equivalent mutant — one no test can kill because the mutation preserves observable
behaviour — is documented **in the source**, on the line it applies to:

```ts
// Stryker disable next-line <Mutator>[,<Mutator>]: <why the mutant is equivalent>
```

The reason belongs next to the code it explains, where it cannot drift away from it. A
separate report can, and does: line references rot after a reformatting, and a report can
claim a score the branch no longer measures.

Four rules keep that documentation real rather than decorative:

- **The reason goes after the colon, on one line.** Stryker parses a directive with
  `/^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/`. The mutator
  list accepts letters, commas and spaces only, and the reason is captured exclusively
  after the colon and only to the end of that line. Written after `--`, or wrapped onto a
  second comment line, the reason is silently dropped and the report shows Stryker's
  fallback text, `Ignored using a comment`.
- **A directive that does not attach uses the block form.** `next-line` does not reach a
  catch-clause body, a multi-line call argument, or anything inside a builder chain. Those
  take `// Stryker disable <Mutator>` … `// Stryker restore <Mutator>` around the whole
  statement.
- **The reason must be true.** Where a mutant is not equivalent but Stryker fails to
  attribute the killing test to it, the directive says exactly that. Calling it equivalent
  would be false, and a false justification is worth less than a lower score.
- **A mutant a test could kill is never disabled.** Strengthen the test instead. The break
  threshold is never lowered to accommodate a survivor.

`pnpm check:mutants` enforces the first rule mechanically, and also rejects a mutator name
Stryker does not know — which matches nothing, so the directive silences nothing while
looking like it does. Stryker warns about that case, but only during a mutation run, which
is too late to block the change that introduced it.

These comments ship in the unminified bundle. The measured cost is small — seven directives
cost 0.10 kB brotli in a server subpath of roughly 13 kB — because brotli compresses their
repeated prefixes almost for free. Where a bundle budget is genuinely tight, the budget is
raised deliberately in the same change with the measurement recorded beside it, rather than
the documentation being dropped: a budget exists to catch code bloat, and the reason a
mutant survives is not bloat.

This policy is identical across the `@bymax-one/nest-*` libraries.
