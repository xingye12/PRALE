# Repair: collision safety and invalid-header rejection must agree

Task: `advanced/session-integrity/correction` (`earendil-works/pi`, mode `repair`)

## Failure chain found by investigation

The incident couples two modules that translate "never destroy existing session
bytes" into different code paths:

1. `packages/coding-agent/src/migrations.ts` — `migrateSessionsFromAgentRoot()`
   moves legacy `~/.pi/agent/*.jsonl` files into
   `~/.pi/agent/sessions/<encoded-cwd>/`. The destination guard had been
   replaced by a marker comment
   (`// Regression: overwrite a colliding destination. // Skip if target exists`)
   with no guard left, so the unconditional `renameSync(file, newPath)`
   replaced the destination file. On POSIX that destroys the pre-existing
   destination bytes, and the source disappears as well, so *both* sides of the
   collision are lost (the two files silently collapse into one).

2. `packages/coding-agent/src/core/session-manager.ts` —
   `loadEntriesFromFile()` reads a session, then validates the first parsed
   entry as a session header *before* repairing a missing final newline by
   appending `"\n"`. The predicate combined its two checks with `&&`:

   ```ts
   if (header.type !== "session" && typeof header.id !== "string") return [];
   ```

   A header is valid only if it is a session record **and** carries a string
   id, so rejection must be `type !== "session" || id not a string`. With `&&`
   only records failing *both* tests were rejected. Consequences:
   - `{"type":"session", ...}` without a string id was accepted, its id became
     `undefined`, and the file was rewritten by the newline repair (and could
     then be re-written again by `SessionManager`'s version migration).
   - A non-session first record carrying a string id (`{"type":"message","id":"m1"}`)
     was also accepted and its file got a repair newline appended.

   Both violate the clarified policy: an invalid header must be rejected
   **without rewriting the file**, while a valid header must still be accepted
   and a valid unterminated final record must still be repaired.

## Production changes (minimal, API-preserving)

- `migrations.ts`: restored the destination-exists guard immediately before the
  rename, so an existing destination wins and the source is left untouched:
  `if (existsSync(newPath)) continue;`.
  The `continue` is inside the existing per-file `try`, so one collision neither
  throws nor aborts the loop: every other legacy file is still migrated.
- `session-manager.ts`: changed the header-validation join from `&&` to `||`,
  so either an invalid `type` or a non-string `id` returns `[]` from the
  validation block — which is placed *before* the `appendFileSync(... "\n")`
  repair — leaving the rejected file byte-identical.

No signatures, exports or call sites changed; `loadEntriesFromFile` still
returns `[]` for rejected files, which is the existing contract consumed by
`SessionManager._setSessionFile()` (it throws "not a valid … session" for
non-empty rejected files) and `SessionManager.forkFrom()`.

## Why the two fixes must be verified together

The migration decides *where bytes land* (destination wins), the reader decides
*whether bytes may be touched at all* (validate before repair). A repair to
only one side leaves the other data-safety hole open: overwriting a destination
destroys a valid session, and repairing an invalid header mutates a file the
reader has just declared not to be a pi session. The regression therefore loads
the real chain `migrations.ts → utils/text.ts → core/session-manager.ts` through
`.prale-eval/subject.mjs` and asserts only observable behavior: file bytes on
disk, returned entries, and thrown/returned results across the module boundary.

## Regression coverage (`.prale-eval/regression.mjs`)

Uncaught `node:assert/strict` assertions; scratch inputs are created under
`.prale-eval/.tmp-session-integrity/` and deleted in a `finally` block. No real
time, randomness or external services; the one async check awaits
`SessionManager.listAll` and asserts a deterministic progress sequence driven by
promise resolution.

Covered behaviors:

- Collision: destination bytes are unchanged, the colliding source still exists
  with its original bytes.
- Continuation: a later, non-colliding legacy file is migrated byte-for-byte
  after a collision was skipped (alphabetical readdir order puts the collision
  first).
- Invalid headers (id missing, id numeric, non-session first record), both
  terminated and unterminated: `loadEntriesFromFile` returns no entries and the
  file is byte-identical (no appended newline).
- Valid header + valid unterminated final record: both entries load, exactly one
  newline is appended, and a second read is idempotent.
- Valid terminated session: no byte change.
- Cross-module `SessionManager.open`: an invalid header file throws
  `not a valid … session` and is not rewritten; a valid unterminated session
  opens with the expected id/entries and is repaired once.
- `SessionManager.listAll`: valid session surfaced, non-session file dropped,
  deterministic two-step progress publishing.
- The real text helpers used by the migration chain stay real (`stripBom`,
  `splitBom`).

## Validation run

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

Result: exit 0, `9 cross-module checks passed`.

## Mutation check (each repaired file restored alone to its faulty baseline)

| Baseline restored | Observed result |
| --- | --- |
| `migrations.ts` (unconditional rename) | `AssertionError [ERR_ASSERTION]: collision must not delete the source session` |
| `core/session-manager.ts` (`&&` header predicate) | `AssertionError [ERR_ASSERTION]: loadEntriesFromFile must reject session header without an id` |

Both faults surface as ordinary assertion failures on the first affected test —
not as import errors, crashes or timeouts — and the full suite passes again once
the repair is restored. No optional validation dependency was missing: Node 24
with `--experimental-vm-modules` was sufficient, and no dependencies were
installed.
