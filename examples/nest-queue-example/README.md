# nest-queue-example

A runnable NestJS application that demonstrates `@bymax-one/nest-queue` end-to-end:

- **Mode A** connection (BYO ioredis client)
- `@Processor` / `@Process` decorators for the `email` queue
- Job Scheduler registered via `upsertJobScheduler`
- Flow via the opt-in `FlowService`
- `/health` endpoint returning queue metrics

This is demonstration code and is not published to npm.

## Prerequisites

- Node.js >= 24
- pnpm >= 11
- A running Redis instance

## Running locally

1. Start Redis:

   ```bash
   docker run -d -p 6379:6379 redis:7-alpine
   ```

2. Install dependencies from the workspace root:

   ```bash
   pnpm install
   ```

3. Build the library:

   ```bash
   pnpm build
   ```

4. Start the example:

   ```bash
   REDIS_URL=redis://127.0.0.1:6379 pnpm start
   ```

   The app starts on `http://localhost:3000`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Queue metrics snapshot |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL |
| `PORT` | `3000` | HTTP listening port |
