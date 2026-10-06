# T22 demo deliverable — snapshot/restore fixture for branch-scoped session context

Repository: `pi` · Task mode: `demo` · Requested behavior: a separate snapshot/restore fixture whose
restored branch sees its expected terminal entry but not a sibling branch entry.

## Executable demo

```
node packages/agent/test/harness/session-snapshot-restore-demo.ts
```

Runs from the repository root with the workspace Node (v24.14.0). Node strips the TypeScript types
natively, and the demo path deliberately avoids transport/telemetry dependencies, so the command
needs no `node_modules`. It exits non-zero with a descriptive error if any invariant breaks, and on
success prints the normalized result JSON shown below.

## Artifacts

| Path | Role |
| --- | --- |
| `packages/agent/test/harness/fixtures/session-snapshot-restore.json` | The separate, detached snapshot fixture (`ForkSourceSnapshot` data only, never a live session). |
| `packages/agent/test/harness/session-snapshot-restore-demo.ts` | Restore + projection routine, assertions, and the runnable entry point. |
| `packages/agent/test/harness/session-context-snapshot-restore.test.ts` | Vitest acceptance wrapper around the same demo (see "Validation limitation"). |

## Fixture contract

The fixture is one `ForkSourceSnapshot` serialized to JSON:

* entries (ascending `seq`): `root` (user message, `parentId: null`) → `main-terminal`
  (`terminate: true`, the expected terminal entry of the restored branch); and a sibling branch
  `root` → `sibling` holding its own assistant answer.
* scalar values: `pi.branch.tip` for `main` and `sibling`, matching `pi.lane.config` /
  `pi.lane.state` rows for both branches, and `pi.session.name`.
* `entriesComplete: true`.

Because both tips point at entries in the same entry set, the sibling is a genuine sibling-branch
entry on the shared root, not a dangling row.

## Restore + proof contract

`restoreSnapshot(snapshot, options)` is the restore step; it runs entirely through repository code:

1. `createForkSnapshot(snapshot, options)` builds the fork destination state (`scope: "tree"` keeps
   both branches, `scope: "branch", branch: "main"` keeps only the restored branch ancestry).
2. Every copied entry is re-committed into a fresh `InMemoryStorageState` with `insertEntry` and every
   copied scalar with `setValue`, in one `prepareCommit` / `applyValidated` transaction, then the
   destination `nextSeq` high-water mark is advanced. Parent validation runs inside that transaction.

`restoredBranchPath(state, "main")` reads the restored tip from `pi.branch.tip` and walks
`scanBranch({ start: tip, order: "oldestFirst" })`, and `buildSessionContext` projects that path —
exactly the projection exercised by the acceptance file
`packages/agent/test/harness/session-context.test.ts` (branch-order projection of one parent chain).

Invariants asserted per restore scope:

1. restored `main` tip is `main-terminal`;
2. restored `main` branch path is exactly `[root, main-terminal]`;
3. the restored terminal entry kept `terminate: true`;
4. the projected context texts contain `main branch terminal answer`;
5. the projected context texts never contain `sibling branch answer`;
6. `scope: "tree"`: the sibling entry is still present in restored storage and its own branch path is
   `[root, sibling]` whose context contains the sibling text and never the terminal text — so the
   exclusion from the restored branch is caused by branch ancestry, not by data loss;
7. `scope: "branch"`: the sibling entry and sibling tip are absent from the destination entirely,
   while the restored branch still projects the terminal entry.

## Normalized operation result

Executed output (abridged to the decision-relevant fields):

```
scope tree  -> tip "main-terminal" | branchPath [root, main-terminal]
               restoredEntryIds [root, main-terminal, sibling]
               siblingEntryPresentInRestore true | terminalEntryHasTerminateFlag true
               contextTexts ["restore this fixture branch", "main branch terminal answer"]
               contextSeesTerminalText true | contextSeesSiblingText false
               siblingBranchPathEntryIds [root, sibling]
               siblingContextTexts ["restore this fixture branch", "sibling branch answer"]
scope branch-> tip "main-terminal" | branchPath [root, main-terminal]
               restoredEntryIds [root, main-terminal]
               siblingEntryPresentInRestore false | siblingBranchPathEntryIds null
               contextSeesTerminalText true | contextSeesSiblingText false
```

Result: the restored branch sees the expected terminal entry (`main-terminal`, `terminate: true`) and
does not see the sibling branch entry in either restore scope.

## Negative checks (assertions are live)

| Injection | Observed failure |
| --- | --- |
| Remove the sibling entry + sibling tip | `tree restore dropped sibling entry sibling` |
| Re-point the restored tip at the sibling entry | `restored main tip is "sibling"` |
| Clear `terminate` on the terminal entry | `restored terminal entry main-terminal lost its terminate flag` |
| Remove the restored branch tip | `Source session branch "main" is missing branch.tip` |

## Validation limitation

`cd packages/agent && npx --no-install vitest --run --config vitest.harness.config.ts test/harness/session-context-snapshot-restore.test.ts`
cannot run in this checkout: there is no `node_modules`, and npx refuses to fetch the runner
(`npm error: npx canceled due to missing packages and no YES option: ["vitest@5.0.3"]`). Installing
dependencies is out of scope for this task, so the vitest wrapper is delivered unexecuted; its
assertions were mirrored by the dependency-free execution recorded above and in
`.prale-eval/result.json`.
