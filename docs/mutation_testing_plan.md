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

| Level | Value | Meaning |
|---|---|---|
| `high` | 99 | Score at or above this is reported as healthy (green). |
| `low` | 95 | Below this is reported as a warning (yellow). |
| `break` | 95 | The run **fails** below this score. |

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
