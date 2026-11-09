# Repair: collision safety and invalid-header repair must agree

## Policy from the incident

- Existing destination bytes always win: a legacy session that would be moved
  onto an existing file must not overwrite it, and neither side may be lost.
- A session reader must reject a header that lacks a string `id` **before** it
  repairs a missing final newline, so rejected files are never rewritten.
- Valid headers must still be accepted, and valid unterminated final records
  must still be repaired.

## Producer/consumer flow

`packages/coding-agent/src/migrations.ts` is the producer: `migrateSessionsFromAgentRoot()`
reads every `*.jsonl` directly in the agent dir, parses the session header, and moves the
file into `agentDir/sessions/<encoded-cwd>/`. `packages/coding-agent/src/core/session-manager.ts`
is the consumer: `getDefaultSessionDir()` / `findMostRecentSession()` / `SessionManager.findById()`
compute and scan that same directory, and `loadEntriesFromFile()` (used by `SessionManager.open`,
`forkFrom`) parses the file and repairs a missing trailing newline.

Both defects broke the shared contract at the seam between the two modules, and each had to
be fixed on its own side.

## Fix 1 — `packages/coding-agent/src/migrations.ts` (destination bytes win)

```diff
-			// Regression: overwrite a colliding destination. // Skip if target exists
+			// Skip if target exists: destination bytes always win, and the legacy file
+			// stays in place so neither side of the collision is lost.
+			if (existsSync(newPath)) continue
 
 			renameSync(file, newPath);
```

The target path is computed exactly like the reader computes it (`--<encoded-cwd>--`), so a
collision means "the reader already has a session under this name". Skipping (`continue`)
keeps the destination file untouched, leaves the legacy file in the agent root so its bytes
survive, and lets the loop process the remaining legacy sessions instead of aborting.

## Fix 2 — `packages/coding-agent/src/core/session-manager.ts` (reject before repairing)

```diff
 	// Validate session header before repairing the file.
 	if (entries.length === 0) return entries;
 	const header = entries[0];
-	if (header.type !== "session" && typeof (header as { id?: unknown }).id !== "string") {
+	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
 		return [];
 	}

 	if (pending) appendFileSync(resolvedFilePath, "\n");
```

With `&&`, the guard was effectively unreachable: a session header without an `id`
short-circuited the first operand to `false`, and any non-header first entry that happened to
carry a string `id` short-circuited the second one. Invalid files were therefore accepted *and*
repaired (newline appended). With `||` the predicate matches `parseSessionHeaderCandidate()`
(used by `readSessionHeader()`), so discovery and reading agree: an invalid header returns `[]`
before the `appendFileSync` repair, leaving the file byte-identical, while a valid header
(string `id`) still flows through and a valid unterminated final record is still repaired.

## Validation

`node --experimental-vm-modules .prale-eval/regression.mjs` (workspace root, Node 24) loads the
real modules through `.prale-eval/subject.mjs` and asserts the observable behavior across the
migration → directory → reader → `SessionManager.open` seam:

1. A destination that already exists in the directory the reader itself computes keeps its exact
   bytes, while the colliding legacy session stays at its old path with its original bytes.
2. Legacy sessions ordered after the collision are still migrated into that same directory, are
   readable (`loadEntriesFromFile`) and discoverable (`SessionManager.findById`); the suppressed
   loser is not discoverable; non-session `*.jsonl` files are untouched.
3. Reader policy: headers with a missing or non-string `id`, and files whose first entry is not
   a session header, return `[]` with the file unchanged; `SessionManager.open` throws
   `/not a valid/` without rewriting; a valid header with an unterminated final record returns
   its entries and gains exactly one newline (idempotent); a valid terminated file is untouched.

The migration and the reader are ordered through an explicit promise hand-off (no timers,
randomness or external services). Fixtures live in `.prale-eval/.tmp-regression` and are removed
in a `finally` block.

Regression detection was verified by restoring each file alone to its faulty baseline:
`migrations.ts` alone fails "a collision must never overwrite the destination file", and
`session-manager.ts` alone fails "a session header without a string id must be rejected". Both
are plain assertion failures; the script passes again with both fixes.

Limitation: dependencies are not installed in this workspace (no `node_modules`), so `tsc` and
the package's vitest suites could not be run; the modules are executed directly by Node 24's
type-stripping loader inside the subject pipeline instead.
