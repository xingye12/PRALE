# T18 — Duplicate source/build submission creates no duplicate effective work

Repository: `tdam` · Component under test: `MemoryKnowledge` · Mode: `contract`

## Contract statement

Two layers jointly guarantee that resubmitting the same source/build does not
produce duplicate effective work:

| Layer | Location | Guarantee |
|---|---|---|
| Lane registry | `MemoryKnowledge/src/store/build-queue.ts` (`BuildQueue.enqueue`, lines 15–24) | Every asset key maps to exactly **one** `SerialQueue`; duplicate submissions for the same key share that lane. |
| Serial executor | `MemoryKnowledge/src/store/serial-queue.ts` (`SerialQueue.drain`, lines 81–101) | A lane runs at most one job at a time (`concurrency = 1`, FIFO), so same-key bodies never overlap. |
| Identity dedupe | `MemoryKnowledge/src/store/sqlite-store.ts` (`createCodeGraph`, lines 69–136) | Identity key `(service_id, team_id, repo_url, branch)` returns `existed: true` for a duplicate; a raced insert re-selects the same row. |
| Service orchestration | `MemoryKnowledge/src/store/code-graph-service.ts` (`create`, 132–139; `sync`, 153–171) | `create` enqueues only when `!existed`; `sync` returns `busy` while pending/processing and enqueues nothing. |
| API surface | `MemoryKnowledge/src/routes/code-graph.ts` (POST `/sync`, 265–283) | Duplicate in-flight submission is answered `409 {code:409, message:"busy"}` instead of queueing work. |

Net effect: a duplicate **create** yields the same `code_graph_id` with one
build; a duplicate **sync** while in flight is rejected without a second build.
Only an explicit `sync` on a settled asset is a versioned rebuild (`version + 1`),
which is new work by design, not duplication.

## Executable demo

`/.prale-eval/validate.mjs` imports the repository's **real** sources — no copy,
no reimplementation, no build step, no dependencies. It runs on Node 24 using
built-in TypeScript type stripping; `.prale-eval/ts-resolve-hook.mjs` (registered
by `.prale-eval/register-hook.mjs`) rewrites relative `./x.js` specifiers to the
sibling `x.ts` files so the ESM graph of the unmodified sources loads.

Run from the workspace root:

```
node --import ./.prale-eval/register-hook.mjs ./.prale-eval/validate.mjs
```

### What it asserts

Part A — real `BuildQueue`:

1. Duplicate same-key enqueue → max observed in-flight concurrency **1**, both
   jobs still execute (serialized, not dropped).
2. Distinct asset keys → independent lanes, concurrency reaches **2**.
3. `onIdle(key)` is a correct drain barrier for a single lane.

Part B — real `CodeGraphService` wired to a minimal in-memory `IKnowledgeStore`
that mirrors `SqliteKnowledgeStore.createCodeGraph`'s identity semantics:

4. Duplicate `create` with identical identity → second call `existed: true`,
   **same** `code_graph_id`, injected worker runs **exactly once**, status `ready`.
5. Duplicate `sync` while the build is in flight → `kind: "busy"`, worker still
   at **one** run; a later `sync` on the settled asset is `ok`, `version: 2`, and
   produces the expected **second** (legitimate, versioned) run.

### Observed result

```
PASS  BuildQueue: same-key duplicate submission never overlaps (max concurrency = 1)
PASS  BuildQueue: distinct asset keys get independent lanes (concurrency can be 2)
PASS  BuildQueue: onIdle(key) resolves only after that key's queue drains
PASS  CodeGraphService: duplicate create is idempotent — one row, one effective build
PASS  CodeGraphService: sync during in-flight build returns busy and enqueues nothing

5/5 checks passed
```

Exit code `0`.

## Normalized operation result

| Operation | Duplicate submission | Effective builds created | Returned shape |
|---|---|---|---|
| `create` (same identity) | 2nd call | 0 additional (1 total) | `existed: true`, same `code_graph_id` |
| `sync` while pending/processing | any | 0 additional | `{ kind: "busy", status, step }` → HTTP 409 |
| `sync` after ready/failed | each call | 1 per call | `{ kind: "ok", row }`, `version + 1` |

## Validation limitations

`vitest` and `tsx` (the repository's declared test/dev tooling) are not installed
and there is no `node_modules`, so `pnpm test` / `vitest run` could not be
executed; the dependency-free Node harness above stands in for it. For the same
reason `SqliteKnowledgeStore` (needs `better-sqlite3` + `drizzle-orm`) could not
be instantiated, so the service-level checks use an injected in-memory store that
reproduces its documented identity/dedupe semantics. No repository file was
modified by this task; all new artifacts live under `.prale-eval/`.
