# Repair: migrated sessions could not be found by the normal reader

Task: `advanced/session-integrity/transfer` · Repository: `earendil-works/pi` · Mode: `repair`

## Symptom

`migrateSessionsFromAgentRoot()` moved legacy `~/.pi/agent/*.jsonl` files into
`~/.pi/agent/sessions/<encoded-cwd>/`, but `SessionManager` (the canonical lookup used by
`list`, `continueRecent`, `findById`, `create`, …) never looked there for some cwds, so a
migrated session became invisible.

## Failure chain (cross-module)

1. `packages/coding-agent/src/migrations.ts` re-implemented the directory encoding locally:
   ``--${cwd.replace(/^[/\\]/, "").replace(/[/:]/g, "-")}--`` — it collapsed `/` and `:` but
   **left `\` intact**.
2. `packages/coding-agent/src/core/session-manager.ts` (the reader/lookup side,
   `getDefaultSessionDirPath`) used ``--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\]/g, "-")}--``
   — it collapsed `/` and `\` but **left `:` intact**.
3. The two encoders were therefore two different functions sharing a comment that claimed they
   were the same ("same encoding as session-manager.ts"). For any cwd containing a backslash, a
   colon, or a Windows-style fragment embedded in an absolute POSIX path, the migration wrote the
   file into a different directory than the one the reader derives from the same `cwd`:
   * backslash: the migration produced a directory whose *name* contains `\` (one extra nested
     level on POSIX), while the reader looks at the `-`-collapsed name;
   * colon: the reader produced `--srv-pi-work:main-app--`, while the migration produced
     `--srv-pi-work-main-app--`.
4. Result: `SessionManager.list(cwd)` returns `[]`, `continueRecent` creates a fresh session, and
   the migrated transcript is orphaned.

Note that the repository's own contract test
(`packages/coding-agent/test/sdk-session-manager.test.ts:38`) pins the encoding as
`/^[/\\]/` strip + `[/\\:]/g → "-"`, i.e. **all three** of `/`, `\`, `:` collapse; the reader side
was the half that had drifted from that contract.

## Fix (minimal, API-preserving)

* `packages/coding-agent/src/core/session-manager.ts`: the canonical encoder
  `getDefaultSessionDirPath()` now collapses `[/\\:]` (added `:`), and documents that it is the
  single canonical encoding. No exported signature changed (`getDefaultSessionDir(cwd, agentDir)`
  is untouched and still creates the directory).
* `packages/coding-agent/src/migrations.ts`: the duplicated private encoding was **deleted**;
  `migrateSessionsFromAgentRoot()` now asks the session manager for the directory with the
  already-exported `getDefaultSessionDir(cwd, agentDir)`. `getDefaultSessionDir()` also performs the
  `mkdirSync(..., { recursive: true })` the migration used to do inline, so no directory-creation
  code is lost.

This removes the duplication that caused the incident: producer (migration) and consumer (reader)
can no longer disagree, because there is exactly one implementation and migration delegates to it.
`getDefaultSessionDir()` additionally normalises cwd through `resolvePath()` like the reader does,
so `..`/`.`/trailing-slash forms are handled consistently too.

Behaviour that was already correct and is deliberately unchanged: malformed session files are
skipped, an existing target is never overwritten (`if (existsSync(newPath)) continue`), the source
file is left in place on collision (no data loss), and re-running the migration is a no-op.

## Validation

Command (from the workspace root):

```sh
node --experimental-vm-modules .prale-eval/regression.mjs
```

`.prale-eval/regression.mjs` loads the real modules through the read-only
`.prale-eval/subject.mjs` (`createSessionPipeline`) and only fixes external boundaries
(`getAgentDir`, deterministic `fs.readdirSync` ordering). It asserts across module boundaries for
five absolute POSIX cwds that mix `/`, `\`, `:` and non-ASCII text (including
`/mnt/c/C:\Users\dev\プロジェクト 😀/repo`):

1. `session.getDefaultSessionDir(cwd, agentDir)` equals
   `join(agentDir, "sessions", "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--")`, and
   the directory name contains neither `:` nor `\`.
2. After `migration.migrateSessionsFromAgentRoot()`, the file is in that canonical directory, is
   gone from the agent root, and its bytes are identical (`Buffer.compare === 0`).
3. `await SessionManager.list(cwd)` discovers exactly one session at that path with the original
   header id/cwd, `messageCount === 2` (the injected malformed line is skipped) and Unicode
   `firstMessage` intact.
4. `loadEntriesFromFile()` returns the surviving entries in file order
   (`session, message, message, session_info`) and `SessionManager.open()` yields the same entry id
   order with the original Unicode payloads.
5. Two extra migration runs leave a byte-for-byte directory snapshot unchanged (idempotent).
6. Collision case: a pre-existing target session file keeps its exact bytes and the colliding
   legacy source is preserved, while the reader still finds the canonical session.

Mutation check (each changed file alone restored to its `HEAD` faulty baseline, then repaired
again):

| Restored file | Result | Observed failure |
| --- | --- | --- |
| `core/session-manager.ts` | exit 1 | `AssertionError: session manager lookup must encode slashes, backslashes and colons for cwd "/srv/pi/work:main/app"` (actual `--srv-pi-work:main-app--`) |
| `migrations.ts` | exit 1 | `AssertionError: migration must place legacy-backslash.jsonl in the canonical session dir for cwd "/srv/pi/work\\legacy\\deep"` |

Both are uncaught `node:assert/strict` assertion failures — no crash, import error or timeout.
Temporary inputs are created under `.prale-eval/.tmp-session-migration/` and removed in a
`finally` block, so nothing outside `.prale-eval/` is touched.

## Limitations

The workspace has no installed `node_modules`, so `npm`-based checks (`tsgo --noEmit`,
`biome check`, the `vitest` suites) could not be run; no dependency was installed. TypeScript
syntax validity of both edited modules is still exercised on every run, because `subject.mjs`
parses them with `node:module`.stripTypeScriptTypes before linking.
