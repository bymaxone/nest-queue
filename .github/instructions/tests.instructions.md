---
applyTo: '**/*.spec.ts,**/*.e2e-spec.ts,test/**/*.ts'
---

# Test Review Instructions — @bymax-one/nest-queue

## Coverage requirements

- 100% line and branch coverage on every implemented file (enforced by `jest.coverage.config.ts`).
- Every branch of a conditional must be exercised by at least one test.
- Coverage thresholds are `100/100/100/100` — no exceptions for shipped logic.

## Test design rules

- One `it` per observable behavior — each test asserts a single, focused outcome.
- Test names must be in English and describe the behavior, not the implementation:
  `it('resolves to null when the job does not exist')` not `it('getJob null path')`.
- No fake mocks that hide real branches — mock at the boundary (the dependency), not inside the unit.
- Deterministic tests — mock `Date.now()`, `Math.random()`, and timers where needed.
- No `it.only` or `describe.only` in committed code.

## Jest config rules

- Unit tests: `jest.config.ts` (fast, in-process, no real Redis).
- Coverage: `jest.coverage.config.ts` with `100/100/100/100` thresholds.
- E2E: `jest.e2e.config.ts` with Testcontainers Redis (Docker required).
- Stryker: `jest.stryker.config.ts` with `maxWorkers: '50%'` (memory-safe).
- Do not add `--passWithNoTests` to coverage runs.

## Memory safety

- E2E and mutation tests use `maxWorkers: '50%'` to avoid OOM.
- Do not fan out parallel test runs — run one suite at a time.
- Use `NODE_OPTIONS=--max-old-space-size=4096` as a guard for mutation runs.

## Type-level tests

- `test/types/public-api.test-d.ts` pins the **published** signatures and is
  compiled by `pnpm test:types`, not executed. An assertion there must fail when
  the contract changes: prove it by breaking the source and watching `tsc` go red,
  the same red-check a runtime test gets.
- Assert with invariant equality, not mutual assignability — a widened return type
  passes a bare `extends` check.
- A new public export, a new generic parameter, or a new union member is a
  contract change and belongs here.

## Assertion style

- Use `expect(value).toBe(exact)` for primitives; `toEqual` for objects.
- Use `toThrow`/`rejects.toThrow` with the specific error class and/or message.
- Avoid `expect.anything()` when the actual value is knowable.

## BullMQ test rules

- Unit tests mock `Queue`, `Worker`, `FlowProducer`, and `QueueEvents` from `bullmq`.
- E2E tests use real Testcontainers Redis; never `ioredis-mock` in E2E.
- Decorator tests assert reflection metadata, not just that no error was thrown.
