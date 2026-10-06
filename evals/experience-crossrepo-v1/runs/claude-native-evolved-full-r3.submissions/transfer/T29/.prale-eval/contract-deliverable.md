# T29 — Traversal / encoded-separator contract

**Repository:** `wattclaw` · **Mode:** `contract`

## Contract

The generated-file download path is split across two components, and the contract pins
exactly which one is responsible for what.

1. **Builder** — `resolveGeneratedFileCandidatePath(workspaceReal, requestedPath)`
   (`server/utils/generated-file-path.js:1-15`) is a *pure* path builder. It normalizes
   trailing slashes and Windows separators and returns a `candidatePath` plus one of three
   modes:

   | input shape | `pathMode` | `candidatePath` |
   | --- | --- | --- |
   | `downloads/r.pdf` | `workspace-relative` | `<ws>/downloads/r.pdf` |
   | `/downloads/r.pdf` | `workspace-root-relative` | `<ws>/downloads/r.pdf` |
   | `<ws>/downloads/r.pdf` | `workspace-absolute` | `<ws>/downloads/r.pdf` |

   It **never rejects**. Traversal payloads are returned verbatim as candidates.

2. **Guard** — the `/api/chat/generated-file` handler (`server/handlers/files.js:72-173`)
   owns rejection. After `realpath -e` resolves the candidate (which collapses `..` and
   symlinks), lines 134-139 compute
   `posix.relative(workspaceReal, targetReal)` and deny with `403 File access denied` when:

   ```
   !relativePath || relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)
   ```

   Only after containment passes does `isGeneratedFilePathAllowed` (`files.js:39-45`) apply
   the `.git` / `.openclaw` / `.env` / sensitive-name deny-list.

**Contract statement.** A candidate that escapes the workspace root after lexical
normalization MUST be rejected, every valid generated path MUST remain inside the intended
root, and percent-encoded separators MUST NOT be decoded by the builder — so they remain a
single literal segment inside the root.

## Executable demo

New fixture: `server/utils/generated-file-path.traversal.test.js`.
It imports the real `resolveGeneratedFileCandidatePath` and models the handler guard
(`containmentVerdict`, a faithful copy of the `escapedWorkspace` predicate, with
`posix.normalize` standing in for `realpath -e` on non-symlinked paths).

```
$ node --test server/utils/generated-file-path.traversal.test.js
✔ keeps valid relative, root-relative and workspace-absolute paths inside the root
✔ normalizes backslash separators without leaving the root
✔ redundant separators and trailing-slash workspace do not double the root
✔ rejects `..` traversal in every position
✔ treats a workspace boundary that is a prefix of a sibling as inside the root
✔ rejects the workspace root itself (escape by exact match)
✔ does not decode percent-encoded separators, so encoded traversal cannot escape
✔ rejects the traversal that a single URI decode would produce (defense in depth)
ℹ tests 8   ℹ pass 8   ℹ fail 0
```

### Cases covered

**Valid paths stay inside the root** — relative, root-relative and workspace-absolute forms
all resolve to `<ws>/downloads/report.pdf`; backslash separators (`downloads\r.pdf`) and
redundant separators (`/downloads//r.pdf`) normalize without leaving the root; a
trailing-slash workspace does not double the root.

**Unsafe paths are rejected** — `..`, `../etc/passwd`, `/../../etc/passwd`,
`a/b/../../../../etc/shadow`, `nested/../../outside.txt`, the backslash traversal
`..\..\windows\system32`, and a workspace-absolute path that folds out through `..`
(`<ws>/../sibling/secrets.txt`) all trip `escapedWorkspace`. The workspace root itself
(`<ws>` / `<ws>/`, where `posix.relative` returns `''`) is also rejected, matching the
handler's `!relativePath` clause.

**Boundary confusion** — `<ws>-evil/leak.txt` shares the workspace only as a plain string
prefix and is not treated as workspace-absolute; the resulting candidate is anchored *under*
the root, so it stays contained.

**Encoded separators** — `%2e%2e%2f%2e%2e%2fetc/passwd`, `..%2f..%2fetc%2fpasswd`,
`%252e%252e%252f…` (double-encoded) and `%5c..%5c..%5cwindows` are not decoded by the
builder; the payload stays one literal segment inside the root. As defense in depth, the
once-decoded form (`decodeURIComponent('%2e%2e%2f…') === '../../etc/passwd'`) is shown to be
rejected by the guard — which is the actual state Express's query parser hands the handler.

## Normalized operation result

| requested path | resolved candidate | `pathMode` | verdict |
| --- | --- | --- | --- |
| `downloads/report.pdf` | `<ws>/downloads/report.pdf` | workspace-relative | allowed |
| `/downloads/report.pdf` | `<ws>/downloads/report.pdf` | workspace-root-relative | allowed |
| `<ws>/downloads/report.pdf` | `<ws>/downloads/report.pdf` | workspace-absolute | allowed |
| `..` | `<ws>/..` | workspace-relative | **rejected** |
| `../etc/passwd` | `<ws>/../etc/passwd` | workspace-relative | **rejected** |
| `..\..\windows\system32` | `<ws>/../../windows/system32` | workspace-relative | **rejected** |
| `<ws>/../sibling/secrets.txt` | `<ws>/../sibling/secrets.txt` | workspace-absolute | **rejected** |
| `%2e%2e%2f%2e%2e%2fetc/passwd` | `<ws>/%2e%2e%2f%2e%2e%2fetc/passwd` | workspace-relative | allowed (literal, contained) |
| `<ws>` | `<ws>` | workspace-absolute | **rejected** |

(`<ws>` = `/home/wattman/.wattclaw/user/report-agent`.)

## Changes

- **Added** `server/utils/generated-file-path.traversal.test.js` — the contract fixture.
- No production code was changed: the resolver is intentionally a pure builder and the
  handler already enforces containment, so the minimal correct action is to pin the contract
  with a fixture rather than add redundant rejection logic.

## Validation

```
node --test server/utils/generated-file-path.traversal.test.js
```

**Status: pass** — 8/8, Node v24.14.0, ~63 ms.

**Limitation:** the repo's configured runner is vitest, but `node_modules` is not installed
and dependency installation is out of scope for this task. The fixture therefore uses the
built-in `node:test` + `node:assert/strict` runner so it is directly executable now; the
pre-existing vitest test (`server/utils/generated-file-path.test.js`) was left untouched and
was not executed for the same reason. Semantics are equivalent, so it should pass unchanged
under vitest once dependencies are available.
