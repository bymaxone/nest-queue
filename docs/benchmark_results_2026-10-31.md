# Benchmark results — 2026-10-31

A local, hand-run measurement of `@bymax-one/nest-queue` 1.2.5 (built from `main`) against a disposable Redis 8. It is not a CI gate: the numbers depend on the machine and on what else runs on it, and they are recorded here so a later change can be compared with them, not to promise a figure.

## Setup

| Item      | Value                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine   | Apple M4 Max, 14 cores, 36 GB, macOS 27.2                                                                                                                                                                                                                                                                                                                                                               |
| Redis     | 8.10.3, standalone, `redis:8-alpine` (`redis@sha256:21090af93f8324db2f0f0f4f38a7c60369d47d917e000c3423d89d2ae2883537`), in Docker Desktop 29.9.2 (Linux VM, aarch64), reached through a published loopback port                                                                                                                                                                                         |
| Node      | v24.21.0                                                                                                                                                                                                                                                                                                                                                                                                |
| Libraries | BullMQ 6.3.4, ioredis 6.0.0                                                                                                                                                                                                                                                                                                                                                                             |
| Load      | `uptime` before run 1: `load averages: 7.37 14.22 23.09`; after run 1: `6.76 13.53 22.58`; before run 2: `7.10 12.82 21.95`; after run 2: `6.79 12.30 21.50`. The machine had other sessions logged in (15 users) but no heavy run active; the one-minute load stayed near 7 on 14 cores and fell slightly. Only the start and end of each run were sampled, so a spike in between would not show here. |

## Commands

```bash
docker run --rm -d --name nq-bench -p 6390:6379 redis:8-alpine
pnpm build
REDIS_URL=redis://127.0.0.1:6390 node scripts/benchmark.mjs
docker stop nq-bench          # --rm removes the container
```

Defaults used: 2000 sequential enqueues, 10 000 concurrent enqueues with 100 in flight, 20 batches of `enqueueBulk(1000)`, 1000 latency jobs paced at 200 per second with a no-op handler, a 5000-job burst per concurrency. Every key lives under a unique prefix and is deleted at the end.

## Results (run 2; run 1 agreed within a few percent)

### Enqueue throughput

| Mode                  |   Jobs | Elapsed ms | Jobs/s | Redis commands per job                                                                                         |
| --------------------- | -----: | ---------: | -----: | -------------------------------------------------------------------------------------------------------------- |
| single, sequential    |   2000 |        367 |   5448 | `evalsha` 1, plus the script's own steps (`xadd` 2, `incr`, `hget`, `lpush`, `hmset`, `zadd`, `hmget`, 1 each) |
| single, 100 in flight | 10 000 |        160 | 62 680 | the same per job                                                                                               |
| `enqueueBulk(1000)`   | 20 000 |        388 | 51 533 | the same per job, pipelined 1000 to a batch                                                                    |

Run 1 gave 5274, 61 322 and 50 684 jobs per second for the same three rows.

### End-to-end latency (enqueue to handler finished)

1000 jobs paced at 200 per second, no-op handler, so this is the queueing and delivery overhead and nothing else.

| Concurrency | p50 ms | p95 ms | p99 ms | Burst drain, jobs/s (5000 jobs through `enqueueBulk`) |
| ----------: | -----: | -----: | -----: | ----------------------------------------------------: |
|           1 |   1.01 |   2.02 |   3.20 |                                                  4516 |
|          10 |   1.31 |   2.65 |   3.69 |                                                14 476 |
|          50 |   1.28 |   2.81 |   4.40 |                                                19 108 |

### Redis connections held (`INFO clients` delta, the script's own connection excluded)

| Scenario                                  | While open | Left after close |
| ----------------------------------------- | ---------: | ---------------: |
| module, Mode B (library-owned connection) |          1 |                0 |
| module, Mode A (your client, not counted) |          0 |                0 |
| Mode A + 1 worker                         |          2 |                0 |
| Mode A + `QueueEvents` on 1 queue         |          2 |                0 |
| Mode B + 1 queue (one enqueue)            |          1 |                0 |
| Mode B + 10 queues                        |          1 |                0 |
| Mode B + 1 worker                         |          3 |                0 |
| Mode B + 5 workers                        |         11 |                0 |
| Mode B + `QueueEvents` on 1 queue         |          3 |                0 |
| Mode B + `QueueEvents` on 5 queues        |         11 |                0 |
| Mode B + flows enabled (one flow added)   |          1 |                0 |

## Reading the numbers

- **One round trip per enqueue.** A single `enqueue` is one `evalsha`; the other commands in the table are the steps of that Lua script and run on the server. There is no per-job chatter to batch. The sequential figure (about 5400 per second) is the round-trip time of a loopback Docker port, not Redis; with 100 in flight the same call reaches about 62 000 per second, so callers that enqueue many jobs should not await them one by one.
- **Producers are free.** A queue shares the module's connection: ten queues hold the same single connection, flows add none, and Mode A adds none of its own.
- **Each worker holds two connections and each observed queue's `QueueEvents` holds two.** `CLIENT LIST` shows, per worker, one named blocking connection (`bzpopmin`) and one unnamed duplicate; per observed queue, one named blocking connection (`xread`) and one unnamed duplicate. Five workers on five queues are ten connections; observing five queues is ten more. Everything is released on close (the last column is zero in every row).
- **Latency is flat in the low milliseconds.** p50 is about 1.0 to 1.3 ms and p99 is 3.2 to 4.4 ms at 200 jobs per second for all three concurrencies; concurrency 1 is slightly lower at p50, which is expected for an unloaded single slot. Concurrency pays off under load: draining a burst goes from about 4500 to 14 500 to 19 100 jobs per second at 1, 10 and 50.

## Findings for the maintainers

1. **Connections per worker and per observed queue are two, not one.** The library duplicates the client for every worker and every observed queue (so that BullMQ's check for `maxRetriesPerRequest: null` passes) and BullMQ adds its blocking connection on top. A process with many small workers or many `@OnQueueEvent` queues multiplies connections quickly. One duplicated command connection shared by all workers could take the count from 2N to N + 1. Whether the command connection can be shared safely by several workers was not checked here; it changes who closes it on shutdown, so it needs its own design and test.
2. **Nothing to batch per job.** The enqueue and the bulk paths are already one script per job with a pipelined bulk. `enqueueBulk` costs the same script per job as `enqueue`; its advantage is the pipeline, not fewer commands.
3. **Not measured here:** handlers that do real work, a remote Redis, large payloads, retries and failures, flows with many children, and memory growth. A no-op handler and a loopback Redis put the floor under the overhead; a networked Redis will move the sequential figure by its round-trip time.
