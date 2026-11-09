# Repair: resume a mixed legacy batch without dropping its tail

Task: `advanced/session-integrity/retransfer` — repository `earendil-works/pi`.

## Symptoms

A legacy batch in the agent root (`~/.pi/agent/*.jsonl`) is migrated into
`~/.pi/agent/sessions/<encoded-cwd>/` on startup. Two independent defects
combined into the reported incident:

1. The **first** file of the batch collided with an already existing destination
   file, and **no further file of the batch was migrated**.
2. The **last** file of the batch was a valid session whose final JSONL record
   had no trailing newline. That record disappeared from the loaded transcript,
   and because the reader then "repaired" the file by appending the missing
   newline, the record was lost from disk as well.

## Root causes and repairs

### `packages/coding-agent/src/migrations.ts` — `migrateSessionsFromAgentRoot()`

```ts
if (existsSync(newPath)) return; // Skip if target exists   // faulty
```

`return` exits the whole migration function, not just the current loop
iteration, so every legacy session that sorts after the colliding file stayed
behind in the agent root. Nothing about the collision itself was wrong: an
existing destination must be preserved, but only that one file may be skipped.

```ts
// Skip only this file if the target already exists; a collision must not
// stop the remaining legacy sessions in the batch from being migrated.
if (existsSync(newPath)) continue;
```

The source file and the pre-existing destination file are both left completely
untouched (no rename, no rewrite), which keeps their bytes identical while the
rest of the batch keeps moving.

### `packages/coding-agent/src/core/session-manager.ts` — `loadEntriesFromFile()`

The reader streams the file and parses every `\n`-terminated line, leaving the
unterminated remainder in `pending`. At EOF that remainder *is* the final
record, but the parsed value was discarded:

```ts
pending += decoder.end();
const finalEntry = parseSessionEntryLine(pending);
// Regression: discard final JSONL entry.      (finalEntry was never pushed)
```

The repair keeps it, before the newline repair rewrites the file — after
`appendFileSync(file, "\n")` the old bytes can no longer be distinguished from
a record that was already parsed:

```ts
pending += decoder.end();
// The final JSONL record is only terminated by EOF, so keep it before the
// newline repair below rewrites the file and it can no longer be recovered.
const finalEntry = parseSessionEntryLine(pending);
if (finalEntry) entries.push(finalEntry);
```

`parseSessionEntryLine()` already skips blank and malformed remainders, so a
truncated/garbage tail still only triggers the newline repair without injecting
a bogus entry, and header validation (`entries[0]` must be a session header) is
unchanged. Public APIs, signatures, and return values are preserved.

## Cross-module interaction

The two defects are coupled through the migration → text/path helpers → session
reader chain:

* `migrateSessionsFromAgentRoot()` decides the destination directory from the
  header `cwd` using the same encoding the session manager uses
  (`getDefaultSessionDir()`), and moves the file with `renameSync`, i.e.
  byte-for-byte. The unterminated tail record therefore survives the move.
* `loadEntriesFromFile()` is what `SessionManager.open()` (and `forkFrom()`)
  uses to resume. Dropping the tail record made the recovered session end at the
  second-to-last record: the resumed `leafId` pointed at the wrong entry, so the
  next `appendMessage()` branched off a record that was never really the leaf.
* The newline repair only runs *after* the returned entries are complete, so the
  fix guarantees "retain exactly once, then terminate".

## Validation

`.prale-eval/regression.mjs` (run with
`node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace
root) drives the real modules through `.prale-eval/subject.mjs`
(`createSessionPipeline`, i.e. real `migrations.ts` → real `utils/text.ts` /
`utils/paths.ts` → real `core/session-manager.ts`; only `getAgentDir`, `chalk`,
and config/keybindings boundaries are substituted).

Scenario: the agent root holds `a-collide.jsonl` (destination already present,
different bytes), `z-later.jsonl` (tail session: unicode user/assistant records,
one malformed line, final record without newline), and a non-session file.

Assertions:

* the colliding source and the pre-existing destination are byte-identical
  after migration, and the unrelated non-`.jsonl` file is untouched;
* `z-later.jsonl` is still migrated (batch not aborted), byte-for-byte, into
  the directory the session manager itself computes via
  `getDefaultSessionDir(laterCwd, agentDir)`;
* `loadEntriesFromFile()` returns `header, b0000001, b0000002, b0000003` in
  order, with unicode payloads intact, the malformed line skipped, and
  `b0000003` present exactly once;
* the file afterwards equals the original bytes plus exactly one `\n`, and a
  second read yields identical entries and identical bytes (idempotent);
* `SessionManager.open()` resumes the migrated file with leaf `b0000003`, and an
  `appendMessage()` afterwards persists a fourth record whose `parentId` is the
  recovered tail — no duplicate, no lost record.

Mutation check (performed manually, patches are not part of the workspace):
restoring *only* `migrations.ts` to `return` fails on "a colliding destination
must not abort the batch"; restoring *only* `session-manager.ts` to the
discarding baseline fails on "expected header + two valid records + the
unterminated tail record, got 3". Both are plain `node:assert/strict` assertion
failures — no crash, import error, or timeout.

No asynchronous ordering, real time, randomness, network, credentials, or
external services are used. Scratch inputs are created under
`.prale-eval/.tmp/run-*` and removed in a `finally` block.

Limitation: this workspace has no `node_modules`, so the repository's own
`vitest` suites (e.g. `packages/coding-agent/test/session-manager/*`) could not
be executed here; all validation was done with the Node 24 script above.
