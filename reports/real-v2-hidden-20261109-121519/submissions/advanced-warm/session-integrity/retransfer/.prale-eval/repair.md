# Repair: resume a mixed legacy batch without dropping its tail

## Observed incident

A startup batch of legacy JSONL sessions under `~/.pi/agent/` begins with a file
whose destination already exists (a collision) and ends with a valid session whose
last physical JSONL record has no trailing newline.

Two independent defects combined into the reported behavior:

1. `migrateSessionsFromAgentRoot()` in `packages/coding-agent/src/migrations.ts`
   returned from the entire loop when the destination of one file already existed.
   The colliding file was skipped correctly, but every file after it in the batch
   was silently abandoned, so the valid session was never moved.
2. `loadEntriesFromFile()` in `packages/coding-agent/src/core/session-manager.ts`
   parsed the final leftover buffer after `decoder.end()` but discarded the result.
   Any session that did not end in `\n` therefore lost its tail record on resume,
   while the file was still "repaired" with a newline — making the loss permanent
   and invisible to a re-read.

## Fix

### `packages/coding-agent/src/migrations.ts` — batch continuation

```diff
- if (existsSync(newPath)) return; // Skip if target exists
+ if (existsSync(newPath)) continue; // Skip only this file when the target exists
```

`continue` scopes the skip to the colliding file. The destination and the source
are neither deleted nor rewritten, so both keep their exact original bytes, and
the loop proceeds to the remaining files. The public API and directory encoding
are unchanged.

### `packages/coding-agent/src/core/session-manager.ts` — tail retention

```diff
  pending += decoder.end();
  const finalEntry = parseSessionEntryLine(pending);
- // Regression: discard final JSONL entry.
+ if (finalEntry) entries.push(finalEntry);
```

The unterminated final record is now pushed exactly once, before the existing
header validation and before `appendFileSync(filePath, "\n")` runs. Because the
line is inserted before the newline is appended, the first read returns the full
ordered record list, and the next read (now newline-terminated) returns the same
list — idempotent, with no duplicate tail and no second newline. Blank or
malformed fragments still parse to `null`, so they are skipped but still get the
same newline repair that the existing tests require.

## Cross-module failure chain

`runMigrations` → `migrateSessionsFromAgentRoot` (migrations.ts) → real
`utils/paths.ts`/`utils/text.ts` helpers → moved file on disk →
`loadEntriesFromFile` / `SessionManager.open` (session-manager.ts) → re-read.

The batch stops at the collision, so the reader never sees the valid session at
all; when it does (migration fixed alone), the reader drops the tail record.
Both halves must be repaired for resume to preserve the batch.

## Validation

Command (from the workspace root):

```
node --experimental-vm-modules .prale-eval/regression.mjs
```

`.prale-eval/regression.mjs` loads the real submitted modules through the
read-only `.prale-eval/subject.mjs` graph (`createSessionPipeline`); only the
agent-dir boundary and directory-entry ordering are supplied by the harness.
The script builds its fixtures under `.prale-eval/.session-integrity-tmp` and
removes them in a `finally` block.

Assertions, in order:

- A batch of `a-colliding.jsonl` (destination already present), `b-valid.jsonl`
  (Unicode records, an interleaved malformed line, no trailing newline), and
  `c-malformed.jsonl` (unparsable header) is migrated. The later valid session
  must be moved even though the first file collided.
- The colliding source and destination are byte-identical to their originals,
  before and after a second batch run; the malformed file is untouched.
- Migration and `SessionManager` agree on the encoded session directory.
- Reading the moved file retains `[header, m1, m2, m3]` in order, skipping the
  malformed line, with the ordered Unicode payloads unchanged.
- Exactly one `\n` is appended; an immediate re-read returns identical entries
  and appends nothing further.
- `SessionManager.open` sees the same tail record through its own loader.
- A second fixture places a 4-byte emoji exactly across the 1 MiB read-chunk
  boundary, proving `StringDecoder` ordering and tail retention at chunk limits.

Result on the repaired tree: exit 0, `session-integrity regression: all
assertions passed`.

## Mutation checks (falsification before the claim)

Each faulty baseline was restored alone, the command re-run, and the repaired
file restored afterwards:

| Restored baseline | Observed result |
| --- | --- |
| `migrations.ts`: `if (existsSync(newPath)) return;` | `AssertionError: migration must continue past a colliding file and move the later valid session` (regression.mjs:106) |
| `core/session-manager.ts`: final entry discarded | `AssertionError: the unterminated final record must be retained once, in order, after malformed lines are skipped` (regression.mjs:144) |

Both failures are uncaught `node:assert/strict` assertion failures, not crashes,
import errors, or timeouts. No real time, randomness, network, or external
service was used as correctness evidence, and no dependency installation was
required (Node 24 only).
