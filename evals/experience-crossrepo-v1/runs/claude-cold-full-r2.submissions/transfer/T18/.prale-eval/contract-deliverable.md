# T18 — Contract deliverable: duplicate source/build submission does not create duplicate effective work

- **Task:** T18 · **Repository:** `tdam` · **Mode:** `contract`
- **Subject under evaluation:** MemoryKnowledge (the knowledge service, `@tencentdb-agent-memory/knowledge-service`).
- **Request:** *Evaluate in MemoryKnowledge: prove duplicate source/build submission does not create duplicate effective work.*
- **Executable demo:** `.prale-eval/demo.mjs` (runs the real, unmodified repository sources).
- **Verdict:** **Holds.** 15/15 assertions pass, exit code 0.

---

## 1. The executable demo

```
cd .prale-eval
node --import ./register-hooks.mjs demo.mjs
```

### Why the hook file exists

`build-queue.ts` is dependency-free TypeScript but uses the NodeNext convention of
importing `./serial-queue.js` while the file on disk is `serial-queue.ts`. This
environment has no `node_modules` and no `tsx`/`ts-node`, so the demo loads the
**real** sources through Node 24's native type-stripping plus a tiny ESM resolve
hook:

- `.prale-eval/ts-resolve-hooks.mjs` — on a failed relative `.js` resolve, retries
  the same specifier with a `.ts` extension if that sibling exists.
- `.prale-eval/register-hooks.mjs` — registers the hook via `module.register`.

No repository file is copied, patched, or regenerated: the executed bytes are the
repository's own `MemoryKnowledge/src/store/build-queue.ts` and
`MemoryKnowledge/src/store/serial-queue.ts`.

### What the demo asserts

| # | Scenario | Assertions | Result |
|---|----------|-----------|--------|
| 1 | 5 duplicate submissions, same asset key, **real `BuildQueue`** | never concurrent (`maxConcurrent=1`); all retained; FIFO order | PASS ×2 |
| 2 | Two distinct asset keys | run in parallel (`maxConcurrent=2`) — per-asset isolation | PASS |
| 3 | Three rapid `ingest()` calls for one wiki | 1st `ok`, 2nd/3rd `busy`; worker invoked **exactly once**; asset ends `ready` | PASS ×4 |
| 4 | A duplicate that bypassed admission, asset deleted mid-run | duplicate contributes **0** extra worker invocations; never overlapped; nothing committed | PASS ×3 |
| 5 | Same source uploaded three times with identical content | `created, unchanged, unchanged`; only the first provokes build work; changed content still re-registers | PASS ×4 |
| 6 | `onIdle()` across keys | resolves only after all queued work drains | PASS |

---

## 2. The contract

The guarantee is **layered** — no single file provides it alone. Reading the
contract as "`BuildQueue` deduplicates" would be wrong; `BuildQueue` *serializes*.
Deduplication is completed by its callers.

### Layer 1 — Admission control (`MemoryKnowledge/src/store/wiki-service.ts:272-290`)

`ingest` returns `{ kind: "busy" }` while the asset is `pending` or `processing`
and **never calls `enqueueBuild`** in that branch. A duplicate build submission
therefore never becomes a queued job. This is the primary defense and the reason a
burst of identical `ingest`/`sync` calls yields exactly one build.

### Layer 2 — Per-asset single flight (`MemoryKnowledge/src/store/build-queue.ts:11-34`)

`BuildQueue` holds `Map<string, SerialQueue>` keyed by asset id. Each key lazily
gets **one** `SerialQueue` (`build-queue.ts:16-20`). `enqueue` is fire-and-forget
and **preserves** duplicates rather than dropping them. The delegated engine
(`serial-queue.ts:81-101`, `drain`) has concurrency 1: it returns early while a task
is running and re-drains only after the task settles. Consequence: even if a
duplicate slips past Layer 1 (e.g. two requests racing the status write), the two
jobs run strictly one-at-a-time and never conflict over the same git / SQLite /
filesystem state.

`enqueueBuild` keys the queue by `row.wiki_id` (`wiki-service.ts:1010-1012`) — the
same asset id the queue partitions on — which is what makes the two layers compose.

### Layer 3 — Worker checkpoints (`MemoryKnowledge/src/store/wiki-service.ts:1014-1077`)

`runBuild` consults `isDeleted` (`wiki-service.ts:366-368`: cancelled flag **or**
row missing) at both entry (`1016-1019`) and exit (`1039-1042`). A queued duplicate
whose asset was deleted before the job starts performs **zero** worker invocations;
one deleted mid-run commits no `ready` state, no audit row, and no callback. Both
checkpoints were exercised in demo scenario 4.

### Layer 4 — Source submission idempotency (`MemoryKnowledge/src/engines/wiki/index-db.ts:219-242`)

`upsertSource` is query-then-update, not a blind UPSERT:
insert on unknown filename → `created`; changed `sha256` → `updated` and reset to
`uploaded`; **unchanged `sha256` → `unchanged` with no write at all**. Its caller
`registerSources` (`wiki-service.ts:879-902`) hashes each upload before calling it.
Re-uploading identical source content is therefore inert: it neither resets the
row's ingested state nor provokes a rebuild. Changed content is still detected, so
the dedup is content-based rather than path-based.

---

## 3. Normalized operation results

The demo's observable outcomes, in the task's normalized form:

- **Duplicate build submission (live asset):** `N` submissions while `pending` ⇒
  `1` accepted (`ok`), `N-1` rejected (`busy`), `1` worker invocation, final status
  `ready`.
- **Duplicate build submission (asset deleted before the queued duplicate runs):**
  `1` invocation from the accepted build, `0` from the duplicate, `0` committed
  rows for the deleted asset.
- **Duplicate same-key concurrency:** `maxConcurrent === 1` for any number of
  same-key jobs; `maxConcurrent === 2` for two distinct keys.
- **Duplicate source submission:** outcomes `["created","unchanged","unchanged"]`;
  number of build-provoking writes `=== 1`.

---

## 4. Limitations (recorded, per instructions)

- **Unavailable validation dependency.** The full `wiki-service.ts` and
  `index-db.ts` modules import `better-sqlite3`, `lru-cache`, and the wiki engines;
  `node_modules` is not installed and dependencies must not be installed, so those
  modules cannot be imported here. Their admission / checkpoint / dedup logic is
  exercised through **faithful in-memory ports** in the demo that mirror the cited
  lines, each annotated with its real citation.
- **What is *not* ported.** The claim that actually lives in `build-queue.ts` — the
  per-asset single-flight serialization and `onIdle` drain — is validated by
  executing the **real file**, not a port. Layers 1, 3, and 4 are ported and
  labelled as such in the demo source.
- No dependency was installed; no file outside the workspace was read, written, or
  executed; task metadata, hidden-oracle files, package locks, and git
  configuration were not modified.
