# T22 demo — snapshot/restore fixture proves restored-branch context scoping

**Repository:** `pi` · **Mode:** `demo` · **Task:** `T22`

## What this demo is

A self-contained, executable fixture at `.prale-eval/demo/snapshot-restore-fixture.ts`.
It snapshots a durable session storage log to JSON, restores it into a **separate**
fresh store, then projects the restored branch through the repository's real
`buildSessionContext`. It proves the restored branch sees its expected terminal
entry but **not** a sibling branch entry.

The fixture is separate from the acceptance test
(`packages/agent/test/harness/session-context.test.ts`) — it does not modify it —
but it exercises the same public projection contract.

## Run it

```bash
node .prale-eval/demo/snapshot-restore-fixture.ts
```

Exit code `0` on success, `1` on any failed assertion. The process prints a JSON
report and a final `DEMO PASSED` / `DEMO FAILED` line.

> Dependency note: workspace `node_modules` is not installed, so `vitest` cannot
> run and `npm install` was intentionally not performed (task constraint). The
> demo runs under Node 24 native TypeScript type-stripping. This works because
> every *runtime* import on the exercised path is workspace-relative (`.ts`); the
> only bare-specifier imports in those modules are type-only and are erased.

## Fixture topology

Entries are linked purely by `parentId`, exactly as the acceptance test's
`messageEntry(id, parentId, seq, message)` helper builds them:

```
root                     (message: "root question")
├── feature-1            (message: "feature step 1")            branch "feature"
│   └── feature-2        (message: TERMINAL_TEXT)  <-- restored branch tip
└── sibling-1            (message: SIBLING_TEXT)   <-- sibling branch entry   branch "sibling"
```

* `TERMINAL_TEXT = "terminal entry on the restored feature branch"`
* `SIBLING_TEXT  = "entry on the sibling branch"`
* Branch tips are recorded as durable values with
  `setValue(branchTip("feature"), "feature-2")` and
  `setValue(branchTip("sibling"), "sibling-1")`.

## Contract exercised (normalized operation result)

| Step | Repository API used | Normalized result |
| --- | --- | --- |
| Build durable log | `insertEntry(...)`, `setValue(branchTip(...))`, `prepareStorageCommit(...)` | committed writes with `seq`/`timestamp` |
| Snapshot | `JSON.stringify(committedWrites)` | portable JSON string, no live storage reference |
| Restore | `new InMemoryStorageState()` + `validateCommitted` + `applyValidated` | **distinct** store instance holding the same entries/values |
| Resolve restored branch | `getValue(branchTip("feature"))`, `scanBranch({ start: tip, stopAtType: "compaction", order: "newestFirst" })` | `["root","feature-1","feature-2"]` |
| Project | `buildSessionContext(path, undefined, context)` | `[root question, feature step 1, TERMINAL_TEXT]` |

No projectors are registered, so the `context` argument is never dereferenced and
is passed as `undefined`.

## Assertions

1. Restored storage is a distinct instance from the source.
2. Restored `feature` tip is `feature-2` (the expected terminal entry).
3. Restored `feature` ancestry path is exactly `root,feature-1,feature-2`.
4. Projected context **contains** `TERMINAL_TEXT`.
5. Projected context **does not contain** `SIBLING_TEXT`.
6. Projected context has exactly 3 messages (one per path entry).
7. **Control:** `sibling-1` still exists in restored storage
   (`scanEntries` → `root,feature-1,feature-2,sibling-1`), and the sibling tip's
   path (`root,sibling-1`) does **not** include `feature-2`.

Assertions 6 and 7 together establish that the sibling omission is *branch
scoping*, not snapshot/restore data loss.

## Observed output

```json
{
  "fixture": "snapshot/restore branch projection",
  "restoredTip": "feature-2",
  "restoredBranchPathIds": ["root", "feature-1", "feature-2"],
  "restoredContextTexts": [
    "root question",
    "feature step 1",
    "terminal entry on the restored feature branch"
  ],
  "siblingPathIds": ["root", "sibling-1"],
  "restoredEntryIds": ["root", "feature-1", "feature-2", "sibling-1"],
  "pass": true,
  "failures": []
}
```

```
DEMO PASSED: restored branch sees its terminal entry but not the sibling entry.
```

## Why the result holds

`buildSessionContext` (`packages/agent/src/harness/session/context.ts:47`) does not
read storage and does not walk parents; it renders exactly the `pathEntries` it is
handed. The path comes from `InMemoryStorageState.scanBranch`
(`packages/agent/src/harness/session/in-memory-storage-state.ts:273`), which walks
`parentId` from the given tip to the root. Because `sibling-1`'s `parentId` is
`root` — a node not on `feature-2`'s ancestry — it is unreachable from the restored
`feature` tip. This is the same contract the acceptance test asserts at
`packages/agent/test/harness/session-context.test.ts:51-75`, where the chain of
entries linked by `parentId` is projected to exactly the messages on that chain.
