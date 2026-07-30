---
name: Bug report
about: Report a reproducible bug in @bymax-one/nest-queue
title: 'bug: '
labels: bug
---

## Summary

<!-- One-sentence description of the bug. -->

## Reproduction

<!-- Minimal steps or a repo link. Include the subpath you were using (server / shared). -->

1.
2.
3.

## Expected vs actual

- **Expected:**
- **Actual:**

## Environment

- Package version: `@bymax-one/nest-queue@`
- Node.js version: `node -v` →
- Package manager: pnpm / npm / yarn
- NestJS version:
- BullMQ version:
- ioredis version:
- Connection mode: A (bring-your-own client) / B (lib-owned)
- Redis: standalone / Sentinel / managed (which provider) — version:
- Configured `prefix` (if any):
- Optional features in use: flows / job schedulers / metrics / `bullmq-otel` telemetry
- OS:

## Additional context

<!-- Relevant module configuration and error output. NEVER paste a Redis connection string,
password, or TLS material — redact them before pasting. Job payloads may contain your users'
data; redact those too. -->

## Data / availability impact

- [ ] This bug leaks connection credentials or job payload contents into a log line or error message, lets one `prefix` namespace read or consume another's jobs, or causes silent job loss on shutdown.

> If **Yes**, please **STOP** and email `support@bymax.one` instead of opening a public issue — a credential leak, a cross-namespace read, or a way to drop acknowledged jobs is a security report, not a public bug.
