# Autonomous Phase Execution — @bymax-one/nest-queue

> A runbook for driving the whole roadmap (**Phase 1 → Phase 5**, 5 phases / 35 tasks)
> autonomously, one phase per PR, with zero human interaction after launch. It reuses
> the operational lessons proven on the sibling `nest-notification` / `rust-auth-example`
> runbooks — where the naive "one agent does everything including merge and spawns the
> next" design **deadlocked** waiting for the code-review bot. This is the **library**
> `@bymax-one/nest-queue`: a single-package NestJS dynamic module that wraps **BullMQ**
> (Redis-backed queues), published to npm. The gates, the security focus, and the
> memory-safety rules are the TypeScript-library set — read §4 and §5 carefully.

---

## 0. How to launch

```bash
cd /Users/maximiliano/Documents/MyApps/bymax-one/nest-queue
claude --dangerously-skip-permissions
```

Then paste **Part A — The Orchestrator Prompt** (§2) as the first message. Nothing
else is required from you; the orchestrator drives every phase to merge and chains
the next one until the roadmap is complete (Phase 5 = release to npm).

The **orchestrator** runs on **Opus 4.8 at xhigh effort** (selected in the terminal before
launch). The **implementer subagents** follow a **hybrid model policy** (detailed in §2 STEP 1):
**Opus 4.8** for the subtle / correctness-heavy phases (the connection-policy + module
foundation, the Job-Scheduler/dedup/telemetry surface, and the graceful-shutdown + E2E +
mutation phase), **Sonnet 4.6** for the more mechanical ones (worker wiring on the
established foundation, and the docs/CI/release phase). The merge gate enforces the quality
floor model-agnostically, so the cheaper model is safe where first-pass subtlety matters least.

> **Tip — make this runbook readable by the agents:** copy this file into the repo once so
> the prompts can reference its sections without the absolute MySupport path:
> `cp "/Users/maximiliano/Documents/MySupport/Prompts/PHASE_EXECUTION_PROMPT [nest-queue].md" docs/PHASE_EXECUTION_PROMPT.md`
> (the Part A/B prompts below point at `docs/PHASE_EXECUTION_PROMPT.md`).

---

## 1. Architecture — who does what (the most important lesson)

The work is split across **two roles**. Mixing them is what caused the deadlock.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR  (the main session — long-lived, small context)             │
│                                                                          │
│  • Owns the chain. Decides which phase is next (Phase 1 → Phase 5).      │
│  • Spawns ONE implementer subagent per phase (isolated git worktree).    │
│  • Picks the implementer's MODEL per the hybrid policy (§2 STEP 1).      │
│  • Receives the PR number the implementer returns.                       │
│  • Drives steps 5–9: wait for CI + review bot → fix → merge after a       │
│    grace window → update the dashboards → spawn the NEXT phase.          │
│  • Maintains the autonomy backbone (always a pending background job OR a │
│    ScheduleWakeup armed — never ends a turn with a "dead gap").          │
└──────────────────────────────────────────────────────────────────────────┘
                                   │ spawns (Agent tool, isolation: "worktree", model: …)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ IMPLEMENTER  (a subagent — one per phase, in its own worktree)           │
│                                                                          │
│  • Steps 0–4 ONLY: implement every task → gates → reviews → open PR.     │
│  • Returns the PR number as its final message, then STOPS.              │
│  • NEVER waits for the review bot. NEVER merges. NEVER spawns anything.  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why the split.** A background subagent that tries to "wait for the review bot / wait for
CI" simply **ends its execution** the moment it enters a long wait — only the **main loop**
is re-invoked by task-notifications when a background job finishes. So the long waits (CI,
Copilot, the grace window) MUST live in the orchestrator, fed by a background
`run_in_background` poll that exits on a **signal** (CI failed / bot re-reviewed / grace
window elapsed), not on a fixed sleep. That background completion is what re-invokes the
main loop and keeps the chain alive between phases.

**Why ONE implementer at a time is non-negotiable.** The lib's own test suite is bounded,
but the Phase 4 **E2E suite spins a real Redis via Testcontainers** (one container) and the
Phase 5 **`nest-queue-example` dogfood consumes the lib via `file:`** (every Jest worker
reloads the package into its own module graph). Two phases building/testing at once — or
fanned-out test agents — multiply memory by `workers × runners × agents` and saturate cores.
**Never run two implementers, never fan out parallel test agents, and keep Jest `maxWorkers`
bounded (`'50%'`, baked into the configs).**

---

## 2. Part A — The Orchestrator Prompt

> Paste this block verbatim into the main session.

```
You are the ORCHESTRATOR for the autonomous build of @bymax-one/nest-queue.

Project root: /Users/maximiliano/Documents/MyApps/bymax-one/nest-queue
GitHub repo:  bymaxone/nest-queue
Package:      @bymax-one/nest-queue (public npm), a NestJS dynamic module wrapping BullMQ
Roadmap:      docs/development_plan.md  (5 phases; §1.3 "Phase dashboard" + Overall progress + Update protocol)
Phase tasks:  docs/tasks/phase-NN-*.md  +  docs/tasks/README.md (tasks index + token-economy + self-update protocol)
ONE status legend EVERYWHERE (do NOT invent a second): 📋 ToDo · 🔄 In Progress · 👀 Review · ✅ Done · ⛔ Blocked · 🟡 Partial.
Keep BOTH dashboards (development_plan §1.3 "Phase dashboard"/"Overall progress" AND tasks/README index) in sync on every state change.

You drive the WHOLE roadmap, Phase 1 → Phase 5, one phase per PR, sequentially — NEVER two
phases in parallel (memory-safety: Phase 4 spins a Testcontainers Redis and Phase 5's dogfood
consumes the lib via file:; concurrent Jest/E2E runs OOM the machine). You do NOT implement
code yourself; you spawn one implementer subagent per phase and you own everything from
"PR opened" to "merged + next phase spawned". Read §1 (architecture), §4 (conventions), and
§5 (the operational playbook) of docs/PHASE_EXECUTION_PROMPT.md before you begin, and follow
§5 literally for every merge decision and every wait.

────────────────────────────────────────────────────────────────────────────
STEP -1 — Preconditions (seed main with docs if needed)
────────────────────────────────────────────────────────────────────────────
The repo has docs/ but may have ZERO commits yet (greenfield) while origin
(https://github.com/bymaxone/nest-queue.git) exists. Phase PRs need a valid base:
  • `git rev-parse HEAD` succeeds AND `git ls-remote --heads origin main` exits 0 with
    non-empty output → base OK. (A non-zero exit means a missing/renamed remote, not an
    empty result — treat that as "origin/main absent".)
  • If HEAD is missing OR origin/main is absent: stage docs/, commit
    `chore(repo): seed main with project documentation`, and `git push -u origin main`.
  • Start every phase from the latest origin/main: `git fetch origin`, then `git switch main`
    (or, if no local main exists, `git switch -c main --track origin/main`), then `git pull --ff-only`.
  • Branch creation uses `git switch -c` — NEVER `git checkout -b` (a git-guard hook hard-blocks it).
  • No external pre-build is required (the lib has zero runtime deps; peers `bullmq`/`ioredis`/
    `@nestjs/*` install with the repo). Phase 4's E2E needs Docker available for Testcontainers Redis.

────────────────────────────────────────────────────────────────────────────
STEP 0 — Pick the next phase
────────────────────────────────────────────────────────────────────────────
Read docs/tasks/README.md (the index) and docs/development_plan.md (§1.3 Phase dashboard).
The next phase is the lowest-numbered phase NOT ✅ Done, respecting the dependency order
(the plan's Appendix dependency graph — never start a phase whose deps are not ✅; the track
is linear 1→2→3→4→5).
  • If all of Phases 1–5 are ✅ Done → report "✅ All phases complete. @bymax-one/nest-queue
    v0.1.0 is published." and STOP.
  • All phases run in this repo.

────────────────────────────────────────────────────────────────────────────
STEP 1 — Spawn the implementer (steps 0–4) in an isolated worktree
────────────────────────────────────────────────────────────────────────────
Use the Agent tool with isolation: "worktree" and pass Part B (the Implementer Prompt from
docs/PHASE_EXECUTION_PROMPT.md §3) verbatim, with {N} set to the phase number (1..5) and {NN}
to the zero-padded number (01..05). ONE implementer at a time — never fan out (OOM risk on the
Testcontainers/E2E + file:-linked dogfood phases; concurrent worktrees on the same branch collide).

MODEL POLICY (hybrid). You (orchestrator) ALWAYS run on Opus 4.8 (1M). For each implementer/fix
subagent you spawn, set the Agent tool `model`:
  • Opus 4.8 (OMIT `model` → the subagent inherits the main-loop model) for the subtle /
    correctness-heavy phases:
      Phase 1 (Foundation — ConnectionResolver per-role maxRetriesPerRequest policy +
        ConfigurableModuleBuilder + fail-fast validation + base QueueService),
      Phase 3 (Flows + Job Schedulers + Deduplication + Telemetry + Metrics — upsertJobScheduler
        idempotency, cron validation delegated to BullMQ, dedup modes, telemetry passthrough),
      Phase 4 (forRootAsync + Graceful Shutdown + E2E + Mutation baseline — the close() drain
        race, at-least-once semantics, Testcontainers scenarios; HIGH complexity).
  • Sonnet 4.6 (`model: "sonnet"`) for the more mechanical phases:
      Phase 2 (Workers — @Processor/@Process/@OnWorkerEvent/@OnQueueEvent + WorkerRegistry +
        DiscoveryService wiring on the established foundation),
      Phase 5 (Release — README/CHANGELOG/SECURITY/CLAUDE/AGENTS + 4 Copilot files, finalize CI,
        bundle budgets, mutation gate, nest-queue-example dogfood, publish).
  • Fix subagents: ESCALATE to Opus (omit `model`) when a phase stalls on review/CI findings,
    even if its implementer was Sonnet — ESPECIALLY for any /security-review finding and for the
    DiscoveryService wiring / shutdown-race logic.
Rationale: the merge gate — /bymax-quality:code-review (routes to the typescript-reviewer) +
/security-review iterated to zero, CI (100% coverage via jest.coverage.config.ts + e2e, build of
both subpaths, size budgets, OSV-Scanner/TruffleHog/Scorecard, the no-addRepeatable grep gate),
the Copilot review, and the Phase 4/5 mutation gate — enforces the quality floor model-agnostically,
so a Sonnet PR that passes meets the same objective bar at lower cost; the subtlest phases stay on
Opus for first-pass judgment (per-role connection retries, fail-open vs fail-closed shutdown, the
inverted-flow-failure trap, Job-Scheduler vs deprecated addRepeatable). Caveat: the Agent tool
exposes only `model`, NOT effort — only the model is guaranteed per subagent.

The implementer returns a PR number. DO NOT trust its prose about what it did — verify the real
state via git/gh (§5.5). Confirm the PR exists and its head branch matches:
  gh pr view <PR#> --repo bymaxone/nest-queue --json number,headRefName,state

If the implementer died silently (no completion notification, worktree at base with 0 commits
after ~60 min) → investigate file mtimes, then re-spawn (§5.3).

────────────────────────────────────────────────────────────────────────────
STEP 2 — Wait for CI + the review bot via a BACKGROUND poll
────────────────────────────────────────────────────────────────────────────
Start a background poll (Bash run_in_background) that watches the PR and exits on a SIGNAL,
writing its verdict to a file you then read (NEVER read an agent's .output transcript — §5.5).
Use the gh vocabulary in §5.6. The poll exits with exactly one:
  • CI_FAILED        — at least one check is failing (this repo's CI: install / typecheck / lint /
                       test:cov:all / build / size / e2e / codeql / scorecard / osv-scanner /
                       secret-scan — any may fail)
  • BOT_COMMENTED    — the bot left unresolved review threads to address
  • READY_TO_MERGE   — the full merge-gate conjunction (§5.1) holds
Its completion re-invokes you. Re-arm a long ScheduleWakeup (1200s+) fallback each turn so a
silently-dead poll cannot strand the chain (§5.3).

While the poll runs, DO NOT idle: read the next phase's task file, sync main, pre-draft replies
to threads the last fix already addressed — so the merge is instant when the gate opens (§5.1).

────────────────────────────────────────────────────────────────────────────
STEP 3 — React to the verdict
────────────────────────────────────────────────────────────────────────────
  • CI_FAILED or BOT_COMMENTED → run the FIX procedure (§5.2 + §5.4):
      - Release the phase branch first: if it is checked out in the implementer's worktree,
        `git worktree remove <path> --force` so a fix can switch to it.
      - Spawn a fix subagent (isolation: "worktree", model per the escalation rule above) OR fix
        inline in a fresh worktree on that branch: address EVERY failing check and EVERY bot
        comment (all severities, down to nit). Push.
      - Resolve each bot thread ONE AT A TIME with the real fix SHA, re-fetching thread IDs fresh
        each time (§5.2).
      - Go back to STEP 2 (new background poll).
  • READY_TO_MERGE → STEP 4.

────────────────────────────────────────────────────────────────────────────
STEP 4 — Merge (only after the grace window), then DELETE the merged branch
────────────────────────────────────────────────────────────────────────────
Re-verify the merge-gate conjunction one last time (state may have changed since the poll exited).
Capture the merged PR's head branch FIRST so you can delete it deterministically:
  BR=$(gh pr view <PR#> --repo bymaxone/nest-queue --json headRefName -q .headRefName)
Then merge and DELETE THE BRANCH OF THIS VERY MERGE — remote and local. A merge is not "done"
until its branch is gone:
  gh pr merge <PR#> --repo bymaxone/nest-queue --squash --delete-branch
  git switch main && git pull
  git status                                                 # must be clean
  git worktree remove <implementer-worktree-path> --force    # if still present
  git branch -D "$BR" 2>/dev/null || true
  git push origin --delete "$BR" 2>/dev/null || true
  git ls-remote --heads origin "$BR"                         # MUST print nothing
  git branch --list "$BR"                                    # MUST print nothing
The last two are the proof: if either still shows the branch, the merge is NOT finished. Never
merge the instant CI goes green — honor the grace window in §5.1.

────────────────────────────────────────────────────────────────────────────
STEP 5 — Update the dashboards, then chain the next phase
────────────────────────────────────────────────────────────────────────────
Follow the development_plan §1.3 "Update protocol". ONE legend (📋🔄👀✅⛔🟡) — no
cross-vocabulary trap. Update BOTH dashboards + the phase file:
  • docs/development_plan.md §1.3 "Phase dashboard" — the phase row Status → ✅, Progress
    (N / N tasks), Last updated date; AND the Total row.
  • docs/development_plan.md §1.3 "Overall progress" — recompute (X / 5 phases + %, Y / 35 tasks),
    set Active phase to the next phase, and Blocked.
  • docs/tasks/README.md folder index — the phase row Status → ✅ + Tasks counter + the Total row.
  • docs/tasks/phase-NN-*.md — header Status → ✅ + Progress N/N + Completion log (if the
    implementer's per-task Completion Protocol did not already finalize it).
Confirm every §1.4 Global Done criterion is actually met AND that CI is green on the merged main —
verify via gh/git, not via any agent's narration; if any bullet is unmet use 🟡 Partial and keep
the phase not-Done.
Commit: docs(plan): mark Phase N complete   (no Co-Authored-By). Push.

Then LOOP: go to STEP 0 for the next phase. Before ending the turn, make sure there is ALWAYS
either a tracked background job pending or a ScheduleWakeup armed (§5.3) — never end a turn with
a dead gap, or the chain stalls waiting for a human.
```

---

## 3. Part B — The Implementer Prompt (steps 0–4 only)

> The orchestrator passes this verbatim to each spawned implementer subagent, substituting
> `{N}` with the phase number (1..5) and `{NN}` with the zero-padded number (01..05), and
> setting the Agent `model` per the §2 STEP 1 hybrid policy. The implementer runs in its own
> git worktree, opens the PR, returns the number, and STOPS.

```
You implement ONE phase of @bymax-one/nest-queue end-to-end up to OPENING A PR, then you STOP
and return the PR number. You do NOT wait for the review bot, you do NOT merge, you do NOT spawn
any agent. The orchestrator owns all of that.

Project root: /Users/maximiliano/Documents/MyApps/bymax-one/nest-queue
GitHub repo:  bymaxone/nest-queue
Package:      @bymax-one/nest-queue — a NestJS dynamic module over BullMQ (typed jobs, flows,
              Job Schedulers, deduplication, OpenTelemetry, graceful shutdown). Zero runtime deps;
              bullmq ^5.16 / ioredis ^5 / @nestjs/* ^11 are PEER deps; bullmq-otel ^1 is an OPTIONAL peer.
You are running in an ISOLATED git worktree — your branch, commits, and files do not touch the
main tree or any other agent. Create your branch with `git switch -c feat/phase-{N}-<slug>`
(NEVER `git checkout -b` — a git-guard hook blocks it).

YOUR PHASE: Phase {N}.
Read docs/tasks/phase-{NN}-*.md (the full task list, acceptance criteria, and rules-of-phase)
and the "REQUIRED READING" each task names — TOKEN ECONOMY: read ONLY your task's `### Task {N}.n`
block + that block's bounded REQUIRED READING, not the whole file or the whole plan/spec (see
docs/tasks/README.md "Token economy"; the phase files are 700–1000 lines — use Read offset/limit).

────────────────────────────────────────────────────────────────────────────
STEP 0 — Claim the phase (update BOTH dashboards + the phase file)
────────────────────────────────────────────────────────────────────────────
ONE legend (📋🔄👀✅⛔🟡):
  • docs/development_plan.md §1.3 "Phase dashboard" — phase row Status → 🔄 In Progress; AND
    "Overall progress" Active phase → this phase.
  • docs/tasks/README.md folder index — phase row → 🔄 In Progress.
  • docs/tasks/phase-{NN}-*.md — header Status → 🔄 In Progress.

────────────────────────────────────────────────────────────────────────────
STEP 1 — Execute the phase, task by task
────────────────────────────────────────────────────────────────────────────
Invoke: /bymax-workflow:task phase {N}
Follow the skill exactly, tasks in dependency order (the "Depends on" column). For every task:
  • Verify the current official docs FIRST (context7) for any library you touch — never code an
    API from memory. BullMQ ^5.16 (current 5.79.1): Queue/Worker/QueueEvents/FlowProducer,
    upsertJobScheduler/removeJobScheduler/getJobSchedulers (NOT addRepeatable — removed in v6),
    deduplication options, clean(grace,limit,type), worker.close(force), the Telemetry interface;
    ioredis 5 (duplicate({maxRetriesPerRequest:null})); NestJS 11 (ConfigurableModuleBuilder,
    DiscoveryService); @testcontainers/redis; Stryker. Resolve and query each before coding.
  • Implement to EVERY acceptance criterion; honor all rules-of-phase. Use the REAL identifiers
    from the spec (e.g. recurring jobs go through `upsertJobScheduler`; `cleanQueue(queueName,
    grace, limit, status?)`; per-role connection policy — `null` only on the duplicated
    worker/QueueEvents connection; `@OnWorkerEvent` hands the full Job, `@OnQueueEvent` gives
    jobId + serialized payload; sandboxed processors are file-based via `registerSandboxed`).
  • TDD where the task says so (red → green → refactor).
  • After each task, run the relevant gates and FIX any failure before the next task (run from the
    project root; MEMORY-SAFE — Jest maxWorkers '50%' baked in, never fan out):
      pnpm typecheck
      pnpm lint                 # zero warnings; no eslint-disable / @ts-ignore
      pnpm test:cov:all         # 100% line/branch on every file implemented
      pnpm size                 # bundle budgets (after a task that changes the exported surface)
      # from Phase 4 onward, when E2E specs exist (needs Docker for Testcontainers Redis):
      pnpm test:e2e
  • Apply the per-task Completion Protocol (README "Self-update protocol"): task Status ✅ in its
    block + the Task index row, tick acceptance checkboxes, bump the file-header Progress (n/N),
    update the Phase {N} row Progress in development_plan §1.3, append the Completion-log line, and
    commit with Conventional Commits: <type>(queue): <subject> ({N}.<task>)  — type ∈
    {feat, fix, chore, docs, refactor, test, ci}; NO Co-Authored-By trailer.
Technical priority order: security → correctness → performance → ergonomics.

────────────────────────────────────────────────────────────────────────────
STEP 2 — Phase-wide gates (must all pass)
────────────────────────────────────────────────────────────────────────────
  pnpm typecheck
  pnpm lint
  pnpm test:cov:all   # 100% line/branch per implemented file — hard gate
  pnpm build          # dist/ has .mjs + .cjs + .d.ts for BOTH subpaths (. server / ./shared)
  pnpm size           # server ≤ 18 KiB brotli, shared ≤ 2.5 KiB — hard gate
  # E2E (Phase 4+): real Redis via Testcontainers — needs Docker; ONE container, bounded workers
  pnpm test:e2e
  # invariant gate: the deprecated repeatable API must never appear in src/
  ! grep -rnE '\b(addRepeatable|removeRepeatable)\b' src/   # must find nothing
Mutation testing (Stryker `break 95`, high 99, low 95) is the DEDICATED Phase 4 baseline + Phase 5
pre-release gate — NOT per task/commit.
MEMORY-SAFE: bound Jest workers (`maxWorkers: '50%'`, baked into the configs;
`NODE_OPTIONS=--max-old-space-size=4096` as a guard), one suite at a time, one Testcontainers Redis
at a time; never fan out parallel test agents (the E2E container + the Phase-5 file:-linked dogfood
reload the lib per worker otherwise).

────────────────────────────────────────────────────────────────────────────
STEP 3 — Reviews (iterate to zero findings)
────────────────────────────────────────────────────────────────────────────
Invoke /bymax-quality:code-review — fix ALL findings (every severity, down to nit), then re-run
until it reports zero. Watch especially for: a public export left untyped/undemonstrated; a
deprecated BullMQ method in the public surface (addRepeatable/removeRepeatable); `@Global()` or a
no-op `forFeature` (the module is built on ConfigurableModuleBuilder + setExtras, not @Global);
files >800 lines / functions >50; a missing `@fileoverview` + `@layer` header; any Phase/task
reference left in shipped source or .github config.
Invoke /security-review — fix ALL findings including Low. Pay special attention to (spec Appendix B):
  • Connection strings are MASKED before any log/exception/`QueueException.details`
    (`redis://default:***@host:port`); credentials come from env, never literals.
  • NO `job.data` is logged by default (PII invariant); validation errors reference field names,
    never echo payload values.
  • `job.data` is treated as OPAQUE — never deep-merged (prototype-pollution guard on
    `__proto__`/`constructor` keys).
  • Per-role `maxRetriesPerRequest`: `null` ONLY on the duplicated worker/QueueEvents connection;
    the Queue connection keeps default retries; Mode A FAILS FAST
    (`queue.connection_requires_null_retries`) if a worker connection can't be coerced.
  • Cron validation is delegated to BullMQ (cron-parser) and the parse error rethrown as
    `queue.invalid_repeat_options` — NEVER a hand-rolled regex (ReDoS + 6-field bugs).
  • `enqueueBulk` batch length and per-job payload size are BOUNDED (self-DoS / Redis-memory guard).
  • At-least-once delivery is the contract — handlers must be idempotent; graceful shutdown
    (`Promise.race([worker.close(), timeout])` → `worker.close(true)`) is tested with a real SIGTERM;
    Mode A closes only the connections the lib created, never the consumer's shared client.
  • Redis TLS in production (`connection.options.tls`); AUTH/least-privilege ACL recommended;
    Mode-B URL is operator-trusted only (no SSRF from untrusted config).
  • Supply chain: GitHub Actions pinned by commit SHA; least-privilege `permissions:`; OSV-Scanner +
    TruffleHog clean; OpenSSF Scorecard ≥ 7.0; committed lockfile; npm publish with provenance (OIDC).
Re-run until zero. Re-run the STEP 2 gates after the review fixes.

────────────────────────────────────────────────────────────────────────────
STEP 4 — Open the PR, return its number, STOP
────────────────────────────────────────────────────────────────────────────
Invoke /push (creates the branch if needed, commits anything outstanding, pushes, opens the PR
against main). Then return EXACTLY the PR number and head branch as your final message, e.g.
"PR #7 on branch feat/phase-1-foundation". Do NOT wait for CI or the review bot. Do NOT merge.
Do NOT spawn anything. STOP.

────────────────────────────────────────────────────────────────────────────
MANDATORY CONVENTIONS
────────────────────────────────────────────────────────────────────────────
See docs/PHASE_EXECUTION_PROMPT.md §4 — apply every rule there. Highlights: zero runtime deps
(`"dependencies": {}`; bullmq/ioredis/@nestjs as peers, bullmq-otel optional, @nestjs/bullmq is
NOT a dependency); current BullMQ API only (upsertJobScheduler, never addRepeatable;
cleanQueue(grace,limit,status); no `sandboxed` boolean — file-based registerSandboxed; per-role
maxRetriesPerRequest; @OnWorkerEvent full Job vs @OnQueueEvent serialized); ConfigurableModuleBuilder
+ setExtras (no @Global, no forFeature stub); typed `QueueException` over the error catalog
(`{ error: { code, message, details } }`); TS strict / zero `any` / no suppression comments;
100% line+branch per file; functions ≤50 lines, files ≤800; `@fileoverview` + `@layer` header +
JSDoc on every export; English-only TIMELESS comments (no Phase/Task refs in committed source or
.github config — the runbook and planning docs may name phases, the shipped code may not);
Conventional Commits with NO Co-Authored-By trailer; `git switch -c` (never checkout -b); no
.gitkeep / empty-dir placeholders; memory-safe tests (Jest maxWorkers '50%', never fan out).
```

---

## 4. Mandatory conventions (apply in every phase)

These derive from `docs/development_plan.md` (§1.2 Guiding principles, §1.4 Global Done criteria),
`docs/technical_specification.md` (§0 invariants, §12 errors, Appendix B security), `docs/tasks/README.md`,
and the Bymax Code-Craft Standard.

### Dependencies & API surface
- **Zero runtime deps** — `package.json` ships `"dependencies": {}`. `bullmq ^5.16`, `ioredis ^5`,
  `@nestjs/common ^11`, `@nestjs/core ^11`, `reflect-metadata ^0.2` are **peer** deps; `bullmq-otel ^1`
  is an **optional** peer (`peerDependenciesMeta`). **`@nestjs/bullmq` is NOT a dependency** — this lib
  provides that role itself.
- **Current BullMQ API only** — recurring jobs via `upsertJobScheduler`/`removeJobScheduler`/
  `getJobSchedulers`; **never** `addRepeatable`/`removeRepeatable` (removed in v6). Cron parsing is
  delegated to BullMQ (no `cron-parser` direct dep, no hand-rolled regex). `cleanQueue(queueName, grace,
  limit, status?)` mirrors `clean(grace, limit, type)`. Sandboxed processors are file-based
  (`registerSandboxed`, no NestJS DI) — there is no `sandboxed: boolean`. The public surface never
  exposes a method BullMQ has deprecated.
- **Module via `ConfigurableModuleBuilder`** — `forRoot`/`forRootAsync`; `isGlobal` mapped to
  `DynamicModule.global` via `setExtras`. No hand-written `@Global()`, no `forFeature` stub.
- **Official docs first (context7)** before using any library/SDK/CLI — never from memory.

### Security (Appendix B)
- **Per-role connection policy** — `maxRetriesPerRequest: null` ONLY on the duplicated worker/QueueEvents
  connection (`duplicate({ maxRetriesPerRequest: null })`); the Queue/FlowProducer connection keeps default
  retries. Mode A fails fast if a worker connection can't be coerced. Blocking commands are
  `BRPOPLPUSH`/`BZPOPMIN`/`BLMOVE` (not `BLPOP`).
- **No payload logging / no secret leakage** — never log `job.data`; mask connection strings before any
  log/exception/`details`; `job.data` is opaque (no deep-merge → prototype-pollution guard).
- **At-least-once, never exactly-once** — handlers idempotent; tune `lockDuration` above worst-case runtime;
  `jobId`/`deduplication` collapse duplicate producers; graceful shutdown bounded-drain + force-close, Mode A
  never closes the consumer's shared client.
- **Input bounds** — `enqueueBulk` length + payload size capped; cron validated by BullMQ (ReDoS-safe).
- **Redis hardening** — TLS in prod, AUTH + least-privilege ACL, Mode-B URL operator-trusted.
- **Supply chain** — SHA-pinned Actions, least-privilege `permissions:`, OSV-Scanner + TruffleHog clean,
  OpenSSF Scorecard ≥ 7.0, committed lockfile, npm publish with **provenance** (OIDC trusted publishing).

### Error handling
- **Typed errors only** — `QueueException` over the error catalog; response shape
  `{ error: { code, message, details } }`; HTTP status derived from the code map. No stringly-typed errors.

### Quality floor
- **TS strict, zero `any`** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **100% line + branch coverage** on every implemented file (`pnpm test:cov:all`, `jest.coverage.config.ts`
  thresholds `100/100/100/100`) — hard gate.
- **Mutation `break 95`** (high 99, low 95, driven toward 100) — Stryker, a **Phase 4 baseline + Phase 5
  pre-release** gate (not per task/commit); survivors documented as provable equivalents in
  `docs/mutation_testing_results.md`.
- **Bundle budgets** — `dist/server/index.mjs` ≤ 18 KiB brotli, `dist/shared/index.mjs` ≤ 2.5 KiB brotli
  (`pnpm size`); `bullmq`/`ioredis`/`@nestjs/*` stay external to the bundle.
- **Clean Code sizing & SRP** — functions ≤ 50 lines, files ≤ 800 (200–400 typical); one responsibility per
  file/function. Over the limit is a HIGH code-review finding.
- **`@fileoverview` + `@layer` header on every file; JSDoc on every export** (with `@example` where applicable).
- **CI green from the first PR** — the five workflows (`ci`/`codeql`/`scorecard`/`osv-scanner`/`release`) are
  created in **Phase 1** and every per-PR gate is incremental-safe (jest `--passWithNoTests`, coverage on
  implemented files, size budgets); `release.yml` is tag-driven and inert until Phase 5.

### Memory safety
- **One implementer at a time; one suite at a time; bounded Jest workers** (`maxWorkers: '50%'` baked into
  the configs; `NODE_OPTIONS=--max-old-space-size=4096`). One Testcontainers Redis at a time (Phase 4 E2E).
- **Never fan out parallel `Agent`/`Workflow` runs that execute a test suite**; never run multiple suites at
  once. The Phase-5 `nest-queue-example` dogfood consumes the lib via `file:`, so its smoke reloads the
  package into every Jest worker — keep it bounded too.

### Comments, git & commits
- **Timeless, English-only comments** — never reference `Phase N` / `Task N` / plan stages in committed
  source, JSDoc, or `.github/**` docs-as-config (the runbook and the planning docs may; shipped code/config
  may not).
- **`git switch -c` to branch** — never `git checkout -b` (hook-blocked). **No `.gitkeep`** / empty-dir
  placeholders.
- **Conventional Commits** — `feat/fix/chore/docs/refactor/test/ci(queue): …`; **never** a `Co-Authored-By`
  (or any AI-attribution) trailer.

---

## 5. Operational playbook (the lessons, as concrete procedure)

### 5.1 Merge gate — a conjunction, after a bounded grace window
Never merge the instant CI goes green. A second bot review can land ~90 s after a push; merging too early
turns it into a stray follow-up PR. Merge only when ALL hold:
- **CI green** — `gh pr checks <N> --json bucket` shows **0 fail and 0 pending** (the pipeline has many
  required jobs — install, typecheck, lint, test:cov:all, build, size, e2e, codeql, scorecard, osv-scanner,
  secret-scan — all must pass).
- **No pending review** — `gh pr view <N> --json reviewRequests` is an empty array.
- **No open bot threads** — every `reviewThreads` node `isResolved: true`.
- **No bot review newer than the pending HEAD** — compare each `reviews[].submittedAt` against
  `commits[-1].committedDate`.
- **Grace elapsed** — **≥ 4–5 min since the last push**, measured concretely (record the push time; compute
  elapsed — do not eyeball it).

After a fix-push, the poll has **two valid exit criteria**:
- `COPILOT_REREVIEWED` — a review with `submittedAt` > HEAD `committedDate` arrived, **or**
- `GRACE_NO_REVIEW` — `reviewRequests` empty **and** the grace window has elapsed with no new review (covers
  PRs where the bot doesn't re-review).

Don't idle during the window — sync main, read the next phase, pre-draft thread replies — so the merge is
immediate when the gate opens.

### 5.2 Resolving bot threads (anti-stale)
- **Re-fetch thread IDs FRESH each time**, and check `viewerCanResolve`. Thread IDs change when the bot
  re-reviews a new commit; reusing an old ID returns `NOT_FOUND` and looks (falsely) like a permission error.
- **Respond + resolve one call at a time** — do NOT batch GraphQL mutations (one failure cancels its
  siblings). Verify `isResolved: true` before declaring a thread done. Cite the **real fix SHA** in each reply.

### 5.3 Autonomy backbone — never end a turn with a "dead gap"
- The chain stays alive only while there is **always** either a tracked background job pending **or** a
  `ScheduleWakeup` armed. End a turn with neither and nothing re-invokes the loop — the chain stalls waiting
  for a human.
- `ScheduleWakeup` is a **long fallback (1200 s+)**, not a poll. Don't use a short interval to "poll" tracked
  work (it auto-notifies on completion). Re-arm it each relevant turn with a prompt describing the **current**
  state (not a stale one).
- **Silent-death detection**: an implementer worktree still at base (0 commits) after ~60 min with no
  completion notification ⇒ suspect death; investigate file mtimes (recent = alive; stale = dead) → re-spawn.
  Signs of life: worktree locked, new files, recent mtimes. The Phase-4 E2E (Testcontainers) and the mutation
  run are slow — give those phases a wider window before declaring death.

### 5.4 Worktree discipline
- **Every file-writing subagent runs in its own worktree** (`isolation: "worktree"`), **one agent per
  directory**. Two agents in the same tree collide — uncommitted edits mix and the husky hook breaks on the
  blended tree (recovery: kill both, `git reset --hard` + `git clean -fd`, re-run isolated).
- **Release a branch before a fix-agent touches it.** A branch is pinned to the worktree that created it; git
  refuses the same branch in two worktrees. Remove the prior worktree first: `git worktree remove <path> --force`.
- **Clean up on merge — always delete the merged PR's own branch** from BOTH the remote and the local repo.
  Order: `gh pr merge --squash --delete-branch` → `git worktree remove <path> --force` → `git branch -D
  <branch>` → `git push origin --delete <branch>` (fallback) → verify with `git ls-remote --heads origin
  <branch>` AND `git branch --list <branch>` (both must print nothing — §STEP 4). Prune stale worktrees:
  `git worktree prune`.

### 5.5 Anti-hallucination — verify, never trust narration
- An agent's final message **can confabulate state** (claims fixes it didn't make, invents a SHA). **Always
  confirm real state via git/gh**, never via the agent's prose.
- **`TaskList` is unreliable here** (has returned empty with jobs still active). The real "still running"
  signal is the **absence of a completion task-notification**.
- **Never `Read` an agent's `.output` file** — it's the JSONL transcript and will blow your context. Only read
  the output files your **bash polls** write.

### 5.6 Concrete `gh` signal vocabulary
- **CI status:** `gh pr checks <N> --repo bymaxone/nest-queue --json bucket` → count `pass` / `fail` / `pending`.
- **Pending review:** `gh pr view <N> --json reviewRequests` (empty = nothing queued).
- **Re-review detection:** `reviews[].submittedAt` vs `commits[-1].committedDate`.
- **Threads (GraphQL):** `reviewThreads.nodes[]` → `isResolved`, `viewerCanResolve`,
  `comments[0].databaseId` (the comment to reply under).
- **PR identity:** `gh pr view <N> --json number,headRefName,state,mergeStateStatus`.

---

## 6. The roadmap & the final phase

All 5 phases run in **this** repo (`bymaxone/nest-queue`). The sequence (see `docs/development_plan.md`
§1.3 and the per-phase files in `docs/tasks/`):

`Phase 1` Foundation: module (ConfigurableModuleBuilder) + ConnectionResolver (per-role retries) + base
QueueService — **CI created from day one** → `Phase 2` Workers: `@Processor`/`@Process`/`@OnWorkerEvent`/
`@OnQueueEvent` + WorkerRegistry (+ `registerSandboxed`) + DiscoveryService → `Phase 3` Flows + Job Schedulers
+ Deduplication + Telemetry + Metrics → `Phase 4` forRootAsync + Graceful Shutdown + E2E (Testcontainers Redis)
+ Mutation baseline → **`Phase 5` Release v0.1.0**.

Dependency notes: the track is linear (1 → 2 → 3 → 4 → 5); every phase's `Depends on` references resolve to
earlier task IDs (verified). Phase 4 is the highest-complexity phase (the shutdown drain race + the 7 E2E
scenarios + the mutation baseline).

**Phase 5 is the finish line**: author `README.md` (badges, quick start, Mode A/B, API reference, decorators,
Job Schedulers, deduplication, telemetry, graceful shutdown, the "why over `@nestjs/bullmq`" section,
troubleshooting), `CHANGELOG.md`/`SECURITY.md`/`CLAUDE.md`/`AGENTS.md` + the four Copilot review files +
`commitlint.config.cjs`; FINALIZE & harden the CI workflows (created in Phase 1); enforce the bundle budgets;
run the Stryker mutation gate (`break 95`) and record `docs/mutation_testing_results.md`; build the
`nest-queue-example` dogfood app that consumes the published surface end-to-end (Mode A with
`@bymax-one/nest-cache`, a `@Processor`, a Job Scheduler, a flow, a `/health` queue endpoint); then tag and
`pnpm publish --provenance` (OIDC trusted publishing). When all of Phase 1–5 are ✅ and CI is green on main,
the orchestrator reports completion and STOPS.

> **CI is not a final phase here — it exists from Phase 1** and gates every single PR. The job names are
> contractual (branch protection references them); do not rename them mid-roadmap. (Publishing is this repo's
> job; a separate `nest-queue-example` repo, if later split out, would consume the published package.)
```
