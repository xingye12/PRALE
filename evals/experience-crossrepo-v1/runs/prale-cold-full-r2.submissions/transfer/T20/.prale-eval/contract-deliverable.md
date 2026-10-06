# Contract deliverable — T20 (tdam)

**Request:** contract a separate queue fixture where the same source is submitted twice; prove it
creates one effective build and records the expected terminal state.

**Status:** implemented and executable.

---

## 1. The contract (what is asserted)

A "source" is a code-graph source identity — `(service_id, team_id, repo_url, branch)` — i.e. the
key that `SqliteKnowledgeStore.createCodeGraph`
(`MemoryKnowledge/src/store/sqlite-store.ts:69-137`) uses to recognise an already-known source, and
the same identity the per-asset `BuildQueue` lane is derived from.

| # | Scenario | Contract |
|---|----------|----------|
| 1 | `create(source)` called twice, sequentially | 2nd call returns `{ existed: true }` for the **same** `code_graph_id`; the worker executes **exactly once**; exactly **1** metadata row; terminal row = `ready`, `internal_status: null`, `sync_error: null`, `version: 1`, `commit_hash`/`stats_json`/`last_sync_at` persisted; recorded lifecycle `pending → processing → ready`; audit `[create, ready]` |
| 2 | `create(source)` then `sync(...)` **while the first build is in flight** | duplicate is rejected with `{ kind: "busy", status: "processing", step: "indexing" }`; no version bump, no status overwrite, no second enqueue, no extra audit; the generation still produces **1** build and still terminates at `ready`, `version: 1` |
| 3 | raw `BuildQueue` semantics | same key ⇒ strictly serial: `start:same-key-1 → end:same-key-1 → start:same-key-2 → end:same-key-2`, max concurrency **1**; different keys ⇒ independent lanes that **do** run concurrently |

Scenarios 1 and 2 are the requested "same source submitted twice" proof; scenario 3 pins the queue
property (per-key `SerialQueue`) that makes the service-level dedup sufficient.

## 2. Artifacts

All new files are additive; no existing source, task metadata, hidden-oracle file, package lock or
git configuration was modified.

| Path | Role |
|------|------|
| `MemoryKnowledge/test/contracts/queue-duplicate-source/duplicate-source.contract.mjs` | The fixture: in-memory `IKnowledgeStore` double (mirrors the real source-identity rule), worker double that counts builds, and the three contract scenarios. Exports `runDuplicateSourceContract()` and registers `node:test` cases. |
| `MemoryKnowledge/test/contracts/queue-duplicate-source/run.mjs` | Plain-script runner: prints the **normalized operation result** as JSON, exits non-zero on any contract failure. |
| `MemoryKnowledge/test/contracts/queue-duplicate-source/register.mjs` | Registers the resolver hook via `node:module`. |
| `MemoryKnowledge/test/contracts/queue-duplicate-source/ts-js-resolver.mjs` | 20-line resolve hook mapping the repo's bundler-style `./x.js` specifiers to the on-disk `./x.ts` sources (Node type-stripping loads the production files unmodified). |

The fixture imports the **real** `MemoryKnowledge/src/store/build-queue.ts` and
`MemoryKnowledge/src/store/code-graph-service.ts` — it is not a re-implementation.

## 3. How to run

```bash
cd MemoryKnowledge

# contract tests (3/3 pass)
node --no-warnings --import ./test/contracts/queue-duplicate-source/register.mjs \
     --test ./test/contracts/queue-duplicate-source/duplicate-source.contract.mjs

# normalized operation result (JSON, exit 0)
node --no-warnings --import ./test/contracts/queue-duplicate-source/register.mjs \
     ./test/contracts/queue-duplicate-source/run.mjs
```

Observed output of the runner (normalized view):

```json
{
  "contract": "queue-duplicate-source",
  "normalized": {
    "submissions_of_same_source": 2,
    "effective_builds": 1,
    "metadata_rows": 1,
    "terminal_state": "ready",
    "version": 1,
    "lifecycle": ["pending", "processing", "ready"],
    "audit_actions": ["create", "ready"]
  }
}
```

## 4. Why one effective build (mechanism, with citations)

1. `CodeGraphService.create` (`MemoryKnowledge/src/store/code-graph-service.ts:132-139`) enqueues a
   build **only when `existed === false`**; a repeated submission of the same source returns the
   existing row and never reaches `enqueueBuild`.
2. The identity check lives in the store (`SqliteKnowledgeStore.createCodeGraph`,
   `MemoryKnowledge/src/store/sqlite-store.ts:69-137`) on
   `(service_id, team_id, repo_url, branch)` with `deleted_at IS NULL` — including a
   unique-violation fallback for a concurrent race.
3. If the duplicate arrives before the first build finished, `CodeGraphService.sync`
   (`MemoryKnowledge/src/store/code-graph-service.ts:153-171`) short-circuits with
   `{ kind: "busy" }` while the row is `pending`/`processing`, before any status/version/audit write.
4. Jobs on that identity are serialised by `BuildQueue`
   (`MemoryKnowledge/src/store/build-queue.ts:11-33`): a `Map<assetKey, SerialQueue>`, where
   `SerialQueue.drain` (`MemoryKnowledge/src/store/serial-queue.ts:81-101`) runs exactly one task at
   a time per key — so even a duplicate that slipped through could not overlap or interleave with
   the first build.
5. The terminal state is written by `CodeGraphService.runBuild`
   (`MemoryKnowledge/src/store/code-graph-service.ts:275-343`): success ⇒ `status: "ready"`,
   `internal_status: null`, `sync_error: null`, `commit_hash`, `stats_json`, `last_sync_at`, plus the
   `ready` audit row.

## 5. Validation note / limitation

This checkout has **no installed dependencies** (`node_modules` absent; `vitest`, `better-sqlite3`,
`tsx` unavailable) and installing is out of scope for this task. The fixture therefore runs on
Node's built-in test runner (Node v24.14.0) with the resolver hook above and a self-contained
in-memory store double, instead of `vitest run`. The real `BuildQueue`/`CodeGraphService` sources are
still the ones under test; only the persistence backend and the bundler are substituted. Result:
3/3 tests pass, runner exits 0.
