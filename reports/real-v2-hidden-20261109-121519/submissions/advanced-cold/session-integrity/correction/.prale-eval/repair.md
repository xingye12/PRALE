# Repair: collision safety and invalid-header repair must agree

Task: `advanced/session-integrity/correction` — repository `earendil-works/pi`.

## Faults found

### 1. `packages/coding-agent/src/migrations.ts` — `migrateSessionsFromAgentRoot()`

The legacy-session migration (files sitting directly in the agent dir, moved into
`sessions/<encoded-cwd>/`) had lost its destination guard. The only thing left of
the guard was a comment: `// Regression: overwrite a colliding destination.
// Skip if target exists`, followed unconditionally by `renameSync(file, newPath)`.

Consequence: when the destination directory already held a session with the same
file name, the pre-existing destination was silently replaced by the legacy file —
the destination's bytes were destroyed and only one side of the collision
survived.

Repair (minimal, API-preserving):

```ts
// Skip if target exists: existing destination bytes always win and the
// original file stays in place, so neither side of a collision is lost.
if (existsSync(newPath)) continue;

renameSync(file, newPath);
```

`continue` (rather than `return`/`break`) keeps the rest of the batch migrating:
the already-existing destination is untouched, the legacy source stays where it
was (so nothing is lost), and every other legacy session in the same run is still
relocated. Re-running the migration is idempotent with respect to the collision.

### 2. `packages/coding-agent/src/core/session-manager.ts` — `loadEntriesFromFile()`

The file reader validates the first parsed entry before it repairs a missing final
newline (`if (pending) appendFileSync(resolvedFilePath, "\n")`). The validation
predicate had been weakened from `||` to `&&`:

```ts
if (header.type !== "session" && typeof (header as { id?: unknown }).id !== "string") return [];
```

With `&&`, a header is only rejected when *both* conditions hold. A parsed entry of
`type: "session"` that lacks a string `id` (missing, `null`, or numeric) therefore
slipped through, and the reader then rewrote the file by appending a newline to a
file it had just failed to recognise as a session. The predicate also disagreed
with the semantics of `parseSessionHeaderCandidate()` in the same module (used by
`readSessionHeader`, `findMostRecentSession`, `SessionManager.findById`), which
already requires `type === "session"` **and** a string `id`.

Repair (one operator, API-preserving):

```ts
if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") return [];
```

Now both paths in the module agree: an entry that is not a session header, or is a
session header without a string `id`, yields `[]` and the file is left byte-for-byte
untouched. Valid headers are still accepted, and a valid (or even malformed but
valid-header-led) unterminated final record is still newline-terminated exactly as
before.

## Why the two fixes belong together

Both are the same policy applied at two boundaries of one pipeline: the migration
moves legacy session files into the session directories, and the session reader
loads and terminates those files. Data safety requires (a) never destroying bytes
that already exist at the destination, and (b) never rewriting a file whose contents
were not accepted as a session. With only one side fixed, a migration could still
clobber a good destination, or a rejected header could still be mutated on read.

## Cross-module validation

`.prale-eval/regression.mjs` drives the real `migrations.ts`, through its real
`fs` boundary (only `readdirSync` ordering is pinned by `subject.mjs`), into the
real `session-manager.ts` reader/`SessionManager`:

1. A colliding legacy file and a pre-existing destination with the same base name:
   destination bytes unchanged, legacy source still present with its original
   bytes, and a second (non-colliding) legacy file still migrated to its
   `sessions/<encoded-cwd>/` directory. Running the migration twice is stable.
2. Cross-module: the real reader loads the migrated file (unterminated final
   record) and appends exactly one newline, returning header + record.
3. Headers with a numeric `id`, a missing `id`, and a non-session entry are all
   rejected with `[]` **and** the files stay byte-identical (no newline repair).
   `SessionManager.open` on such a file throws `not a valid ... session` and does
   not rewrite it.
4. A valid unterminated session still loads two entries and gains exactly one
   newline; an already-terminated file is not modified.

Failure mode is verified, not assumed: restoring *only* `migrations.ts` to its
baseline makes assertion 1 fail (`destination survives` bytes replaced by
`legacy source survives`); restoring *only* `session-manager.ts` to its baseline
makes assertion 3 fail (2 entries returned instead of 0 for the numeric-id file).
Both are uncaught `node:assert/strict` failures, not crashes or import errors.

Fixtures live under `.prale-eval/tmp/` and are removed in a `finally` block, so the
workspace is left clean. No real time, randomness, network or provider calls are
used as evidence.

## Validation limitation

`node --experimental-vm-modules .prale-eval/regression.mjs` is the authoritative
check here and passes. The repository's own `vitest` suites (e.g.
`packages/coding-agent/test/session-manager/file-operations.test.ts`) could not be
run because this workspace has no installed dependencies (`node_modules` absent)
and installing them is out of scope; the regression script reproduces the relevant
`loadEntriesFromFile` expectations directly against the real sources instead.
