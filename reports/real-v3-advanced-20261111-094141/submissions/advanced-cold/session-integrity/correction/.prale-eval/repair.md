# Repair: collision safety and invalid-header repair must agree

## What broke (two sides of one policy)

The clarified policy has two halves, and each half lived in a different module:

1. `packages/coding-agent/src/migrations.ts` — `migrateSessionsFromAgentRoot()` moves legacy
   session files from the agent root into `agent/sessions/<encoded-cwd>/`. It called
   `renameSync(file, newPath)` unconditionally. On POSIX a rename onto an existing path
   silently replaces it, so a legacy file whose destination name already existed destroyed
   the newer destination bytes.

   Trace: agent root holds `legacy.jsonl` (id `source-session`) while
   `sessions/--tmp-project-a--/legacy.jsonl` (id `destination-session`) already exists.
   After the migration the destination held the source bytes and the source path was gone.
   One surviving session, and the wrong one.

2. `packages/coding-agent/src/core/session-manager.ts` — `loadEntriesFromFile()` validates the
   first parsed record as a session header and then appends a newline if the file's final
   record was unterminated. The guard used `&&`:

   ```ts
   if (header.type !== "session" && typeof (header as { id?: unknown }).id !== "string") return [];
   ```

   A header with `type: "session"` short-circuits the conjunction, so a header with a missing or
   non-string `id` was treated as valid. Two things followed: the loader returned bogus entries,
   and it then rewrote the file to repair the newline — the opposite of "reject invalid headers
   without rewriting their files". `readSessionHeader()` / `parseSessionHeaderCandidate()` in the
   same module already used the correct `||` predicate, so discovery rejected files that the
   loader accepted: producer and consumer disagreed about what a session header is.

## Changes

`packages/coding-agent/src/migrations.ts`

```ts
const newPath = join(correctDir, fileName!);

// Existing destination bytes always win: keep both copies in place and
// let the remaining files migrate.
if (existsSync(newPath)) continue;

renameSync(file, newPath);
```

The destination is never touched, the legacy source stays where it was so both sides of the
collision survive, and `continue` only skips that one file so the rest of the loop still runs.
No API changed.

`packages/coding-agent/src/core/session-manager.ts`

```ts
if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") return [];
```

Header validation now matches `parseSessionHeaderCandidate()`. A record must be a `session`
record **and** carry a string `id` before anything is loaded or repaired. Because the check
already ran before `appendFileSync(... "\\n")`, one character turned both behaviors back on:
invalid headers are rejected with the file byte-identical, valid headers still load, and a valid
unterminated final record is still newline-terminated.

Cross-module effect: `SessionManager.open()` on a non-empty file whose header lacks a string id
now reaches `_setSessionFile()` with zero entries and throws
`Session file is not a valid pi session: …` without writing, instead of adopting an undefined
session id. Files relocated by the migration are read back by the same loader and keep their own
identity, so a preserved collision stays two distinct sessions.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` links the two real modules in one VM
graph (boundary fakes for agent config paths, chalk, path helpers and message factories) and
asserts on real bytes under `.prale-eval/tmp`, which is deleted before and after the run:

- collision: destination bytes unchanged, legacy source bytes unchanged, both load as their own
  session through `loadEntriesFromFile` and `SessionManager.open`, and an unrelated legacy file
  is still migrated to its encoded directory;
- invalid header (no `id`, non-string `id`, first record not a header): loader returns nothing,
  file bytes unchanged, and `SessionManager.open` throws `not a valid pi session` leaving the
  file untouched;
- valid header with an unterminated final record (well-formed and malformed tail) and a
  header-only file: entries load and the missing final newline is still appended.

Restoring either file alone to its faulty baseline makes the script fail with a plain
`AssertionError` (verified for each file separately); the repairs pass it.
