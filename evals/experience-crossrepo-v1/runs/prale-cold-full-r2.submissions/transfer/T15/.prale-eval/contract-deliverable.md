# Contract deliverable — generated-file (chat attachment) request parsing/normalization

Repository: `wattclaw` · Task: `T15` · Mode: `contract`

## Requested evaluation

"Add a focused parser/normalizer test for a user-controlled configuration or attachment
metadata fixture."

The user-controlled attachment metadata under test is the one handled by
`GET /api/chat/generated-file` (`server/handlers/files.js`): the `path` query value sent by
the client, the workspace path it resolves to, and the `name` / `path` / `mimeType`
metadata that is echoed back in the response.

## Contract (as implemented)

`GET /api/chat/generated-file?sessionKey=…&path=…` evaluates a user-controlled `path`
through this ordered pipeline:

| # | Step | Code | Rule |
|---|------|------|------|
| 1 | normalize request | `normalizeGeneratedFileRequestPath` (`server/utils/generated-file-metadata.js:52`) | non-string → `''`; otherwise `trim()` then `\` → `/` |
| 2 | reject | `files.js:51-54` | empty result or an embedded NUL byte → `400 Invalid generated file request` |
| 3 | resolve | `resolveGeneratedFileCandidatePath` (`server/utils/generated-file-path.js:1`) | path equal to / below the workspace realpath → `workspace-absolute`; otherwise re-anchor under the workspace (`/`-prefixed → `workspace-root-relative`, else `workspace-relative`) |
| 4 | realpath | `files.js:86` | `realpath -e` on the candidate; missing target → `404` |
| 5 | containment | `files.js:96-102` | `posix.relative(workspaceReal, targetReal)` must be non-empty, not `..`, not `../…`, not absolute → otherwise `403 access-denied` |
| 6 | denylist | `isGeneratedFilePathAllowed` (`server/utils/generated-file-metadata.js:60`) | case-insensitive: any `.git` / `.openclaw` segment, or a basename of `.env`, `.env.*`, `agents.md`, `soul.md`, `user.md`, `identity.md`, `tools.md`, `bootstrap.md`, `memory.md`, `workspace-state.json`, `openclaw-workspace-state.json` → `403` |
| 7 | size | `files.js:113-115` | larger than `GENERATED_FILE_MAX_BYTES` (100 MiB, `files.js:30`) → `413` |
| 8 | metadata | `files.js:120-130` | `file = { name: basename(targetReal), path: relativePath, size, mimeType: generatedFileMimeType(targetReal) }`; extension is lowercased, unknown/missing extension → `application/octet-stream` |

Layering note: the denylist is a *policy* filter, not the traversal boundary. `../outside.txt`
is still allowed by `isGeneratedFilePathAllowed`; it is rejected by the step-5 containment
check. Denied directories such as `../.git/config` are additionally rejected by the denylist
(for example if the workspace root itself changes).

## Changes made

| Path | Change |
|------|--------|
| `server/utils/generated-file-metadata.js` | **new** dependency-free module holding the previously inline `isGeneratedFilePathAllowed` and `generatedFileMimeType` logic plus the now-extracted `normalizeGeneratedFileRequestPath`, and the exported denylist constants |
| `server/handlers/files.js` | imports those helpers instead of defining them inline (behaviour-preserving; call sites at lines 37, 98, 128) |
| `server/utils/generated-file-metadata.test.js` | **new** focused parser/normalizer test suite (13 `node:test` tests, fixture-driven) |
| `server/utils/generated-file-metadata.demo.mjs` | **new** executable demo printing the normalized operation result per fixture |
| `package.json` | `test:server` also runs the new suite via the existing `node --test` invocation |

No task metadata, hidden-oracle file, package lock, or git configuration was modified.

## Executable demo (verified in this checkout)

```
$ node server/utils/generated-file-metadata.demo.mjs
workspace: /home/wattman/.wattclaw/user/report-agent
{"raw":"/downloads/Q2\\report.pdf","requestedPath":"/downloads/Q2/report.pdf","candidatePath":"/home/wattman/.wattclaw/user/report-agent/downloads/Q2/report.pdf","pathMode":"workspace-root-relative","status":200,"attachment":{"name":"report.pdf","path":"downloads/Q2/report.pdf","mimeType":"application/pdf"}}
{"raw":"  attachments\\2026\\forecast.XLSX  ","requestedPath":"attachments/2026/forecast.XLSX","candidatePath":"/home/wattman/.wattclaw/user/report-agent/attachments/2026/forecast.XLSX","pathMode":"workspace-relative","status":200,"attachment":{"name":"forecast.XLSX","path":"attachments/2026/forecast.XLSX","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}}
{"raw":"/home/wattman/.wattclaw/user/report-agent/notes/summary.md","requestedPath":"/home/wattman/.wattclaw/user/report-agent/notes/summary.md","candidatePath":"/home/wattman/.wattclaw/user/report-agent/notes/summary.md","pathMode":"workspace-absolute","status":200,"attachment":{"name":"summary.md","path":"notes/summary.md","mimeType":"text/markdown"}}
{"raw":"/home/wattman/.wattclaw/user/report-agent-evil/leak.txt","requestedPath":"/home/wattman/.wattclaw/user/report-agent-evil/leak.txt","candidatePath":"/home/wattman/.wattclaw/user/report-agent/home/wattman/.wattclaw/user/report-agent-evil/leak.txt","pathMode":"workspace-root-relative","status":200,"attachment":{"name":"leak.txt","path":"home/wattman/.wattclaw/user/report-agent-evil/leak.txt","mimeType":"text/plain"}}
{"raw":"../outside.txt","requestedPath":"../outside.txt","candidatePath":"/home/wattman/.wattclaw/user/report-agent/../outside.txt","pathMode":"workspace-relative","status":403,"reason":"access-denied"}
{"raw":".git/config","requestedPath":".git/config","candidatePath":"/home/wattman/.wattclaw/user/report-agent/.git/config","pathMode":"workspace-relative","status":403,"reason":"access-denied"}
{"raw":"/AGENTS.md","requestedPath":"/AGENTS.md","candidatePath":"/home/wattman/.wattclaw/user/report-agent/AGENTS.md","pathMode":"workspace-root-relative","status":403,"reason":"access-denied"}
{"raw":"/.env","requestedPath":"/.env","candidatePath":"/home/wattman/.wattclaw/user/report-agent/.env","pathMode":"workspace-root-relative","status":403,"reason":"access-denied"}
{"raw":null,"requestedPath":"","status":400,"reason":"invalid-request"}
```

The demo stops after step 6 (it does not touch the filesystem), so its `200` rows mean
"policy-accepted candidate path"; the handler would still answer `404` if the realpath does
not exist or `413` if the file exceeds 100 MiB. Row 4 is the interesting one: a look-alike
sibling workspace is *not* honoured as an absolute path — it is re-anchored inside the
workspace, so it can never address files outside it.

## Focused test (verified in this checkout)

```
$ node --test server/utils/generated-file-metadata.test.js
✔ normalizeGeneratedFileRequestPath trims and folds user-controlled separators
✔ normalizeGeneratedFileRequestPath collapses non-string query values to empty
✔ normalizeGeneratedFileRequestPath keeps rejectable input rejectable
✔ resolves normalized request paths into the workspace with a stable path mode
✔ a workspace with a trailing slash still yields workspace-absolute paths
✔ look-alike sibling workspace paths are re-anchored, never treated as absolute
✔ denylist segments and names are the case-insensitive contract constants
✔ isGeneratedFilePathAllowed accepts ordinary attachments
✔ isGeneratedFilePathAllowed rejects VCS/state dirs and secret or agent-instruction files
✔ the denylist is a policy check, not the traversal boundary
✔ generatedFileMimeType parses the resolved attachment extension
✔ composes normalization, containment and metadata for user-controlled fixtures
✔ an empty attachment path can never be normalized into the workspace root
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

Behaviour-preservation check for the extraction (run from the repository root, comparing the
worktree module against `git show HEAD:server/handlers/files.js`):

```
{"mimeChecked":26,"mimeDiff":0,"denyChecked":13,"denyDiff":0}
```

## Environment limitation recorded for validation

This checkout has **no `node_modules`**, so the repository's `vitest` suites
(`npm run test:server` first stage) and anything importing `express`, `multer`,
`better-sqlite3`, … cannot be executed here. `node --test` is the built-in runner and was
therefore used for the focused suite (the repository already runs one suite that way,
`server/services/external-session-projection.test.js`, which itself fails in this checkout
with `ERR_MODULE_NOT_FOUND: Cannot find package 'better-sqlite3'` — pre-existing and
unrelated to this change). The new suite deliberately imports only dependency-free modules
so that it stays runnable in this state.
