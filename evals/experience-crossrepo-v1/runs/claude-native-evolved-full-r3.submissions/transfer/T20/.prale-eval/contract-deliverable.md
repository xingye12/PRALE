# Contract deliverable — same source submitted twice ⇒ one effective build

**Task:** T20 · **Repository:** `tdam` · **Mode:** `contract`

## Contract

> When the *same source* (same `service_id` + `team_id` + `repo_url` + `branch`)
> is submitted twice, the knowledge service creates **exactly one effective
> build** and the asset records the expected **terminal state `ready`**.

The contract is enforced at three layers, and the fixture exercises all three:

1. **Idempotent create (store).** `createCodeGraph` matches on
   `(service_id, team_id, repo_url, branch)` and returns `{ existed: true }` for a
   repeat submission, so `CodeGraphService.create` only calls `enqueueBuild` when
   `!existed` — the duplicate never reaches the queue.
2. **In-flight rejection (service).** `CodeGraphService.sync` returns
   `{ kind: "busy" }` while the asset is `pending`/`processing`, so a submission
   that races the running build is rejected, not duplicated.
3. **Per-source serial lane (queue).** `BuildQueue` keys each asset id to its own
   `SerialQueue` and reuses that lane on every `enqueue`; the lane runs at most one
   job at a time (FIFO). Even if duplicate work *did* reach the queue, it could only
   run after the first build drained, never concurrently.

## Executable demo

`fixtures/build-queue-double-submit.fixture.ts` — a self-contained, zero-dependency
script. It drives the **real** `BuildQueue`, `SerialQueue`, and `CodeGraphService`
from `MemoryKnowledge/src/store/`; only the `IKnowledgeStore` persistence seam is
replaced with an in-memory stub (the real `SqliteKnowledgeStore` needs
`better-sqlite3`/`drizzle`, which are not installed and must not be installed here).

Run it:

```
node .prale-eval/fixtures/build-queue-double-submit.fixture.ts
```

It prints one line per check plus a `RESULT_JSON` line, and exits non-zero if any
check fails.

### How it loads the production sources

Node 24 strips TypeScript types natively but does not rewrite the sources'
`import "./x.js"` specifiers to `.ts`. The fixture registers a small inline
`data:` URL resolve hook (`register(...)` from `node:module`) before dynamically
importing the real files, so they load byte-for-byte unmodified with no install
step.

### Scenarios

- **A — same source twice through the service.** `create(SOURCE)` then `create(SOURCE)`
  again while the first build is in flight, plus a racing `sync(...)`.
  Asserts: second create `existed=true`; exactly **1** worker invocation; **1**
  persisted row; terminal state `ready`; status transitions
  `pending → processing(cloning) → processing(indexing) → ready`; internal stages
  `cloning → indexing → cleared`; racing sync returns `busy`.
- **B — raw `BuildQueue` lane semantics.** Two enqueues on the same key are
  strictly serial (max concurrency 1, FIFO order); two enqueues on *different* keys
  overlap (max concurrency 2), proving B1 is lane identity rather than a single
  global queue.

## Normalized operation result

Observed from the run (all 12 checks pass):

```json
{
  "fixture": "build-queue-double-submit",
  "source": "https://example.com/acme/kb.git@main",
  "submissions": 2,
  "effective_builds": 1,
  "persisted_rows": 1,
  "terminal_state": "ready",
  "status_transitions": ["pending", "processing", "processing", "ready"],
  "internal_stage_writes": ["cloning", "indexing", null],
  "second_submission_existed": true,
  "concurrent_resync": "busy",
  "same_key_max_concurrency": 1,
  "same_key_event_order": ["start:a1", "end:a1", "start:a2", "end:a2"],
  "distinct_key_max_concurrency": 2,
  "checks_total": 12,
  "checks_failed": 0,
  "pass": true
}
```

## Evidence map

| Path | Symbol | Lines |
| --- | --- | --- |
| `MemoryKnowledge/src/store/build-queue.ts` | `BuildQueue` / `enqueue` / `onIdle` | 11–34, 15–24, 27–33 |
| `MemoryKnowledge/src/store/serial-queue.ts` | `add` (SerialQueue, concurrency=1 drain) | 45–54 |
| `MemoryKnowledge/src/store/code-graph-service.ts` | `create` (enqueue only when `!existed`) | 132–141 |
| `MemoryKnowledge/src/store/code-graph-service.ts` | `sync` (busy gate) | 153–169 |
| `MemoryKnowledge/src/store/sqlite-store.ts` | `createCodeGraph` (source-keyed dedup) | 69–136 |

## Validation

```
$ node .prale-eval/fixtures/build-queue-double-submit.fixture.ts
PASS  A.2nd create reports existed=true (source deduped)
PASS  A.exactly one effective build ran
PASS  A.exactly one asset row persisted
PASS  A.terminal state is ready
PASS  A.status log starts at pending
PASS  A.status log holds only pending→processing…→ready (no failed)
PASS  A.internal stages are cloning → indexing → cleared
PASS  A.concurrent re-sync rejected as busy
PASS  B1.same-key max concurrency = 1
PASS  B1.same-key jobs ran FIFO / non-overlapping
PASS  B2.distinct-key max concurrency = 2 (per-key lanes)
PASS  B2.distinct-key jobs overlapped

All 12 checks passed — contract holds.
EXIT=0
```

**Limitation recorded:** the repository's declared runner is `vitest`, but
`node_modules` is absent in this checkout and installing dependencies is out of
scope, so the fixture is dependency-free and is executed directly by `node`
instead. All assertions still run against the unmodified production code.
