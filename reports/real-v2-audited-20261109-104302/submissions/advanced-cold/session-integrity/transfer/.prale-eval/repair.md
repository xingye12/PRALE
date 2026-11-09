# Repair: legacy session migration vs. canonical session directory

## Symptom

Legacy `.jsonl` sessions that v0.30.0 wrote directly into `~/.pi/agent/` were moved by
`migrateSessionsFromAgentRoot()` into a directory the session manager never looks at, so
`SessionManager.continueRecent(cwd)`, `SessionManager.open()`, `SessionManager.list()` and
`findMostRecentSession()` could not find the migrated session.

## Root cause: two different encoders for one observable contract

Both modules independently turn a cwd into a single, filesystem-safe directory name under
`<agentDir>/sessions/`:

```
--<cwd without one leading separator, every separator/drive colon replaced by "-">--
```

| Module | Encoding before the repair | Broken for |
| --- | --- | --- |
| `packages/coding-agent/src/core/session-manager.ts` (`getDefaultSessionDirPath`, used by `getDefaultSessionDir`, `continueRecent`, `findById`, `list`, `open`'s default dir) | `/[/\\]/g` — replaced slash and backslash only | absolute POSIX cwds that contain a colon (`/work/C:/repo`, Windows-style fragments) |
| `packages/coding-agent/src/migrations.ts` (`migrateSessionsFromAgentRoot`) | `/[/:]/g` — replaced slash and colon only | absolute POSIX cwds that contain a backslash (`/work/C:\Users\dev`) |

For a cwd such as `/…/projects/wörk space/C:\Users\dev/目录-ñ` the producer and the consumer
therefore computed different directories. The migration succeeded (the file was moved), but
the reader looked elsewhere and fell back to creating a brand-new session, so the migrated
transcript was invisible.

The repository already documents the intended contract in
`packages/coding-agent/test/sdk-session-manager.test.ts`
(`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`), which confirms that both
separators **and** the drive colon must be replaced.

## Fix (minimal, both modules, APIs unchanged)

Both producers use the identical expression, so the observable path contract is shared again:

```ts
`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
```

- `migrations.ts`: the producer's class gained the backslash alternative (`[/:]/g` → `[/\\:]/g`).
- `core/session-manager.ts`: the consumer's class gained the colon alternative (`[/\\]/g` → `[/\\:]/g`).

No public API, signature, return value, file layout or unrelated behaviour changed; Windows path
resolution is deliberately not emulated — a Windows-style fragment is simply sanitized inside the
otherwise absolute POSIX cwd.

## Cross-module behaviour now guaranteed

For every absolute POSIX cwd (slash, backslash and colon included):

1. `migrateSessionsFromAgentRoot()` moves `<agentDir>/<file>.jsonl` to
   `<agentDir>/sessions/<encoded cwd>/<file>.jsonl`.
2. `getDefaultSessionDir(cwd, agentDir)` returns exactly that directory, so the real reader
   (`continueRecent`, `findById`, `list`, `findMostRecentSession`, `loadEntriesFromFile`) finds
   the migrated file through normal lookup.
3. Bytes are preserved (the move is a rename), Unicode and entry order are preserved, malformed
   JSONL lines are skipped by the reader, a pre-existing target is never overwritten (the legacy
   file stays in place), and repeated migration runs are no-ops.

## Validation

`.prale-eval/regression.mjs` loads both submitted modules through the read-only
`.prale-eval/subject.mjs` graph (only `getAgentDir` and a deterministic `readdirSync` ordering
are faked) and runs staged, promise-chained checks on cwds containing `/`, `\`, `:`, spaces and
non-ASCII text:

- directory name produced by the migration equals `getDefaultSessionDir(cwd, agentDir)`;
- the migrated file is read back through `loadEntriesFromFile`, `SessionManager.open`,
  `SessionManager.continueRecent`, `SessionManager.findById`, `SessionManager.list` and
  `findMostRecentSession` with exact entry order/content and identical bytes;
- a malformed JSONL line inside the file is skipped while later entries keep their order;
- a collision with an existing target keeps both files intact;
- migration files with a malformed header, a missing `cwd`, or a non-`.jsonl` name are untouched;
- two additional migration runs change nothing.

Regression detection was verified by temporarily restoring each module's faulty baseline alone:

- faulty `core/session-manager.ts` + fixed `migrations.ts` → `AssertionError: reader canonical dir
  must encode slash, backslash and colon …`
- faulty `migrations.ts` + fixed `core/session-manager.ts` → `AssertionError: migrated session file
  lands in the reader's dir …`

Both failures are ordinary assertion failures (no import error, crash or timeout). The working
tree was restored to the repaired state afterwards and the regression passes.

Limitations: the workspace ships no `node_modules`, so the repository's vitest/TypeScript
toolchain could not be run; validation uses Node 24 directly
(`node --experimental-vm-modules .prale-eval/regression.mjs`) as the task specifies.
