---
name: Feature request
about: Propose a new feature or extension point
title: 'feat: '
labels: enhancement
---

## Problem

<!-- What are you trying to accomplish that the current API does not support? -->

## Proposed solution

<!-- API shape, subpath it belongs to (server / shared), and how it would compose with existing
primitives. If it needs a new external service or SDK, say why it cannot be expressed with the
BullMQ surface the library already wraps — the library ships zero runtime dependencies. -->

## Alternatives considered

<!-- Other approaches and why they fall short. -->

## Scope

- Affects subpath(s): server / shared
- Breaking change: yes / no
- Requires a new peer dependency: yes / no (it must be optional if so)

## Correctness considerations

<!-- If the feature touches recurring jobs, connections, prefixes, or shutdown, describe how it
preserves the invariants: recurring jobs go through Job Schedulers only (never the removed
addRepeatable), cron patterns are validated by BullMQ's own parser, `maxRetriesPerRequest: null`
stays confined to the duplicated Worker/QueueEvents connections, the configured prefix reaches
Queue *and* Worker *and* QueueEvents *and* FlowProducer, and shutdown keeps its bounded-drain
at-least-once semantics. -->
