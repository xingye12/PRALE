# T29 — Traversal / encoded-separator contract for generated-file paths

Repository: `wattclaw` · Mode: `contract`

## What this contract covers

The generated-file download route resolves a caller-supplied `requestedPath`
into an absolute candidate under an agent workspace, then streams it back. The
security-relevant question is: **can a request make the server read a file
outside the workspace root?** This deliverable fixes that contract as an
executable fixture with two guarantees:

1. **Unsafe paths are rejected.** Plain traversal (`../`), backslash and
   leading-slash traversal, encoded separators (`%2e`, `%2f`, `%5c`, `%00`),
   raw/encoded null bytes, empty paths, and the workspace root itself.
2. **Valid generated paths remain inside the intended root.** Every accepted
   candidate is a strict descendant of the workspace root, with no `..`
   segment and no absolute escape.

## Where the logic lives

| File | Symbol | Role |
| --- | --- | --- |
| `server/utils/generated-file-path.js` | `resolveGeneratedFileCandidatePath` | Normalizes a request into `{ candidatePath, pathMode }` (`workspace-absolute`, `workspace-root-relative`, `workspace-relative`). **Normalization only — it never rejects.** |
| `server/utils/index.js` | `safePath` | Canonical containment predicate: resolve, `relative(base, target)`, reject on `..` escape. |
| `server/handlers/files.js` | `isGeneratedFilePathAllowed` | Allow-list over the relative path (denied segments / `.env*`). |
| `server/handlers/files.js` | `escapedWorkspace` | Live enforcement: `posix.relative` + 403 on empty / `..` / `../` / absolute. |

Because the resolver alone does not reject, the contract must compose it with
the containment predicate. The fixture does exactly that.

## Normalized operation

Added in `server/utils/generated-file-path.contract.js`:

```js
normalizeGeneratedFilePath(workspaceReal, requestedPath)
  -> { ok: false, reason }                                  // unsafe
  -> { ok: true, candidatePath, pathMode, relativePath }    // safe, inside root
```

Reasons: `workspace-required`, `empty-path`, `null-byte`,
`encoded-separator`, `escapes-workspace`.

Pipeline:

1. Strip trailing slashes from the workspace root.
2. Reject empty paths, embedded `\0`, and encoded separator/traversal tokens
   (`/%2e|%2f|%5c|%00/i`) **before** resolution — so a later decode can never
   introduce a separator or `..` segment.
3. Delegate to `resolveGeneratedFileCandidatePath`.
4. Apply the handler's containment predicate
   (`posix.relative` → reject `''`, `..`, `../*`, absolute) and return the
   accepted candidate.

## Executable demo

The fixture runs on Node's built-in test runner — no dev dependencies:

```bash
node --test server/utils/generated-file-path.traversal.test.js
```

Fixture workspace root: `/home/wattman/.wattclaw/user/report-agent`

Normalized results (printed by the fixture, `node` v24.14.0):

```
"../outside.txt"                             REJECT (escapes-workspace)
"downloads/../../outside.txt"                REJECT (escapes-workspace)
"..\..\outside.txt"                          REJECT (escapes-workspace)
"/../outside.txt"                            REJECT (escapes-workspace)
"/"                                          REJECT (escapes-workspace)
"%2e%2e%2foutside.txt"                       REJECT (encoded-separator)
"downloads%5c..%5coutside.txt"               REJECT (encoded-separator)
"reports%2f..%2f..%2fetc%2fpasswd"           REJECT (encoded-separator)
"%2E%2E%2Foutside.txt"                       REJECT (encoded-separator)
"reports%2fevil.pdf%00"                      REJECT (encoded-separator)
"reports/\u0000evil.pdf"                     REJECT (null-byte)
""                                           REJECT (empty-path)
"downloads/report.pdf"                       ACCEPT -> downloads/report.pdf [workspace-relative]
"/downloads/report.pdf"                      ACCEPT -> downloads/report.pdf [workspace-root-relative]
"/home/wattman/.wattclaw/user/report-agent/downloads/report.pdf"
                                             ACCEPT -> downloads/report.pdf [workspace-absolute]
"reports/2026 Q1/quarterly summary.pdf"      ACCEPT -> reports/2026 Q1/quarterly summary.pdf [workspace-relative]
"downloads/../downloads/report.pdf"          ACCEPT -> downloads/report.pdf [workspace-relative]
"/home/wattman/.wattclaw/user/report-agent-evil/x.pdf"
                                             ACCEPT -> home/wattman/.wattclaw/user/report-agent-evil/x.pdf [workspace-root-relative]
```

The last accepted row is the sibling-prefix probe: a path that merely shares a
string prefix with the root is *re-rooted inside* the workspace instead of
being treated as already-inside — it cannot escape.

## Validation

| | |
| --- | --- |
| Command | `node --test server/utils/generated-file-path.traversal.test.js` |
| Status | **passed** — 20/20 assertions, 0 failures (~72 ms) |
| Dependencies | none beyond Node built-ins (`node:test`, `node:assert/strict`, `node:path`) |

**Limitation recorded:** `node_modules/` is absent in this workspace, so
`vitest` is not installed (`import('vitest')` → `ERR_MODULE_NOT_FOUND`). The
pre-existing vitest suite `server/utils/generated-file-path.test.js` was
therefore **not executed** and was left unmodified. No dependencies were
installed; no package lock, task metadata, hidden-oracle file, or git
configuration was touched.

## Files added

- `server/utils/generated-file-path.contract.js` — normalized operation + case table.
- `server/utils/generated-file-path.traversal.test.js` — executable fixture.
