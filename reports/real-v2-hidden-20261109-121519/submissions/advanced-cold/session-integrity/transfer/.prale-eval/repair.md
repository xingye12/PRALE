# Repair: migrated sessions were invisible to the normal reader

Task: `advanced/session-integrity/transfer` (repository `earendil-works/pi`)

## Root cause

Two modules implemented the *same* observable directory contract twice, and both
copies had drifted:

| Location | Encoding used before the repair | Result |
| --- | --- | --- |
| `packages/coding-agent/src/core/session-manager.ts` (`getDefaultSessionDirPath`) | strip one leading `/` or `\`, then `/` and `\` -> `-` | `:` was kept verbatim |
| `packages/coding-agent/src/migrations.ts` (`migrateSessionsFromAgentRoot`) | strip one leading `/` or `\`, then `/` and `:` -> `-` | `\` was kept verbatim |

The documented contract (`packages/coding-agent/docs/session-format.md`, "For
`<path>`, Pi removes the leading path separator and replaces `/`, `\\`, and `:`
with `-`") and the existing reader test
(`packages/coding-agent/test/sdk-session-manager.test.ts`) both say the encoded
name replaces `/`, `\` **and** `:`.

Consequence: for any absolute POSIX cwd that contains a `:` or a `\` (including a
Windows-style fragment embedded in a POSIX path, e.g.
`/tmp/pi project/win\C:\Users\me:data/été/日本`), the legacy migration moved the
`.jsonl` file into a directory whose name still contained the `\` characters and
had the `:` flattened, while the session manager looked for a directory whose name
kept the `:` and flattened the `\`. The two names can never be equal when the cwd
contains either character, so the file was moved out of the agent root but could
never be found again by `SessionManager.list()`, `findById()`,
`continueRecent()` or `open()` — the session was effectively lost from the user's
point of view.

## Cross-module fix

1. `packages/coding-agent/src/core/session-manager.ts`
   * Extracted the private encoder `encodeSessionDirName(resolvedCwd)` and made it
     implement the documented rule (`/`, `\`, `:` -> `-`). `getDefaultSessionDirPath`
     still resolves the cwd and the agent dir via `utils/paths.ts` first, so
     `/a/./b/` and `/a/b` continue to share one lookup directory.
   * No API change: `getDefaultSessionDir`, `SessionManager.*` and all other
     exports keep their signatures. This is the single source of truth for the
     reader's lookup path.

2. `packages/coding-agent/src/migrations.ts`
   * `migrateSessionsFromAgentRoot()` no longer re-implements the encoding. It
     calls the exported `getDefaultSessionDir(cwd, agentDir)` from
     `core/session-manager.ts`, so the destination is *by construction* the
     directory the reader computes. The local `safePath` expression and the now
     redundant `mkdirSync` block were removed (`getDefaultSessionDir` creates the
     directory).
   * The already-existing export is used, so no module in the graph can end up
     importing a symbol that only exists in the repaired revision.

The two modules therefore share one observable contract across the module
boundary instead of two regexes that can drift. Nothing about the on-disk format,
file names, session entry versions, or public APIs changed; only the directory a
legacy file is moved into.

## Behaviour now guaranteed (and asserted by `.prale-eval/regression.mjs`)

* For an absolute POSIX cwd mixing `/`, `\`, `:` (with a Windows-style fragment,
  spaces and non-ASCII characters) the migrated file lands exactly in
  `getDefaultSessionDir(cwd, agentDir)` ==
  `<agentDir>/sessions/--<cwd>--` where `<cwd>` is the resolved path with its
  leading separator removed and every `/`, `\` and `:` replaced by `-`, and
  `SessionManager.list(cwd)` / `findById(cwd, id)` / `open(path)` find it.
* Bytes, entry order, header `cwd` and Unicode text are preserved (the file is
  renamed, never rewritten).
* Malformed lines are skipped by the reader; the surrounding entries still load.
* A pre-existing destination file is never overwritten and the collided legacy
  file stays where it was; other files for the same cwd still migrate.
* Two cwds that the (lossy) encoding maps onto one directory keep their own data.
* A non-canonical cwd spelling (`/data/proj/./sub/`) migrates to the resolved
  lookup directory (`/data/proj/sub`).
* Repeated `migrateSessionsFromAgentRoot()` calls are idempotent: no duplicates,
  no content churn, no leftover files inside `sessions/` itself.
* This task does not emulate Windows path resolution and does not convert a raw
  Windows cwd on Linux; only absolute POSIX cwd values are exercised.

## Validation

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

Uses the read-only `.prale-eval/subject.mjs` helper, so the real
`migrations.ts`, `utils/text.ts`, `utils/paths.ts` and `core/session-manager.ts`
code runs; only `getAgentDir` (agent root) and the `readdirSync` ordering boundary
are substituted. Test fixtures are created under
`.prale-eval/.tmp-regression/` and removed in a `finally` block.

Reverting either production file to its faulty baseline makes the script fail with
an assertion error (never an import error or a crash):

* `session-manager.ts` baseline -> `session reader must encode '/' ... and ':'
  alike` fails (and, with the migration delegating to it, the encoded name no
  longer matches the documented contract).
* `migrations.ts` baseline -> `migrated session must land in the canonical lookup
  directory` fails.

## Limitations

The repository's Vitest suites (including
`packages/coding-agent/test/sdk-session-manager.test.ts`, which encodes the same
documented contract) could not be executed because `node_modules` is not
installed and dependencies must not be installed in this environment. The
regression script above is self-contained and needs only Node 24.
