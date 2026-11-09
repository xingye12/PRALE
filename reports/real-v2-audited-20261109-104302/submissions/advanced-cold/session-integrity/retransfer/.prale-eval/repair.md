# Cross-module repair: legacy batch resume + unterminated JSONL tail

Task: `advanced/session-integrity/retransfer` (repository `earendil-works/pi`).

## Incidents

A legacy batch of session files in the agent root is migrated by
`migrateSessionsFromAgentRoot()` (`packages/coding-agent/src/migrations.ts`) and
later read by `loadEntriesFromFile()` (`packages/coding-agent/src/core/session-manager.ts`).
Two independent regressions broke the producer/consumer flow:

1. **Producer (migrations.ts)** — when a destination session file already
   existed, the loop executed `return`, aborting the whole migration batch.
   Every session ordered after the colliding file was left in the agent root,
   so the tail of the batch silently disappeared from `sessions/<encoded-cwd>/`.

2. **Consumer (session-manager.ts)** — `loadEntriesFromFile()` parsed the
   leftover `pending` fragment of the streaming read (the final record that has
   no trailing newline) into `finalEntry` and then discarded it. The caller
   still appended the missing newline, so the record was permanently lost from
   the parsed transcript while the file on disk looked repaired.

## Fixes

### `migrations.ts`

```diff
-			if (existsSync(newPath)) return; // Skip if target exists
+			// Skip if target exists: keep both files byte-for-byte intact, but
+			// continue with the remaining sessions instead of aborting the batch.
+			if (existsSync(newPath)) continue;
```

`continue` skips only the colliding file. Both the colliding source and the
pre-existing destination stay byte-for-byte unchanged (no `renameSync` happens
for that entry), and the loop proceeds to the remaining sessions, including the
final one. The exported API and all other migration steps are untouched.

### `core/session-manager.ts`

```diff
 		pending += decoder.end();
+		// A final record without a trailing newline is still a complete record.
 		const finalEntry = parseSessionEntryLine(pending);
-		// Regression: discard final JSONL entry.
+		if (finalEntry) entries.push(finalEntry);
```

The final fragment is now appended exactly once before the existing
`if (pending) appendFileSync(resolvedFilePath, "\n")` repair runs. Because the
fragment is cleared on the next read (the file now ends with `\n`), re-reading
is idempotent: the same entries come back and no second newline is written.
Malformed final fragments still parse to `null`, are skipped, and the newline
is still appended, matching the pre-existing behavior. Header validation
(`entries.length === 0` / non-session first entry) still runs before any file
repair, so non-session files remain untouched.

## Cross-module behavior asserted by `.prale-eval/regression.mjs`

The script loads the real modules through the read-only
`.prale-eval/subject.mjs` graph (real `migrations.ts`, real `utils/text.ts`,
real `core/session-manager.ts`; only external IO boundaries are substituted,
and `readdirSync` is ordered deterministically by the helper).

Scenario (scratch inputs created under `.prale-eval/scratch` and removed in a
`finally` block):

- Agent root contains `a-collision.jsonl` (whose destination already exists
  with different bytes), `b-valid.jsonl`, and `c-tail.jsonl` (valid session
  whose last record has no newline).
- After `migrateSessionsFromAgentRoot()`:
  - the colliding source and destination are byte-for-byte unchanged;
  - `b-valid.jsonl` and `c-tail.jsonl` are moved to
    `sessions/--work-{beta,gamma}--/` with identical bytes.
- The migrated tail file is then read with the real `loadEntriesFromFile()`:
  - entries come back in file order, each exactly once, with ordered Unicode
    payloads (Greek, combining accents, emoji/surrogate pairs, CJK);
  - the file gains exactly one newline;
  - a second read returns deep-equal entries and does not add another newline.
- Additional intact-behavior checks: malformed middle/final lines are skipped
  while the valid tail survives; a newline-terminated file is not modified; a
  multi-buffer (>1 MiB) Unicode stream keeps ordered payloads and retains its
  tail; a non-session file is neither accepted nor rewritten.

## Validation

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

Passes with both repairs. Restoring either source file to its faulty baseline
in isolation makes the same script fail with an uncaught
`node:assert/strict` `AssertionError` (no crash, import error or timeout):

- migrations baseline: `the session after the collision must still be migrated out of the agent root`
- session-manager baseline: `migrated tail session: entries must be returned in file order exactly once`
  (actual `["gamma-session","gamma-1","gamma-2"]`, expected adds `"gamma-3"`)

No dependencies, network, credentials, real time or randomness are used; the
workspace has no installed `node_modules`, so no other test runner was used.
