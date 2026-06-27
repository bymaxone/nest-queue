# Mutation Testing Results

Baseline mutation run for `@bymax-one/nest-queue`, captured against the full
`src/server/**` mutation set described in
[`mutation_testing_plan.md`](./mutation_testing_plan.md).

## Run metadata

| Field | Value |
|---|---|
| Date | 2026-06-27 |
| Runner | Stryker `@stryker-mutator/core` 9.6.1 + `@stryker-mutator/jest-runner` |
| Report schema | mutation-testing-report v1.0 |
| Coverage analysis | `perTest` |
| Concurrency | 1 (`NODE_OPTIONS=--max-old-space-size=4096`) |
| Thresholds | high 99 · low 95 · **break 95** |
| Result | **PASS** — `break 95` satisfied (process exit 0) |

## Overall score

**98.99%** — 586 killed + 1 timeout (detected) / 593 total · 6 survived · 0 no-coverage.

The 6 survivors are **provable equivalent mutants** (documented below); every
non-equivalent mutant is killed. The suite holds 100% line/branch coverage.

## Per-file scores

| File | Score | Killed | Timeout | Survived |
|---|---|---|---|---|
| `bymax-queue.module.ts` | 96.15% | 50 | 0 | 2 (equiv.) |
| `config/resolved-options.ts` | 100.00% | 27 | 0 | 0 |
| `config/validate-options.ts` | 96.36% | 53 | 0 | 2 (equiv.) |
| `errors/queue-exception.ts` | 100.00% | 6 | 0 | 0 |
| `lifecycle/queue-lifecycle.service.ts` | 97.22% | 34 | 1 | 1 (equiv.) |
| `services/connection-resolver.service.ts` | 100.00% | 62 | 0 | 0 |
| `services/flow.service.ts` | 100.00% | 19 | 0 | 0 |
| `services/metrics.service.ts` | 100.00% | 22 | 0 | 0 |
| `services/processor-discovery.service.ts` | 98.31% | 58 | 0 | 1 (equiv.) |
| `services/queue-events-registry.service.ts` | 100.00% | 9 | 0 | 0 |
| `services/queue.service.ts` | 100.00% | 64 | 0 | 0 |
| `services/worker-registry.service.ts` | 100.00% | 123 | 0 | 0 |
| `utils/duplicate-connection.ts` | 100.00% | 2 | 0 | 0 |
| `utils/validate-connection.ts` | 100.00% | 18 | 0 | 0 |
| `utils/validate-job-scheduler-options.ts` | 100.00% | 39 | 0 | 0 |

## Residual survivors — all provable equivalents

A mutant is recorded here only when its replacement cannot change observable
behavior for any reachable input. No threshold was lowered to accommodate them.

1. **`bymax-queue.module.ts:40` — `{ moduleName: 'BymaxQueue' }` → `{}` and
   `'BymaxQueue'` → `''` (2 mutants).** `moduleName` only sets the *description*
   of the generated injection-token `Symbol`, used for human-readable debug
   labels. The token identity that providers inject against is the same object
   reference regardless of the description, so dependency resolution and every
   observable output are unchanged.

2. **`config/validate-options.ts:40` — `drainTimeoutMs !== undefined` → `true`,
   and `:45` — `cacheTtlMs !== undefined` → `true` (2 mutants).** Each
   `!== undefined` operand is behaviorally redundant relative to the comparison
   that follows it. When the value is `undefined`, the trailing check
   (`undefined <= 0` / `undefined < 0`) evaluates to `false` (a `NaN`
   comparison), so the guard never throws for the absent case either way; for a
   defined value the operand is already `true`. The branch result is identical
   for every input.

3. **`lifecycle/queue-lifecycle.service.ts:115` — `new Error('drain timeout')`
   → `new Error('')` (1 mutant).** This error is used purely as a control-flow
   signal to reject the bounded-drain `Promise.race`; it is caught by a
   `catch {}` that escalates to a force-close and never reads the error message.
   The text is unobservable.

4. **`services/processor-discovery.service.ts:78` —
   `typeof instance !== 'object'` → `false` (1 mutant).** The preceding
   `!instance` operand still skips nullish providers. For any truthy non-object
   provider instance (number/string/function), its constructor carries no
   `@Processor` metadata, so the very next `if (!processorMeta) continue` skips
   it identically. Removing the `typeof` guard changes nothing observable.

## Reproduce

```bash
NODE_OPTIONS=--max-old-space-size=4096 pnpm mutation
# scope to a single file while iterating:
NODE_OPTIONS=--max-old-space-size=4096 pnpm exec stryker run --mutate "src/server/services/worker-registry.service.ts"
```

The HTML and JSON reports are written to `reports/mutation/`.
