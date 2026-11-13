# Repair: resume a mixed legacy batch without dropping its tail

Task: `advanced/session-integrity/retransfer`
Repository: `earendil-works/pi`
Mode: `repair`

## Incident

A batch of session JSONL files is resumed/transferred one file at a time. The batch starts with a
file whose transfer target already exists (a collision) and ends with a valid session whose last
JSONL record has no trailing newline. Two defects made that batch lossy:

1. **The tail record was dropped.** `loadEntriesFromFile()` decoded the file, parsed the final,
   newline-less fragment into `finalEntry`, and then threw it away: the variable was never used, so
   the record vanished from the returned entries while `appendFileSync(file, "\n")` still repaired
   the file. The record was therefore unrecoverable after the repair — the classic "dropped tail".
2. **A colliding id silently stopped the legacy migration from being collision-checked.**
   `migrateV1ToV2()` declared a `Set<string>` of already-minted ids and passed it to
   `generateId()` (documented as "8 hex chars, collision-checked"), but never added the minted ids to
   it. A generator that returns an id already used by an earlier entry of the same batch produced
   two entries with the same id, so the tree index (`byId`) lost a node and later records were
   re-chained onto an ambiguous parent.

## Production changes (only `packages/coding-agent/src/core/session-manager.ts`)

### `loadEntriesFromFile()` — keep the final record exactly once

```ts
pending += decoder.end();
// The last line may lack a trailing newline; keep that record, then repair the file below.
const finalEntry = parseSessionEntryLine(pending);
if (finalEntry) entries.push(finalEntry);
```

Ordering matters and is preserved:

* the fragment is parsed and pushed **before** the header validation, so a file whose only record is
  an unterminated header is still recognized as a session (and then repaired);
* the malformed-fragment and non-session cases still return without touching the file, because
  `parseSessionEntryLine()` returns `null` for unparsable input and the header check still runs
  before `appendFileSync()`;
* the newline repair (`if (pending) appendFileSync(...)`) is unchanged, so the record is retained
  **once** and the file ends with exactly one newline. A second read returns the same entries and
  leaves the bytes untouched (idempotent re-read), and a subsequent append starts on its own line
  instead of being glued onto the unterminated record.

### `migrateV1ToV2()` — remember minted ids

```ts
entry.id = generateId(ids);
// Remember minted ids so a colliding generator result cannot reuse an earlier entry's id.
ids.add(entry.id);
```

With the id recorded, `generateId()` retries on a collision (up to 100 attempts, full-UUID fallback
unchanged) so the id-collision at the start of a legacy batch no longer derails or corrupts the
remaining legacy entries: every entry keeps a unique id and a parent chain that points at the
remapped id of the previous entry.

Public APIs, error messages, file formats and all unrelated behaviour are untouched; both edits are
inside existing functions.

## Cross-module behaviour verified by `.prale-eval/regression.mjs`

The script links the real production modules through `.prale-eval/subject.mjs`
(`createGraph`), so the reader, the migration and the transfer path all run as submitted code:

* `packages/coding-agent/src/core/session-manager.ts` — reader/repair, resume, migration, transfer
* `packages/coding-agent/src/core/messages.ts` — context message construction (linked, asserted)
* `packages/coding-agent/src/utils/paths.ts` — path normalization used by the session layer

Boundary fakes supplied by the script: the `../config.ts` exports, the `@earendil-works/pi-ai`
exports (`uuidv7`, `getCurrentSystemMessage`), `./child-process.ts` (`spawnProcessSync`),
`crypto.randomUUID` (a scripted id generator, so collisions are deterministic) and the `Date` global
inside the module graph (a fixed clock, so no real time is read). Temporary inputs are created under
`.prale-eval/tmp` and removed by the script.

Asserted observable behaviour:

1. Reading a session whose last record has no newline keeps that record exactly once and appends one
   newline; re-reading is idempotent (same entries, same bytes).
2. Malformed lines are skipped while ordered Unicode payloads survive in file order.
3. Resuming such a file (producer → consumer boundary) repairs the tail before any append, so the
   next appended record is not merged into the unterminated line and stays a separate, parseable
   record.
4. In a batch transfer, the colliding transfer fails instead of overwriting: the colliding source
   bytes **and** the existing destination bytes are unchanged, and the later transfers still run.
   The last transfer keeps the source's unterminated final record exactly once in the resulting file.
5. Legacy migration assigns unique ids and re-chains parents even when the id generator collides,
   and the migrated file keeps every record exactly once with a terminating newline.

Regression detection was checked by temporarily restoring each defect on its own: with the dropped
`finalEntry` push the script fails at "the unterminated final record must not be dropped"
(`2 !== 3`); with the missing `ids.add()` it fails at "colliding ids must be retried" (`1 !== 2`).
Both are plain assertion failures, not import errors or crashes.

## Limitations

`vitest` and the repository's Node dependencies are not installed in this workspace, so the
repository's own TypeScript test files (for example
`packages/coding-agent/test/session-manager/file-operations.test.ts`, whose
"adds a newline after an unterminated valid record" case covers the same incident) could not be
executed here. They are the same expectations asserted behaviourally by
`.prale-eval/regression.mjs`, which runs with Node 24 alone.
