# T15 — Contract deliverable: user-controlled generated-file path normalizer

## What was added

`server/utils/generated-file-path.user-controlled.test.js` — a focused, dependency-free
parser/normalizer test for the user-controlled fixture that reaches WattClaw's generated-file
download path. It exercises the real production normalizer
(`resolveGeneratedFileCandidatePath` in `server/utils/generated-file-path.js`) with nine
attacker-shaped fixtures of the kind a user can place in the `path` query parameter of
`GET /api/chat/generated-file` or in generated-attachment metadata.

The test is written with `node:test` + `node:assert/strict` (the style already used by
`server/services/external-session-projection.test.js`) so it runs on the stock Node runtime with
no install step and no mocking of the Gateway.

`package.json` → `scripts.test:server` was extended by one argument so the file runs as part of
the existing `node --test --test-force-exit` leg of the suite.

## Executable demo

```bash
node --test --test-force-exit server/utils/generated-file-path.user-controlled.test.js
```

Observed result in this workspace (Node v24.14.0):

```
✔ normalizes a Windows-style attachment path into a workspace-relative POSIX path
✔ never treats a leading slash as a host-absolute path outside the workspace
✔ neutralizes a Windows drive-absolute fixture inside the workspace root
✔ preserves traversal segments so the caller must re-verify containment
✔ keeps a NUL byte in the fixture so the caller-side guard is load-bearing
✔ tolerates trailing slashes on the workspace root fixture
✔ reports workspace-absolute mode when the fixture already equals the workspace
✔ collapses an empty fixture to the workspace root without fabricating a mode
✔ does not filter denied metadata names; that policy stays in the handler
ℹ tests 9  ℹ pass 9  ℹ fail 0
```

## The contract

Normalizer input: `(workspaceReal, requestedPath)` where `requestedPath` is fully user-controlled.
Normalized output: `{ candidatePath, pathMode }` with `pathMode ∈ {workspace-absolute,
workspace-root-relative, workspace-relative}`.

Workspace fixture used throughout: `/home/wattman/.wattclaw/user/report-agent`.

| User-controlled fixture | Normalized `candidatePath` | `pathMode` |
| --- | --- | --- |
| ``downloads\report.pdf`` | `<ws>/downloads/report.pdf` | `workspace-relative` |
| `/etc/passwd` | `<ws>/etc/passwd` | `workspace-root-relative` |
| ``C:\Users\Public\secret.txt`` | `<ws>/C:/Users/Public/secret.txt` | `workspace-relative` |
| `../..//etc/passwd` | `<ws>/../..//etc/passwd` | `workspace-relative` |
| `downloads/report\0.pdf` | `<ws>/downloads/report\0.pdf` | `workspace-relative` |
| workspace with `///` + `/downloads/report.pdf` | `<ws>/downloads/report.pdf` | `workspace-root-relative` |
| `<ws>` (workspace itself) | `<ws>` | `workspace-absolute` |
| `` (empty) | `<ws>/` | `workspace-relative` |
| `.env` | `<ws>/.env` | `workspace-relative` |

Contract properties pinned by the test:

1. **Normalization only** — backslashes become `/`, trailing slashes on the workspace are
   trimmed, and leading slashes are stripped only for the workspace-relative join.
2. **No host-absolute escape** — a fixture beginning with `/` is interpreted as
   *workspace-root-relative* (`/etc/passwd` → `<ws>/etc/passwd`), and a Windows drive-absolute
   fixture is neutralized into the workspace root.
3. **Not a sandbox** — traversal segments (`..`), NUL bytes and deny-listed names (`.env`) pass
   through unchanged, which is why the caller must enforce policy.
4. **Idempotent classification** — a fixture already equal to the workspace is reported
   `workspace-absolute` and returned verbatim.

## Enforcement lives in the handler (not the normalizer)

`server/handlers/files.js` supplies and consumes the fixture:

- line 75 — trims `req.query.path` and rewrites `\` to `/` (raw user input);
- line 89 — rejects empty path, missing `sessionKey`/`agentId`, and any NUL byte;
- line 112 — calls the normalizer under test;
- lines 122–132 — canonicalizes the candidate with `realpath -e`;
- lines 134–139 — rejects any result whose `posix.relative()` to the workspace is empty, `..`,
  `../`-prefixed or absolute, and rejects `isGeneratedFilePathAllowed` violations (lines 39–45:
  `.git`/`.openclaw` segments, `.env`/`.env.*`, `agents.md`, `soul.md`, `user.md`, `identity.md`,
  `tools.md`, `bootstrap.md`, `memory.md`, `workspace-state.json`,
  `openclaw-workspace-state.json`);
- lines 209–220 and 264–274 — parse the related user-controlled file/attachment metadata fixture
  (`find -printf '%y|<path>|<size>|<mtime>'\n` lines) into
  `{name, path, type, isDirectory, size, updatedAtMs}`.

Because the policy gate is deliberately outside the normalizer, the test asserts on the
normalizer's exact output rather than on a rejection — a regression in either layer breaks
either this test or the handler's guard.

## Validation limitation

`node_modules` is not present in this workspace and dependency installation was out of scope, so
the repo's vitest suites (including the sibling `server/utils/generated-file-path.test.js`) could
not be executed. `node --test server/services/external-session-projection.test.js` fails
pre-existing and unrelated (`ERR_MODULE_NOT_FOUND: better-sqlite3` from `server/database.js`).
The added test imports only the dependency-free normalizer and passes 9/9 on Node v24.14.0.

## Files changed

- added `server/utils/generated-file-path.user-controlled.test.js`
- edited `package.json` (`test:server` script only — one added test path)
- added `.prale-eval/result.json`, `.prale-eval/contract-deliverable.md`

No task metadata, hidden-oracle file, package lock or git configuration was modified.
