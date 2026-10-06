# T15 — Snapshot/restore fixture demo (repository `pi`)

## What is demonstrated

A **separate** snapshot/restore fixture captures one session tree that contains
two sibling leaves under a shared root, restores only one branch from that
snapshot, and proves the restored branch sees its **terminal entry** while never
seeing the **sibling branch entry**.

Fixture files added:

- `packages/agent/test/harness/fixtures/session-snapshot-restore.fixture.ts` — the separate, executable fixture (also runnable as a plain Node script).
- `packages/agent/test/harness/session-snapshot-restore.test.ts` — a thin vitest wrapper that runs the fixture against `BACKGROUND_CONTEXT`.

## Contract exercised

The demo is built only from production primitives, so it is a real normalized
operation result rather than a mock:

- `createForkSnapshot(source, { scope: "branch", branch })` (`packages/agent/src/harness/session/fork.ts`) — snapshot/restore boundary that copies only the selected branch's ancestor path and drops off-branch entries.
- `buildSessionContext(pathEntries, options, context)` (`packages/agent/src/harness/session/context.ts`) — projects an ordered entry path into model messages; off-path entries can never appear.

The snapshot is a `ForkSourceSnapshot` of three entries plus branch scalar
values:

```
snapshot-root            (root message)
├── snapshot-main-terminal   branch "main" tip   -> "main terminal response"   (terminal entry)
└── snapshot-sibling-leaf    branch "sibling" tip -> "sibling branch response" (sibling branch entry)
```

## Executable demo

```
node packages/agent/test/harness/fixtures/session-snapshot-restore.fixture.ts
```

The fixture runs its own assertions (it throws on any violation) and prints the
normalized operation result. It exits `0` when the contract holds.

## Normalized operation result (observed)

```json
{
  "restoredBranch": "main",
  "restoredTipId": "snapshot-main-terminal",
  "restoredEntryIds": ["snapshot-root", "snapshot-main-terminal"],
  "treeEntryIds": ["snapshot-main-terminal", "snapshot-root", "snapshot-sibling-leaf"],
  "restoredContextTexts": ["shared root", "main terminal response"],
  "restoredContextRoles": ["user", "user"],
  "seesTerminalEntry": true,
  "seesSiblingEntry": false,
  "treeRestoreSeesSiblingEntry": true
}
```

## Proof obligations

| Obligation | Result |
| --- | --- |
| Restored branch tip is the terminal entry | `restoredTipId = "snapshot-main-terminal"` ✅ |
| Restored branch path contains the terminal entry | `restoredEntryIds` includes `snapshot-main-terminal` ✅ |
| Restored branch path excludes the sibling entry | `restoredEntryIds` excludes `snapshot-sibling-leaf` ✅ |
| Restored context contains the terminal message | `restoredContextTexts` includes `"main terminal response"` (`seesTerminalEntry = true`) ✅ |
| Restored context excludes the sibling message | `restoredContextTexts` excludes `"sibling branch response"` (`seesSiblingEntry = false`) ✅ |
| Sibling omission is caused by branch-scoped restore, not by fixture construction | Whole-tree restore control (`restoreTreeSnapshot`) retains `snapshot-sibling-leaf` (`treeRestoreSeesSiblingEntry = true`) ✅ |

## Public acceptance-contract citations

`packages/agent/test/harness/session-context.test.ts` defines and exercises the
session-context projection contract this demo depends on:

- `messageEntry` (lines 46–48) — builds the `id/parentId/seq` entry wire shape the snapshot reuses.
- `describe("session context projection")` (lines 50–75) — first projection case calls `buildSessionContext(entries, undefined, BACKGROUND_CONTEXT)` and asserts branch-order messages.
- `buildSessionContext` call at lines 69–74 — proves only on-path entries project into context, the exact property that hides the sibling after a branch-scoped restore.

## Validation

- **Passed:** `node packages/agent/test/harness/fixtures/session-snapshot-restore.fixture.ts` (exit 0; output above).
- **Limitation:** the focused vitest command `npm --prefix packages/agent run test:harness -- --run session-snapshot-restore` could not run because the optional validation dependency `vitest` is not installed in this workspace (`sh: 1: vitest: not found`). Per task instructions, dependencies were not installed; the standalone Node execution of the same fixture (Node 24 native TypeScript stripping) is the strongest available validation and exercises the identical code path.
