# Repair: legacy session migration and canonical session lookup disagreed on the encoded cwd

## Symptom

`migrateSessionsFromAgentRoot()` (`packages/coding-agent/src/migrations.ts`) moves the
legacy `~/.pi/agent/*.jsonl` files (the v0.30.0 bug) into
`~/.pi/agent/sessions/<encoded-cwd>/`, which is the directory the session manager
(`packages/coding-agent/src/core/session-manager.ts`) looks in. The migration computed
that directory with its own copy of the cwd->directory-name encoding, and the two copies
were not the same character class:

| location | leading-separator strip | separator replace |
| --- | --- | --- |
| `session-manager.ts` `getDefaultSessionDirPath()` | `/^[/\\]/` | `/[/\\]/g` (missing `:`) |
| `migrations.ts` `migrateSessionsFromAgentRoot()` | `/^[/\\]/` | `/[/:]/g` (missing `\`) |

The result is a *migration that silently succeeds and a reader that cannot find the
file*. Migration creates (and moves into) `--…--` with colons preserved, while the session
manager looks up `--…--` with colons encoded, or – for a cwd containing a backslash – the
migration keeps the backslash while the reader replaces it. Both directories live under
`sessions/`, so nothing errors out; the session is simply invisible to `SessionManager.list`,
`SessionManager.listAll`, `SessionManager.continueRecent`, `SessionManager.findById` and
`SessionManager.open` (via the default lookup path).

The scenario is reachable on POSIX: an absolute POSIX cwd may legitimately contain a
colon and a backslash (a Windows-style fragment such as `/mnt/drive/C:\Users\alice\src`
inside an absolute POSIX path). No Windows path *resolution* is involved or emulated —
only the directory-name encoding.

## Contract

The canonical encoding already exists elsewhere in the repository and is the reference
this repair restores:

- `packages/agent/src/harness/session/jsonl/repo.ts` `sessionDirectoryName()`:
  `` `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` ``
- `packages/coding-agent/test/sdk-session-manager.test.ts` asserts the same encoding for
  `SessionManager`'s default dir.

So the contract is: **drop one leading separator, then replace every `/`, `\` and `:`
with `-`, and wrap the result in `--` … `--`.**

## Fix (producer + consumer, minimal)

1. `packages/coding-agent/src/core/session-manager.ts` — `getDefaultSessionDirPath()`
   (the consumer's canonical lookup, used by `getDefaultSessionDir`, `SessionManager.create`,
   `list`, `listAll`, `findById`, `continueRecent`, `forkFrom`) now encodes `:` as well:
   `.replace(/[/\\:]/g, "-")`.
2. `packages/coding-agent/src/migrations.ts` — `migrateSessionsFromAgentRoot()`
   (the producer) now encodes `\` as well: `.replace(/[/\\:]/g, "-")`.

Both files keep the same regular expression, so the producer writes exactly the directory
that the consumer reads. Nothing else changed: function signatures, exports, the
`resolvePath`/`mkdirSync` behaviour, the "skip if the target already exists" collision
rule and the first-line header detection are untouched. No new cross-module import was
introduced, so the module boundaries (and the flat binding graphs that tests link against
these two files) are unchanged.

## Behaviour that is now observable across the boundary

- `getDefaultSessionDir(cwd)` and `SessionManager.create(cwd).getSessionDir()` are
  identical for cwds with `/`, `\` and `:` (including a Windows-style fragment inside an
  absolute POSIX path).
- After `migrateSessionsFromAgentRoot()`, `SessionManager.list(cwd)` /
  `continueRecent(cwd)` find the migrated file in `join(agentDir, "sessions", encodedName)`.
- Migration is a rename, so Unicode content, entry order and file bytes are preserved;
  malformed JSONL lines are skipped by the reader without losing valid entries.
- A pre-existing file at the target path is never overwritten, and repeated migration runs
  are no-ops (the legacy file is no longer in the agent root, and a colliding legacy file
  is re-skipped).

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` links the real
`session-manager.ts`, `migrations.ts` and `utils/paths.ts` through
`.prale-eval/subject.mjs`, with boundary fakes only for `config.ts`, `chalk`,
`utils/text.ts`, `core/keybindings.ts` and `@earendil-works/pi-ai` (deterministic
`uuidv7`, no time or randomness). It drives a scratch store under
`.prale-eval/.tmp-regression/` (removed afterwards) and asserts all of the above.

Mutation check performed locally: restoring either production file alone to its faulty
baseline (`git show HEAD:…`) makes the script exit 1 with a `node:assert/strict`
`AssertionError` (not a crash/import error); with the repair in place it exits 0.

`vitest`, `tsc` and the workspace `node_modules` are not installed in this environment, so
`npm test --workspaces` could not be run; the regression script instead parses and
evaluates the two production files for real (type stripping + `vm.SourceTextModule`), which
doubles as a syntax check, and exercises them against the real filesystem and the real
session reader.
