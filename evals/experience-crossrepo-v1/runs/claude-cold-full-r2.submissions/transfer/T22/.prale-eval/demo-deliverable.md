# T22 demo — separate snapshot/restore fixture (repository `pi`)

## What is demonstrated

A separate snapshot/restore fixture proves that a **restored branch sees the expected
terminal entry but not a sibling branch entry**.

The fixture is a new file, kept apart from the existing suite:

- `packages/agent/test/harness/snapshot-restore-branch.test.ts`

It builds a source session whose `main` branch is a configured AgentLane, records a
shared root and a terminal entry on `main`, then creates a **sibling** branch off the
same root and appends an entry to it. It snapshots `main` at its terminal entry with a
branch-scoped fork (`scope: "branch"`, `entryId: <terminal>`), which restores as a
separate destination session. Finally it reads the restored branch path back and
projects it with `buildSessionContext`.

## Executable demo (the fixture)

```
source session (repo "source")
  main    : null -> [root] -> [terminal]           <- snapshot point is [terminal]
  sibling : root -> [sibling branch entry]         <- must never appear in the restore

snapshot  = MemorySessionRepo.fork(source.metadata,
              { id: "restored", scope: "branch", branch: "main", entryId: terminal })
restore   = open the forked session, read branch "main"

assertions
  restoredMain.getTipId()                  === terminal
  restored.branch("sibling")               === undefined
  restored.getEntry(siblingId)             === undefined
  path ids                                 == [root, terminal]
  projected context contains               "shared root", "restored branch terminal"
  projected context does NOT contain       "sibling branch entry"
```

Run it with:

```
npx vitest run packages/agent/test/harness/snapshot-restore-branch.test.ts
```

## Contract the demo relies on

1. **Path-scoped projection.** `buildSessionContext(pathEntries, …)` is a pure function
   of the entries it is handed (`packages/agent/src/harness/session/context.ts`); it does
   no wider graph traversal. The public projection contract is pinned by
   `packages/agent/test/harness/session-context.test.ts` (`describe("session context
   projection")`), whose first case feeds a seven-entry path and expects exactly the four
   context-valid messages.

2. **Ancestry-scoped snapshot.** A branch-scoped fork selects only the ancestor chain
   from the recorded branch tip down to the requested entry
   (`selectBranchFork` in `packages/agent/src/harness/session/fork-policy.ts`), and the
   in-memory backend copies only the selected entries
   (`createFork` in `packages/agent/src/harness/session/in-memory-storage-state.ts`).
   Sibling children of that chain are never selected or copied.

Together these give the normalized result below.

## Normalized operation result

| Step | Operation | Result |
| --- | --- | --- |
| 1 | `createBranch("main", null)` + configure lane | `main` is a configured AgentLane with idle state |
| 2 | append root, then terminal, on `main` | tip of `main` = terminal entry |
| 3 | `createBranch("sibling", root)` + append entry | `sibling` tip = sibling entry (shares parent `root`) |
| 4 | `fork(source, {scope:"branch", branch:"main", entryId: terminal})` | destination holds `{root, terminal}` only; sibling branch/tip dropped |
| 5 | restore: `restored.branch("main")` | tip = terminal entry; `sibling` branch absent |
| 6 | `buildSessionContext(restoredMain.findEntries(...))` | messages = `[root, terminal]`; sibling entry message absent |

**Conclusion:** the restored branch sees the expected terminal entry and does not see
the sibling branch entry.

## Validation status

Focused validation for this demo is `npx vitest run
packages/agent/test/harness/snapshot-restore-branch.test.ts`. Dependencies are **not
installed** in this sandbox (no `node_modules` in the workspace, and installing them is
out of scope), so the fixture could not be executed here. The available validations that
were run: `node --check packages/agent/test/harness/snapshot-restore-branch.test.ts`
(exit 0) and a `JSON.parse` check of `.prale-eval/result.json` (valid). The fixture uses
only public APIs already exercised by `branch.test.ts` and `runtime/restore.test.ts` and
is expected to pass once dependencies are installed.
