# nest-queue-consumer-app

A typecheck fixture, **not** a demo. The reference application for this library is
the separate [`bymaxone/nest-queue-example`](https://github.com/bymaxone/nest-queue-example)
repository.

## What it is for

CI compiles this directory against the **freshly built** library on every pull
request (`Consumer app typecheck`). It resolves `@bymax-one/nest-queue` through the
package `exports` map, exactly as a consumer would — not through a source alias.

That path is the point. The library's public surface is decorator-heavy
(`@Processor`, `@Process`, `@OnWorkerEvent`, `@OnQueueEvent`), and a decorator's
ergonomics can break without any exported signature changing shape. Neither of the
other gates sees it:

| Gate              | Compiles / resolves through  | Catches an ergonomic decorator break |
| ----------------- | ---------------------------- | ------------------------------------ |
| `pnpm test:types` | `src/` via `paths`           | no                                   |
| `pnpm smoke`      | packed tarball, runtime only | no                                   |
| **this fixture**  | **`dist/` via `exports`**    | **yes**                              |

Verified by experiment: changing `@Processor(queueName: string)` to take an options
object left `test:types`, `build` and `smoke` all green, and failed here with
`TS2345: Argument of type 'string' is not assignable to parameter of type '{ queue: string }'`.

## What it covers

Mode A (a bring-your-own `ioredis` client), a decorated processor, a Job Scheduler
registered at module init, an opt-in flow, and queue metrics on a `/health`
endpoint — the shapes a consumer actually writes.

## Running it

It is a typecheck target, not a service; `build` runs `tsc --noEmit`. `start` exists
for manual exploration and needs a Redis on `REDIS_URL`.

```bash
pnpm --filter nest-queue-consumer-app build   # tsc --noEmit
pnpm --filter nest-queue-consumer-app lint
```
