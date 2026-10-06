# T20 — Queue contract: duplicate submission of the same source

**Repository:** `tdam` (TencentDB Agent Memory) · **Mode:** `contract` · **Task:** T20

## Contract

> Submitting the **same source** to the knowledge build pipeline **twice** must
> create **one effective build** and leave the asset in the expected **terminal
> state** (`ready`).

The source identity is the store's idempotency key
`(service_id, team_id, repo_url, branch)`. Two submissions with that key must
coalesce onto a single metadata row and a single background build.

## Deliverables

| Artifact | Purpose |
| --- | --- |
| `MemoryKnowledge/fixtures/build-queue-double-submit.mts` | The executable demo — the separate queue fixture. Two parts, both against real production code. |
| `MemoryKnowledge/fixtures/ts-js-resolve-hook.mjs` | ESM resolve hook that maps the repo's NodeNext `.js` import specifiers onto the `.ts` sources they live in, so the fixture runs from source with a bare Node runtime. |

No production source was modified: the fixture only *imports* `BuildQueue`
(`MemoryKnowledge/src/store/build-queue.ts`) and `CodeGraphService`
(`MemoryKnowledge/src/store/code-graph-service.ts`).

## How to run

From the repository root, with Node ≥ 22.6 (type stripping is on by default from
Node 23.6; verified on Node v24.14.0):

```bash
node MemoryKnowledge/fixtures/build-queue-double-submit.mts
```

The fixture is dependency-free — no `npm install`, no vitest, no SQLite, no
network. It imports the TypeScript sources directly and uses a small in-memory
`IKnowledgeStore` stand-in for the code-graph slice, mirroring
`SqliteKnowledgeStore.createCodeGraph`'s dedup key
`(service_id, team_id, repo_url, branch, deleted_at IS NULL)`.

## What the fixture proves

### Part A — `BuildQueue` per-key serialization (`build-queue.ts:15-24`)

The same key (`"source-A"`) is submitted twice back-to-back, before the first
job finishes. `enqueue` lazily creates **one** `SerialQueue` for the key and both
jobs land on it:

- both submissions run — trace `start:submit-1 → end:submit-1 → start:submit-2 → end:submit-2`;
- `maxInFlight === 1` — the same source never builds concurrently;
- FIFO order is preserved within the key;
- `onIdle()` resolves after the queue drains.

### Part B — `CodeGraphService` idempotent create

`service.create(source)` is called twice with the **same source** before the
first build settles:

- submission #1 → `{ existed: false }`, a `pending` row is created and one build
  is enqueued;
- submission #2 → `{ existed: true }`, the **same** `code_graph_id` is returned,
  and `create()` skips `enqueueBuild` entirely (`code-graph-service.ts:132-139`);
- exactly one metadata row exists for the source;
- the injected worker runs **exactly once** (`workerRuns === 1`) — one effective
  build;
- `await service.onIdle()` then observes the terminal state.

**Expected terminal state** (recorded on the single row):

| Field | Terminal value |
| --- | --- |
| `status` | `ready` |
| `internal_status` | `null` (cleared after `cloning → indexing`) |
| `sync_error` | `null` |
| `commit_hash` | the worker's 40-char commit hash |
| `stats_json` | worker stats persisted |
| `last_sync_at` | stamped |
| audit actions | exactly one `create`, one `ready` — no duplicate `create` |

## Normalized operation result

| Step | Operation | Input | Result |
| --- | --- | --- | --- |
| 1 | `BuildQueue.enqueue("source-A", job)` | submit #1 | job queued on the key's `SerialQueue` |
| 2 | `BuildQueue.enqueue("source-A", job)` | submit #2 (same key) | job appended to the **same** queue, serialized |
| 3 | `CodeGraphService.create(src)` | same source | `existed=false` → insert `pending` + enqueue build |
| 4 | `CodeGraphService.create(src)` | same source | `existed=true` → returns existing id, **no** enqueue |
| 5 | `await service.onIdle()` | — | queue drained; one worker run settled the row |
| 6 | `store.getCodeGraphById(...)` | — | `status = "ready"`, commit/stats/timestamp recorded |

## Validation transcript

```
$ node MemoryKnowledge/fixtures/build-queue-double-submit.mts
Part A — BuildQueue: same key submitted twice is serialized
  [PASS] both same-key submissions completed — start:submit-1 → end:submit-1 → start:submit-2 → end:submit-2
  [PASS] no overlap (maxInFlight === 1) — maxInFlight=1
  [PASS] FIFO order preserved within the key
  [PASS] queue idle after onIdle()

Part B — CodeGraphService: same source submitted twice → one build, terminal ready
  [PASS] 1st submission created a new row — id=cg-fixture-1
  [PASS] 2nd submission of the same source returned existed=true (no new build)
  [PASS] both submissions resolve to the same asset id
  [PASS] exactly one metadata row exists for the source
  [PASS] worker executed exactly once (one effective build) — workerRuns=1
  [PASS] internal status progressed cloning → indexing
  [PASS] terminal state is `ready` — status=ready
  [PASS] terminal row records the commit hash
  [PASS] terminal row cleared internal_status
  [PASS] terminal row cleared sync_error
  [PASS] terminal row recorded stats
  [PASS] terminal row stamped last_sync_at
  [PASS] audit records one create + one ready, and no duplicate create — actions=[create, ready]

CONTRACT OK — 17/17 checks passed
```

Exit code `0`.

## Limitations

- The repository's declared test runner is vitest (`pnpm test`) and `tsx` is its
  dev runner, but neither is installed (no `node_modules`) and this task forbids
  installing dependencies. The fixture is therefore executed directly with
  `node` (built-in TypeScript type stripping + the resolve hook); the optional
  vitest harness is not exercised.
- Part B uses an in-memory `IKnowledgeStore` fake rather than the real
  `SqliteKnowledgeStore`, because `better-sqlite3` is not installed. The fake
  reproduces the exact `createCodeGraph` dedup key and `pending` initial status,
  so the contract proven is the service + queue behavior, not SQLite I/O.
