# Repair: migrated sessions must land where the session manager looks

## Root cause

The legacy-session producer and the session reader each implemented their own
copy of the "encode a cwd into a `sessions/--<name>--` directory" rule, and the
two copies disagreed:

| module | encoded `/` | encoded `\` | encoded `:` |
| --- | --- | --- | --- |
| `packages/coding-agent/src/core/session-manager.ts` (`getDefaultSessionDirPath`) | yes | yes | **no** |
| `packages/coding-agent/src/migrations.ts` (`migrateSessionsFromAgentRoot`) | yes | **no** | yes |

For a cwd such as `/srv/Проект π/C:\Users\Ada Lovelace/unit:42` (an absolute
POSIX path that also contains Windows-style fragments and a colon):

* migration moved the file to `--srv-Проект π-C:\Users-Ada Lovelace-unit-42--`
* the session manager looked in `--srv-Проект π-C--Users-Ada Lovelace-unit-42--`

The migrate step "succeeded", but the file was unreachable through
`SessionManager.list` / `findById` / `continueRecent` / `open`, so migrated
sessions could not be found by the normal reader.

## Fix

Both sides now strip one leading separator and encode the full set of path
separators plus colon, i.e. the canonical form already asserted by the existing
SDK expectation (`packages/coding-agent/test/sdk-session-manager.test.ts`):

```ts
`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
```

* `session-manager.ts`: `[/\\]` → `[/\\:]` (colon is now encoded).
* `migrations.ts`: `[/:]` → `[/\\:]` (backslash is now encoded).

No API, signature, call site or unrelated behavior changed; only the two
encoding expressions (plus an explanatory comment) changed. This is a contract
between producer and consumer, so both files must change together: fixing only
one side moves the mismatch instead of removing it.

The task deliberately does not emulate Windows path resolution: a cwd is still
taken from the session header verbatim (no separator translation, no
drive-letter conversion, no `resolve()` of a raw Windows path on Linux), and the
session-manager side keeps its existing `resolvePath()` normalization.

## Why the regression test is cross-module

`.prale-eval/regression.mjs` loads the real `migrations.ts` and the real
`core/session-manager.ts` through `.prale-eval/subject.mjs` (only external IO
boundaries — `getAgentDir` and a sorted `readdirSync` — are supplied). It writes
legacy `.jsonl` files directly into the agent dir and then asserts observable
behavior:

1. `getDefaultSessionDir(cwd, agentDir)` equals the locally restated canonical
   name (so a "both sides agree on a wrong encoding" repair still fails).
2. After `migrateSessionsFromAgentRoot()`, each file exists at
   `sessions/<canonical>/<name>.jsonl` and no longer at the agent root.
3. The migrated file bytes are identical (Unicode payloads, entry order and the
   malformed/blank lines are preserved verbatim; the reader skips them).
4. The real reader finds it: `SessionManager.findById`, `SessionManager.list`
   (id, path, cwd, message count, Unicode first message) and
   `SessionManager.open` (`getHeader().cwd`, `getEntries()` in file order).
5. Collision: an existing canonical file is never overwritten and the colliding
   legacy file is not discarded.
6. Idempotence: running the migration twice more leaves the whole agent-dir tree
   byte-identical and creates nothing new.
7. Cleanup: all fixtures live under `.prale-eval/tmp/` and are removed in a
   `finally` block, so manual validation stays inside the workspace.

Mutation check (performed locally, each source file reverted alone to the faulty
baseline and then restored byte-for-byte):

* `migrations.ts` reverted → failure at "migration wrote … to the canonical
  directory" (`false !== true`).
* `session-manager.ts` reverted → failure comparing the canonical directory
  (`--srv-Проект π-C:-Users-Ada Lovelace-unit:42--` vs the canonical encoding).

Neither mutation produced an import error, crash or timeout, so both count as
detected regressions.

## Validation

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

Result: `session transfer regression: ok` (exit 0). No dependencies, network,
credentials or clock/randomness are used as evidence; `SessionManager.list()` is
the only async step and its ordering is deterministic for the fixtures.

Limitation: `node_modules` is not installed in this workspace, so the
repository's own `tsc`/`vitest`/`biome` checks could not be executed here. The
required Node 24 regression command above is dependency-free and passed; the
TypeScript edit is a one-token change to an existing regex literal in each file.
