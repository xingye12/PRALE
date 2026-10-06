# T18 — Duplicate source/build submission ⇒ no duplicate effective work (MemoryKnowledge)

Repository: `tdam` · mode: `contract` · artifact: executable demo + normalized operation result.

## 1. Contract under evaluation

> Submitting the same *source* (asset creation) or the same *build* (rebuild/sync/ingest) twice
> must not cause the system to perform the work twice.

In MemoryKnowledge the "work" of a build is: clone/fetch the git source, walk it, write the
code-graph / wiki index, update status and emit the ready callback. *Effective work* is therefore
measured as **build-worker invocations** (and as **overlapping worker invocations** for one asset).
The demo counts both.

## 2. Executable demo

```
node .prale-eval/demo/dedup-demo.mjs      # exit 0 = contract holds
```

Files added (nothing else in the repository is touched):

| file | role |
| --- | --- |
| `.prale-eval/demo/dedup-demo.mjs` | demo + assertions; imports the real repo modules |
| `.prale-eval/demo/ts-loader.mjs` | 20-line Node resolver hook mapping the repo's `./x.js` import specifiers to `./x.ts` so Node 24 type-stripping can import repo sources directly (no build step, no dependency installed) |

Real repository code executed by the demo (unmodified):

- `MemoryKnowledge/src/store/build-queue.ts` — `BuildQueue.enqueue` / `BuildQueue.onIdle`
- `MemoryKnowledge/src/store/serial-queue.ts` — `SerialQueue` (concurrency = 1 engine)
- `MemoryKnowledge/src/store/code-graph-service.ts` — `CodeGraphService.create` / `.sync` / `.onIdle`

The one emulated component is the `IKnowledgeStore` backend (production backend = drizzle-orm +
better-sqlite3, not installed offline); the stub reproduces exactly the two production dedup facts:
`sqlite-store.ts:69-83` (select existing live row → `{ existed: true }`) and `schema.ts:46-48`
(partial unique index `idx_kcg_team_repo_branch` on `(service_id, team_id, repo_url, branch)`
`WHERE deleted_at IS NULL`).

## 3. Normalized operation result (demo stdout, abbreviated)

```json
{
  "queue": {
    "duplicateSubmissions": { "cg_A": 3, "cg_B": 2 },
    "maxInflightPerKey":    { "cg_A": 1, "cg_B": 1 },
    "completionOrderPerKey":{ "cg_A": ["A#1","A#2","A#3"], "cg_B": ["B#1","B#2"] },
    "globalMaxInflight": 2
  },
  "service": {
    "afterDuplicateCreate": { "firstExisted": false, "duplicateExisted": true, "sameRow": true, "workerCalls": 1 },
    "afterFirstIdle":       { "workerCalls": 1, "status": "ready", "audits": ["create","ready"] },
    "backToBackSyncs":      { "first": "ok", "second": "busy", "secondStatus": "processing" },
    "afterSecondIdle":      { "workerCalls": 2, "status": "ready", "version": 2, "ingestAudits": 1 },
    "duplicateCreateInFlight": { "firstExisted": false, "duplicateExisted": true },
    "totalWorkerCalls": 3,
    "maxConcurrentWorkerCalls": 1
  },
  "ok": true
}
```

Verification command and status:

```
$ node .prale-eval/demo/dedup-demo.mjs ; echo $?
… 11/11 assertions: pass …
DEMO OK: duplicate source/build submission produced no duplicate effective work
0
```

## 4. How the contract is satisfied (mechanism → observation)

**Layer 1 — duplicate submission never becomes a second job (submission-time dedup).**

- *Duplicate source submission* (`POST` create twice with the same repo/branch): the store returns
  the existing live row with `existed = true`, and `CodeGraphService.create`
  (`code-graph-service.ts:132-139`) audits + `enqueueBuild()` **only** when `existed === false`.
  Observed: 2 identical `create()` calls → `existed = [false, true]`, same `code_graph_id`,
  exactly **1** worker invocation, exactly **1** `create` audit row.
- *Duplicate build submission* (sync/ingest again while the asset is pending/processing):
  `CodeGraphService.sync` (`code-graph-service.ts:154-171`) returns `{ kind: "busy" }`
  before any status write, audit row or enqueue — its inline comment states
  "不覆盖状态、不重复入队、不写 audit" (no status overwrite, no re-enqueue, no audit);
  `WikiService.ingest` (`wiki-service.ts:272-290`) is identical for the wiki engine.
  Observed: 2 back-to-back `sync()` calls → `['ok', 'busy']` (busy step `processing`),
  exactly **1** extra worker invocation, exactly **1** `ingest` audit row. The duplicate
  submission therefore costs **0** effective builds.

**Layer 2 — no duplicate job can run concurrently (execution-time serialization, defense in depth).**

`BuildQueue.enqueue` (`build-queue.ts:14-24`) maps every asset id to one lazily created
`SerialQueue` (`build-queue.ts:11-34`); `SerialQueue.drain` (`serial-queue.ts:81-102`) runs at most
one task at a time and re-enters only in `finally`. So even if two jobs for one asset did reach the
queue, they run strictly FIFO without overlap — no concurrent git clone / SQLite / file writes.
`BuildQueue.onIdle` (`build-queue.ts:26-33`) is the settlement point the demo awaits before counting
worker invocations. Observed: 3 duplicate submissions on key `cg_A` → `maxInflight = 1`, FIFO order
`[A#1, A#2, A#3]`; a different key stayed genuinely parallel (`globalMaxInflight = 2`), i.e. the
guard is per-asset serialization, not a global lock; `maxConcurrentWorkerCalls = 1` over the whole
service scenario.

**Honest residual limitation.** `BuildQueue` alone *serializes* duplicated jobs; it does not skip
them. The "duplicate submission ⇒ no duplicate effective work" guarantee comes from the
create-idempotency guard (store select + partial unique index) plus the busy rejection in
`create`/`sync`/`ingest`; the queue is the second, independent safety net guaranteeing that even a
duplicated job can never run concurrently with the build it duplicates.

## 5. Validation status

- **Ran (pass):** `node .prale-eval/demo/dedup-demo.mjs` — 11 assertions, exit 0.
- **Unavailable (dependency limitation, recorded in `.prale-eval/result.json → validation.notes`):**
  the workspace has no `node_modules` and no `vitest` / `tsx` / `tsc` binaries, and installing
  dependencies is out of scope, so `pnpm -C MemoryKnowledge test`, `pnpm -C MemoryKnowledge typecheck`
  and a run against the real drizzle + better-sqlite3 store could not be executed. The demo's
  successful import/execution of the three repo `.ts` modules is the strongest available check that
  the cited sources are intact and behave as claimed; the production-store dedup semantics used by
  the demo are reproduced from `sqlite-store.ts:69-83` and `db/schema.ts:46-48`.
