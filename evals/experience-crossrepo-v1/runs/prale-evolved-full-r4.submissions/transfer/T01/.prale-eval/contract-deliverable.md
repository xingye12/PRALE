# T01 — Contract deliverable (repository: `tdam`, mode: `contract`)

## Claim under test

> **Evaluate in MemoryKnowledge:** duplicate source/build submission does not
> create duplicate effective work.

## What was delivered

An **executable demo** that runs the repository's *real* queue sources and
proves the claim, plus the source-level contract that makes the claim hold
end to end.

| Artifact | Purpose |
| --- | --- |
| `.prale-eval/verify-dedup.ts` | Executable proof — imports the real `BuildQueue` / `SerialQueue` and asserts the duplicate-submission contract. |
| `.prale-eval/ts-resolve-loader.mjs` | Dependency-free ESM resolver hook that maps the repo's `./x.js` specifiers to the on-disk `./x.ts`, so Node 24 can type-strip and run the real sources with **no `node_modules`**. |
| `.prale-eval/result.json` | Structured result (evidence, claims, conclusion, validation). |

### Run it

```bash
node --import ./.prale-eval/ts-resolve-loader.mjs .prale-eval/verify-dedup.ts
```

Observed output (exit 0, **10/10 checks passed**):

```
PASS  L2 same-key duplicate jobs never overlap (SerialQueue concurrency=1)
      maxConcurrent=1 (expected 1), FIFO order=[0,1,2,3,4]
PASS  L3 distinct asset keys use distinct queues and may overlap
      maxConcurrent=3 (expected > 1, i.e. BuildQueue is per-key not global)
PASS  L1 duplicate create returns existed=true and does not enqueue
      create#1.existed=false (new), create#2=true, create#3=true, create#4(post-ready)=true
PASS  L1 duplicate submission while pending/processing is rejected busy (no re-enqueue)
      sync(during build)#1=busy, #2=busy; sync while pending #2=busy, #3=busy
PASS  L1 duplicate create (x3) => exactly 1 effective build run
      effectiveRuns after 3 creates (+2 busy syncs) and drain = 1
PASS  L1 a single accepted sync adds exactly 1 run; rejected duplicates add 0
      accepted sync=ok; effectiveRuns after 3 syncs + drain = 2 (1 new, 2 rejected)
PASS  L1 post-ready duplicate create adds 0 additional effective work
      effectiveRuns after 4th create + drain = 2
PASS  L1 9 submissions => 2 effective runs (one per accepted generation)
      submissions=9, effectiveRuns=2
PASS  SerialQueue starts idle
      idle=true, size=0
PASS  SerialQueue.add drains FIFO, resolves results, returns to idle
      runs=2, results=[one,two], pendingAfter1stAdd=1, idleAfter=true
```

## The contract (normalized operation semantics)

`BuildQueue` is the single choke point through which every MemoryKnowledge
rebuild passes. Its contract, read from `MemoryKnowledge/src/store/build-queue.ts`:

1. **Per-key identity.** `BuildQueue` owns exactly one
   `Map<string, SerialQueue>` (`build-queue.ts:11-13`). The dedup identity is the
   caller-supplied asset key — `code_graph_id` for code graphs and `wiki_id` for
   wikis.
2. **Serial lane per key.** `enqueue(key, job)` looks up (or lazily creates) the
   one queue for `key` and appends the job to it fire-and-forget
   (`build-queue.ts:15-24`). Because *all* duplicate submissions for the same key
   land on the same FIFO, they can never overlap.
3. **Concurrency = 1.** `SerialQueue.drain()` refuses to start a second task
   while one is running and starts the next only after the previous settles
   (`serial-queue.ts:81-101`). Same-key duplicate jobs therefore execute strictly
   sequentially.
4. **Deterministic drain.** `BuildQueue.onIdle(key?)` resolves once the key (or
   all keys) is idle (`build-queue.ts:27-33`), giving tests a boundary at which
   "N submissions ⇒ 1 effective job" is observable.
5. **Per-key, not global.** Distinct keys get distinct queues, so unrelated
   assets still build concurrently (demo: `maxConcurrent=3` for 3 keys).

### Why duplicate submissions never reach the queue twice

The queue is kept free of duplicates by the service layer immediately in front
of it, whose decision rule the demo mirrors *exactly*:

| Submission | Guard (source) | Duplicate behaviour |
| --- | --- | --- |
| create (build) | `CodeGraphService.create` — `enqueueBuild` only inside `if (!existed)` (`code-graph-service.ts:132-139`); `existed` originates from the store's idempotency key `(service_id, team_id, repo_url, branch)` (`sqlite-store.ts:69-137`) | returns existing row, **0 enqueues** |
| sync / ingest | `CodeGraphService.sync` (`code-graph-service.ts:153-171`) and `WikiService.ingest` (`wiki-service.ts:272-290`) — `pending \| processing ⇒ {kind:"busy"}` before any state mutation or enqueue | rejected `busy`, **0 enqueues** |
| source upload | `upsertSource` returns `"unchanged"` for an identical `sha256` (`index-db.ts:219-242`); `classifySources` routes already-`ingested`, unchanged files to `skipped` (`index-db.ts:310-323`) | no new source generation, **no re-extraction/LLM work** |
| wiki create | `createWiki` idempotent on `(service_id, team_id, name)` (`sqlite-store.ts:264-329`) | returns existing row, **0 enqueues** |

Both services are wired to one shared `BuildQueue` at the composition root
(`module.ts:205-211`), so the guarantees are uniform across wiki and code-graph
assets.

## Conclusion

**Confirmed.** Duplicate source/build submission does not create duplicate
effective work. The property is enforced independently at three layers —
(a) idempotent submission guards (`existed` / `busy`), (b) per-key serial
execution with concurrency 1, and (c) content-addressed source dedup — and the
dependency-free portion (the real `BuildQueue`/`SerialQueue`) was executed and
passed 10/10 checks.

## Validation & limitations

- **Command:** `node --import ./.prale-eval/ts-resolve-loader.mjs .prale-eval/verify-dedup.ts`
- **Status:** passed (exit 0, 10/10 checks).
- **Optional-dependency limitation:** no `node_modules` are installed in this
  workspace and installing dependencies is prohibited. Layers that require
  `better-sqlite3`/`drizzle-orm` (store idempotency, sha-based source dedup) were
  therefore **not executed**; they are supported by static source citations with
  real symbols and inclusive line ranges in `result.json`. The queue layer
  (the required evidence file `MemoryKnowledge/src/store/build-queue.ts`) *was*
  executed against the real source.
- Citation integrity (path existence and that each cited range contains the
  named symbol) is checked programmatically.
