# Operate deliverable — JSONL/session lineage report (task 04, repo `pi`)

## What was operated

The repository's JSONL/session utilities replay a session from an on-disk v4 JSONL
file and project a branch's entry path into context. This deliverable **operates**
that algorithm on a supplied tiny fixture and emits a **lineage report**:

- **session ID** — the `id` in the JSONL header line.
- **branch tip** — the value stored at `pi.branch.tip` for the `main` branch
  (`packages/agent/src/harness/session/values.ts` → `branchTip(branch)`).
- **parent relation** — the chain recovered by walking `parentId` from the tip to
  the `null` root.
- **replay result** — the re-materialized entries, values, usage and the projected
  context messages.

## Executable demo

```
node .prale-eval/lineage-demo.mjs
```

The script is dependency-free (Node built-ins only). It:

1. Writes the supplied fixtures to `.prale-eval/fixtures/`.
2. Replays each fixture with the algorithm below.
3. Prints the lineage report to stdout and writes `.prale-eval/lineage-report.json`.
4. Runs 11 self-check assertions and exits non-zero on any mismatch.

It exits `0` with `lineage self-check: OK (11 assertions)`.

### Why the algorithm is re-implemented

The real utilities are TypeScript under
`packages/agent/src/harness/session/jsonl/*` and are exercised by
`packages/agent/test/harness/jsonl-storage.test.ts` and
`packages/agent/test/harness/session-context.test.ts`. Running those suites needs
the monorepo's installed workspace dependencies (vitest, tsx,
`@earendil-works/pi-ai`, …). This sandbox has **no `node_modules`**, and
dependencies must not be installed, so the demo faithfully mirrors the production
algorithm instead of importing it:

| Demo function | Mirrors |
| --- | --- |
| `splitCompleteLines` | `jsonl/storage.ts` torn-tail split |
| `parseJsonlTransaction` / `parseCommittedWrite` | `jsonl/io.ts` transaction parsing + validation |
| `openJsonl` | `JsonlStorage.openV4` (header check, per-line replay, truncate torn tail) |
| `ReplayState.apply` | `in-memory-storage-state.ts` `applyValidated` (entry/value/list/usage) |
| `buildSessionContext` | `session/context.ts` `buildContextEntries` + `sessionEntryToContextMessages` |

## Supplied fixtures

`fixtures/tiny-session.jsonl` — v4 header plus four committed transactions
(one multi-write array line, single-write object lines), holding entries
`e1 → e2 → e3` on branch `main`:

```
{"v":4,"kind":"header","id":"ses_tiny_lineage_04",...}
[ entry e1 (user, parent null, seq 1), value set pi.branch.tip/main = "e1" (seq 2) ]
entry e2 (assistant stop, parent e1, seq 3)
[ value set pi.branch.tip/main = "e2" (seq 4), value set pi.session.name = "tiny-lineage" (seq 5) ]
entry e3 (assistant error, parent e2, seq 6)
value set pi.branch.tip/main = "e3" (seq 7)
```

`fixtures/tiny-session-torn.jsonl` — the same first five lines plus an
**unterminated** final record `e4-torn` (no trailing newline).

## Operated lineage report (normalized)

Primary scenario (`tiny-session`):

```json
{
  "sessionId": "ses_tiny_lineage_04",
  "branch": "main",
  "branchTip": { "address": "pi.branch.tip/main", "value": "e3", "seq": 7 },
  "parentRelation": [
    { "id": "e1", "parentId": null,  "type": "message", "seq": 1 },
    { "id": "e2", "parentId": "e1", "type": "message", "seq": 3 },
    { "id": "e3", "parentId": "e2", "type": "message", "seq": 6 }
  ],
  "replay": {
    "torn": false,
    "nextSeq": 8,
    "entries": ["e1@1", "e2@3", "e3@6"],
    "values": ["pi.branch.tip/main = e3@7", "pi.session.name = tiny-lineage@5"],
    "contextMessages": ["user:root question", "assistant(stop):accepted answer"]
  }
}
```

The tip entry `e3` has `stopReason: "error"`, so it is part of the lineage but is
**filtered out of context** by the projection contract — the same behavior the
`session-context.test.ts` "filters non-context assistant response entries"
case asserts.

Torn-tail scenario (`tiny-session-torn`):

```json
{
  "sessionId": "ses_tiny_lineage_04",
  "branchTip": { "value": "e2", "seq": 4 },
  "parentRelation": ["e1@1", "e2@3"],
  "replay": {
    "torn": true, "truncated": true, "nextSeq": 7,
    "entries": ["e1@1", "e2@3", "e3@6"],
    "contextMessages": ["user:root question", "assistant(stop):accepted answer"]
  }
}
```

The unterminated `e4-torn` record is discarded and the file is truncated (mirrors
`describe("JsonlStorage torn tail")`), while the complete `e3` entry survives; the
branch tip stays at the last fully committed `pi.branch.tip` write (`e2`).

## Contract

- **Input:** a v4 JSONL session (header line + one transaction per line; a single
  write serialized as an object, several as an array).
- **Output:** the lineage report with `sessionId`, `branchTip`, `parentRelation`
  (root → tip) and `replay` (torn flag, nextSeq, entries, values, usage, context).
- **Failure modes:** missing/invalid header or a complete-but-malformed line
  raises `Invalid JSONL storage <path>: line N`; an unterminated final line is
  silently discarded and truncated, never replayed.

## Validation

```
$ node .prale-eval/lineage-demo.mjs
lineage self-check: OK (11 assertions)
$ echo $?
0
```

**Limitation (recorded):** the focused upstream suites
`packages/agent/test/harness/jsonl-storage.test.ts` and
`packages/agent/test/harness/session-context.test.ts` could not be run here
because the workspace has no installed dependencies (`node_modules` absent,
vitest/tsx unavailable) and installing dependencies is out of scope. The demo's
self-check stands in for them and asserts the same documented contract.
