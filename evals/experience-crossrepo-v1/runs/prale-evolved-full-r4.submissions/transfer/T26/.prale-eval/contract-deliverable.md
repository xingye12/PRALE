# T26 — Contract: separate queue fixture where the same source is submitted twice

- **Repository key:** `tdam`
- **Task mode:** `contract`
- **Module under contract:** `MemoryKnowledge/src/store/build-queue.ts`
- **Status:** ✅ proven — 24/24 fixture checks pass (exit 0), 65/65 citation checks pass

---

## 1. What is being contracted

A **queue fixture** in which the *same source is submitted twice* must produce **one
effective build** and must record the **expected terminal state**.

"Same source" is the idempotency identity of the asset pipeline:
`(service_id, team_id, repo_url, branch)` for code-graph assets — the key that the
store uses to decide whether a submission is new — and, at the queue layer, the
`BuildQueue` key (the asset id) under which the build job is scheduled.

The contract therefore has two halves, and the fixture proves both:

| Half | Question | Proven by |
|---|---|---|
| Queue mechanics | Can two builds of the same key ever overlap? | `BuildQueue` per-key `SerialQueue` (concurrency = 1) |
| Submission dedup | Does the second submission start a second build? | idempotent `create` + `busy` guard on `sync` |
| Terminal state | What is recorded when the single build finishes? | `runBuild` writes `status: "ready"` (+ commit/stats/timestamps) |

---

## 2. Executable demo

**File:** `.prale-eval/fixture/queue-double-submit.mjs`
**Run:**

```bash
node --experimental-strip-types .prale-eval/fixture/queue-double-submit.mjs
```

It exits `0` when all assertions pass and `1` otherwise, printing a JSON report
(`{total, passed, failed, checks[]}`).

### It executes the REAL production code

| Imported from repo | Why |
|---|---|
| `MemoryKnowledge/src/store/build-queue.ts` → `BuildQueue` | the queue under contract |
| `MemoryKnowledge/src/store/serial-queue.ts` → `SerialQueue` | the concurrency=1 primitive |
| `MemoryKnowledge/src/store/code-graph-service.ts` → `CodeGraphService` | idempotent submit + terminal-state writer |

No production logic is copied. The only authored pieces are:

- `.prale-eval/fixture/ts-resolve.mjs` — a Node ESM loader hook that maps the repo's
  bundler-style `./x.js` specifiers to the on-disk `./x.ts` sources, so the fixture can
  import TypeScript directly with **zero installed dependencies**.
- A minimal in-memory `IKnowledgeStore` stub (code-graph subset only) that reproduces the
  sqlite store's idempotency key `(service_id, team_id, repo_url, branch)` and status
  transitions.
- An injected counting worker (`worker(ctx) → {commitHash, stats}`).

This is the documented extension seam: both services already accept an injected
`store`, `worker`, and `queue` (`WikiServiceOptions` / `CodeGraphServiceOptions`),
explicitly so unit tests can run without real git/SQLite.

### Scenario

```js
const first  = service.create(source);            // submission #1 → new row, build enqueued
const second = service.create(source);            // submission #2 → SAME source, in-flight
const syncDup = service.sync(svc, team, first.row.code_graph_id); // duplicate route
await service.onIdle();                           // deterministic drain of the BuildQueue
```

`source = { service_id: "svc-a", team_id: "team-1",
repo_url: "https://example.com/acme/tdam.git", branch: "main" }`.

---

## 3. Normalized operation result

Observed after the queue drained (raw fixture output):

```jsonc
{
  "submit1":  { "existed": false, "code_graph_id": "cg-1" },
  "submit2":  { "existed": true,  "code_graph_id": "cg-1" },   // same effective asset
  "duplicate_sync": { "kind": "busy", "status": "pending" },     // not re-enqueued
  "rows_for_source": 1,
  "worker_invocations": 1,                                       // ONE effective build
  "terminal_state": {
    "status": "ready",
    "internal_status": null,
    "sync_error": null,
    "commit_hash": "abc1234",
    "stats_json": "{\"files\":7,\"nodes\":42,\"edges\":88}",
    "last_sync_at": "<ISO-8601 timestamp of the build>",
    "version": 1
  },
  "audit_actions": ["create", "ready"]                           // no duplicate build audit
}
```

### Assertions (24/24 ✅)

**Queue mechanics (`BuildQueue` / `SerialQueue`)**

1. Same key never runs two jobs concurrently — max concurrent for key `same-source` = **1**.
2. Distinct keys get independent queues and may overlap — global max = **2**.
3. Same-key jobs run FIFO (`end:a` before `start:b`).
4. `onIdle()` drains every key (6/6 completion events).
5. `onIdle(key)` resolves after that key's job.
6. Global `onIdle()` also waits for other keys.
7. `SerialQueue.add()` resolves each task with its result in FIFO order.

**Submission dedup (same source twice → one build)**

8. `submit#1` created a new row (`existed:false`).
9. `submit#2` (same source) is an idempotent hit (`existed:true`), not a new row.
10. Both submissions resolve to the same `code_graph_id`.
11. Duplicate `sync` while in-flight is rejected as `busy`.
12. At submit time the row is non-terminal (pending/processing).

**Terminal state**

13. Exactly one row for the duplicated source.
14. Worker invoked exactly once.
15. `status === "ready"`.
16. `internal_status === null`.
17. `sync_error === null`.
18. Worker result persisted (`commit_hash`, `stats_json`).
19. `last_sync_at` set.
20. `version` unchanged by the duplicate (no rebuild).
21. Audit = one `create` + one `ready`.

**Controls**

22. Negative control — a genuinely different source (branch `release`) builds
    independently (2 rows, 2 worker calls).
23. Positive control — `sync` on a *ready* asset is accepted again, `version → 2`.
24. Re-build after terminal state still lands on `ready`.

---

## 4. Contract, restated normatively

> Given a `BuildQueue` and the `CodeGraphService` (or `WikiService`) wired to it, if the
> **same source identity** is submitted more than once — whether by a repeated `create`
> or an in-flight `sync` — then:
>
> 1. **At most one build job per source key is ever in flight.** `BuildQueue.enqueue`
>    reuses the single `SerialQueue` registered for that key (`build-queue.ts:16-20`), and
>    `SerialQueue.drain` refuses to start a task while another runs (`serial-queue.ts:81-101`).
> 2. **Redundant submissions are deduplicated, not queued.** `create` returns the existing
>    row with `existed:true` and skips `enqueueBuild` (`code-graph-service.ts:132-139`); an
>    in-flight `sync` returns `{kind:"busy"}` without mutating status, re-enqueuing, or
>    writing audit (`code-graph-service.ts:156-159`).
> 3. **Exactly one build therefore executes, and it records a terminal state.** The build
>    walks `pending → processing → ready` and persists `status:"ready"`,
>    `internal_status:null`, `sync_error:null`, `commit_hash`, `stats_json`, and
>    `last_sync_at` (`code-graph-service.ts:287-315`).
> 4. **The barrier is `onIdle()`.** Awaiting `BuildQueue.onIdle(key?)` drains the per-key
>    queues, making the terminal state deterministically observable (`build-queue.ts:26-33`).

---

## 5. Source evidence map

| File | Symbol | Lines | Role |
|---|---|---|---|
| `MemoryKnowledge/src/store/build-queue.ts` | `BuildQueue` | 11–24 | per-key queue registry; one `SerialQueue` per asset key |
| `MemoryKnowledge/src/store/build-queue.ts` | `enqueue` | 14–24 | lazy per-key creation = the dedup/serialization seam |
| `MemoryKnowledge/src/store/build-queue.ts` | `onIdle` | 26–33 | per-key / global drain barrier |
| `MemoryKnowledge/src/store/serial-queue.ts` | `SerialQueue` | 21–101 | concurrency=1 primitive; `drain()` never overlaps |
| `MemoryKnowledge/src/store/code-graph-service.ts` | `create` | 132–139 | idempotent submit → skips enqueue when `existed` |
| `MemoryKnowledge/src/store/code-graph-service.ts` | `sync` | 152–171 | in-flight duplicate rejected as `busy` |
| `MemoryKnowledge/src/store/code-graph-service.ts` | `runBuild` | 275–315 | writes the `ready` terminal state |

Ranges are inclusive and were programmatically verified to contain the named symbol
(see `.prale-eval/fixture/verify-citations.mjs`).

---

## 6. Reproduce

```bash
cd <workspace>
node --experimental-strip-types .prale-eval/fixture/queue-double-submit.mjs   # 24/24, exit 0
node .prale-eval/fixture/verify-citations.mjs                                 # 65/65, exit 0
```

Expected tails: `ALL CHECKS PASSED` and `0 CHECK(S) FAILED`.

---

## 7. Limitations

- This checkout has **no `node_modules`**, so `pnpm typecheck`, `vitest`, and any import of
  `better-sqlite3` / `drizzle-orm` / `yaml` could not run. Per instructions **no
  dependencies were installed**. Validation therefore uses Node 24's built-in
  `--experimental-strip-types` (required, since the sources are TypeScript) plus plain
  static assertions and the executable fixture.
- The real `SqliteKnowledgeStore.createCodeGraph` idempotency SQL was **not executed**;
  its behavior is modeled by the in-memory stub and grounded in the source at
  `sqlite-store.ts:65-69`. The contract is about the *service + queue* interaction, which
  the fixture exercises with the real `CodeGraphService` / `BuildQueue` / `SerialQueue`.
- No task metadata, hidden-oracle files, package locks, or git configuration were modified;
  the only additions are under `.prale-eval/`.
