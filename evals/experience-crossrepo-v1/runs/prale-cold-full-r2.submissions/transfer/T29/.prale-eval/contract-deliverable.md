# T29 — Traversal / encoded-separator contract for generated-file downloads (`wattclaw`)

Mode: `contract` (adds an executable fixture + normalizes the on-the-wire request into a
`decision` result; no production code was changed).

## Contract

`GET /api/chat/generated-file?path=<value>` is the only path by which an agent workspace file is
read back to a client. The contract is:

1. **Only targets inside the agent workspace root may be served.** Anything that resolves outside
   the canonical workspace root is rejected (`403 File access denied`, or `404 File not found` when
   the target does not exist).
2. **Traversal and encoded separators must not widen that boundary.** `..`, `/..`, `..%2f`,
   `%2e%2e%2f`, `%5c`, and literal `\` separators are all traversal spellings; each must either be
   canonicalized to a location inside the root or be rejected.
3. **Valid generated paths must stay inside the intended root.** Workspace-relative,
   workspace-root-relative (`/downloads/...`) and workspace-absolute requests, interior `.`/`..`
   segments that stay inside the root, and Windows-style `\` separators must all resolve to a
   target under the workspace root and be reported with a `relativePath` that never starts with
   `../`.
4. **Path resolution is a candidate step, enforcement is a separate guard.** The resolver
   `resolveGeneratedFileCandidatePath` maps a request onto a candidate path and deliberately
   returns escaping candidates untouched; the workspace containment check plus the denied
   name/segment list in `server/handlers/files.js` is the security boundary.

## Deliverable: executable fixture

`server/utils/generated-file-path.traversal.test.js` — a dependency-free `node:test` fixture.

```
node --test server/utils/generated-file-path.traversal.test.js
```

It imports the **real** resolver from `server/utils/generated-file-path.js:1-15` and replays the
route's decision pipeline exactly as `server/handlers/files.js` performs it:

| Step | Fixture | Source of truth |
| --- | --- | --- |
| single percent-decode of `?path=` | `decodeURIComponent(wirePath)` | Express query decoding consumed at `files.js:74-75` |
| trim + `\` → `/` | `requestedPath = decoded.trim().replace(/\\/g,'/')` | `files.js:75` |
| empty / NUL rejection → `400 invalid-request` | `files.js:89` |
| candidate resolution | imported `resolveGeneratedFileCandidatePath` | `generated-file-path.js:1-15` |
| canonicalization (`realpath -e`) | `posix.normalize` by default; overridable to model a symlink | `files.js:122-132` |
| workspace containment → `403 escaped-workspace` | `containmentDecision()` | `files.js:134-135` |
| denied segments/names → `403 denied-path` | `isGeneratedFilePathAllowed()` | `files.js:26-45` |
| allowed result | `200 inside-workspace` | `files.js:151+` |

Each case returns a normalized operation result:

```json
{
  "wirePath": "%2e%2e%2fsecret.txt",
  "workspaceReal": "/home/wattman/.wattclaw/user/report-agent",
  "decision": "deny",
  "status": 403,
  "reason": "escaped-workspace",
  "pathMode": "workspace-relative",
  "candidatePath": "/home/wattman/.wattclaw/user/report-agent/../secret.txt",
  "candidateRelativePath": "../secret.txt",
  "targetReal": "/home/wattman/.wattclaw/user/secret.txt",
  "relativePath": "../secret.txt"
}
```

### Coverage

* Valid paths (8 cases) — `downloads/report.pdf`, `/downloads/report.pdf`, workspace-absolute,
  `reports\2026\q1.pdf`, `./downloads/../downloads/report.pdf`, `%2e/downloads/report.pdf`,
  double-encoded `%252e%252e%252fsecret.txt` (stays a literal in-root file name because the value
  is decoded only once), and a sibling directory that merely shares the root prefix
  (`/…/report-agent-v2/notes.txt`) — all `allow`, all targets under the root.
* Unsafe paths (16 cases) — `../secret.txt`, `/../etc/passwd`, `%2e%2e%2fsecret.txt`,
  `..%2f..%2fetc%2fpasswd`, `%2e%2e%2f%2e%2e%2fetc%2fpasswd`, `..%5c..%5csecret.txt`,
  `..\..\etc\passwd`, `${workspace}/../../outside.txt`, a duplicated-root-prefix escape,
  `downloads/report.pdf%00/../../etc/passwd` (NUL → `400`), `.git/config`, `.openclaw/…`,
  `notes/memory.md`, `.env.local`, `Notes/MEMORY.MD`, and `.` (the workspace root itself) — all
   rejected with a non-`200` status and an attributable reason.
* Guard-as-boundary test — for every traversal spelling, the resolver's candidate is shown to
   escape the root *and* the guard is shown to reject exactly that candidate.
* Symlink test — a symlink inside the root whose canonical target lives outside the root is
   rejected even though the candidate string is inside the root.

## Validation

```
node --test server/utils/generated-file-path.traversal.test.js
# tests 29 / pass 29 / fail 0
```

## Limitations recorded

* `vitest` is not installed in this environment (`node_modules/` is absent and dependencies may not
  be installed), so the pre-existing `server/utils/generated-file-path.test.js` (vitest syntax)
  could not be executed; the new fixture uses the repo's `node:test` convention instead
  (see `package.json` `test:server`, which already runs `node --test` for
  `server/services/external-session-projection.test.js`).
* `server/handlers/files.js` cannot be imported in this environment because it depends on
  `express`, `multer`, and other uninstalled packages, so the fixture restates the containment and
  denied-name predicates verbatim with source citations (`files.js:26-45`, `134-139`) and imports
  the real resolver for the resolution step.
* `realpath -e` (which also resolves symlinks) is modelled by `posix.normalize` for the string
  cases and by an explicit `canonicalize` override for the symlink case; no filesystem paths
  outside the workspace are touched by the fixture.
* No production source, task metadata, lockfile, or git configuration was modified; the only added
  files are this document, `server/utils/generated-file-path.traversal.test.js`, and
  `.prale-eval/result.json`.
