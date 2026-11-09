# Repair: collision safety and invalid-header rejection

## Failure chain

Two producers/consumers of the same session-file contract had drifted apart from
the clarified data-safety policy.

1. **Producer — `packages/coding-agent/src/migrations.ts`**
   `migrateSessionsFromAgentRoot()` moved legacy `~/.pi/agent/*.jsonl` files into
   `sessions/<encoded-cwd>/` with an unconditional `renameSync(file, newPath)`.
   On POSIX `rename(2)` silently replaces the destination, so when a session
   file with the same name already existed at the destination the pre-existing
   bytes were destroyed and the source disappeared too: a collision lost *both*
   sides. The inline comment even documented the intended guard
   (`Skip if target exists`) that had been removed.

2. **Consumer — `packages/coding-agent/src/core/session-manager.ts`**
   `loadEntriesFromFile()` validates the first parsed entry, then repairs a
   missing final newline with `appendFileSync(..., "\n")`. The guard used
   `&&`:

   ```ts
   if (header.type !== "session" && typeof header.id !== "string") return [];
   ```

   With `&&` the rejection only fired for entries that were *both* non-session
   *and* ID-less. A `{"type":"session", ...}` entry without a string ID (and a
   non-session entry carrying an ID) were accepted, and the reader then
   *rewrote* the invalid file by appending a newline. The sibling helper
   `parseSessionHeaderCandidate()` already used the correct disjunction, so the
   load path disagreed with the header-discovery path.

## Fix

- `migrations.ts`: after computing the destination path, skip the move when the
  destination already exists (`if (existsSync(newPath)) continue;`). Existing
  destination bytes win, the source bytes survive on disk, and the loop keeps
  processing every other candidate file. No API, signature or unrelated
  behavior changed.
- `core/session-manager.ts`: change the guard to `||`, i.e. reject unless the
  first entry is a session header with a string ID. Because the guard returns
  before `appendFileSync`, invalid files are returned as `[]` and are never
  rewritten, while valid headers still reach the newline-repair step.

## Cross-module agreement

The migration writes the artifact the reader consumes, so both halves are now
verified together in `.prale-eval/regression.mjs` through the real modules:

- a pre-existing destination plus a same-named agent-root source: destination
  bytes stay byte-identical, the source file is still present with its original
  bytes, an unrelated session still migrates, and a repeat migration is
  idempotent;
- the migrated file is opened by the real `SessionManager.open()` and yields the
  migrated header ID and cwd, and the preserved destination remains the session
  the reader sees;
- a relocated header-shaped file without a string ID is rejected by the reader
  (and by `SessionManager.open`) with its bytes untouched, even though it is
  unterminated — the reader never appends a newline to an invalid header;
- a relocated *valid* session whose final record is unterminated loads both
  entries and gains exactly one trailing newline, and a second read is stable;
- terminated valid sessions are not rewritten, while an unterminated malformed
  tail after a valid header is still repaired (existing behavior preserved).

Fault isolation was checked by restoring each file alone to its faulty
baseline: with the migration regression restored the script fails at the first
collision assertion (`existing destination bytes must win a collision`) after
the reader checks have run in other scenarios; with the session-manager
regression restored the script fails at `the reader must reject a header lacking
a string ID` while every migration assertion passes. Each file therefore has an
independent detector, and no failure is a crash or import error.
