# Contract deliverable — T15 (wattclaw, mode: contract)

## Subject

A focused **parser/normalizer test** for **user-controlled generated-file request
metadata** on the WattClaw backend. The untrusted surface is the `path` query
parameter (plus `sessionKey`) of `GET /api/chat/generated-file`, the endpoint the
chat UI uses to fetch an attachment/artifact that an agent wrote into its
workspace.

## Contract under test

`resolveGeneratedFileCandidatePath(workspaceReal, requestedPath)`
(`server/utils/generated-file-path.js:1-15`) is the single authoritative
normalizer used by the route in `server/handlers/files.js` (`createFileRoutes`,
line 72; delegated at line 112).

Inputs → normalized operation result:

| Rule | Input (user-controlled) | Normalized `candidatePath` | `pathMode` |
| --- | --- | --- | --- |
| Workspace trailing slashes stripped | workspace `…/report-agent///` + `downloads/report.pdf` | `…/report-agent/downloads/report.pdf` | `workspace-relative` |
| Backslashes folded to `/` | `downloads\report.pdf` | `…/report-agent/downloads/report.pdf` | `workspace-relative` |
| Leading `/` re-anchored at workspace root | `/downloads/report.pdf` | `…/report-agent/downloads/report.pdf` | `workspace-root-relative` |
| Duplicate leading slashes collapsed | `//downloads/report.pdf` | `…/report-agent/downloads/report.pdf` | `workspace-root-relative` |
| In-workspace absolute path preserved verbatim | `…/report-agent/downloads/report.pdf` | same | `workspace-absolute` |
| Path equal to workspace root preserved | `…/report-agent` (or `…/report-agent/`) | same | `workspace-absolute` |
| `..` segments forwarded unchanged | `../../etc/passwd` | `…/report-agent/../../etc/passwd` | `workspace-relative` |

Key contract property: the normalizer **only parses and joins**. It does not
sanitize `..` and does not enforce containment — that is the job of the caller.

## Executable demo

Two files were added (no production code changed):

- `server/utils/fixtures/generated-file-requests.js` — the user-controlled
  metadata fixture: `WORKSPACE_REAL` plus `generatedFileRequestFixtures`, 12 rows
  of `{ name, workspace, requestedPath, expectedCandidatePath, expectedPathMode }`
  covering relative paths, bare attachment filenames, root-relative paths,
  duplicate leading slashes, Windows separators, in-workspace absolute paths,
  workspace-root inputs, and `..` traversal attempts.
- `server/utils/generated-file-path.fixture.test.js` — the focused test. It drives
  every fixture row through the normalizer and asserts the exact
  `{ candidatePath, pathMode }`, plus four targeted cases (backslash folding,
  workspace trailing-slash stripping, `workspace-absolute` classification, and
  non-sanitization of `..` verified with `posix.normalize`).

Run it:

```bash
node --test server/utils/generated-file-path.fixture.test.js
```

Result: **5 tests, 5 pass, 0 fail** (node v24.14.0).

## Where the rest of the contract lives (and is documented, not duplicated)

The route in `server/handlers/files.js` composes the normalizer with two further
checks that the test intentionally does not re-implement:

1. **Pre-parse rejection** (lines 74-92): `path` is trimmed and backslash-folded;
   empty `sessionKey`/`agentId`/`path` or any NUL byte → `400`.
2. **Post-normalization authorization** (lines 134-139): the handler `realpath`s
   the candidate, computes `posix.relative(workspaceReal, targetReal)`, rejects
   escapes with `403`, and applies `isGeneratedFilePathAllowed` (lines 39-45),
   which lowercases each segment and denies `.git`/`.openclaw` segments,
   `.env`/`.env.*` names, and protected agent files (`agents.md`, `soul.md`,
   `user.md`, `identity.md`, `tools.md`, `bootstrap.md`, `memory.md`,
   `workspace-state.json`, `openclaw-workspace-state.json`).

Attachment MIME metadata is normalized separately by `generatedFileMimeType`
(lines 47-70), which lowercases the extension and maps it to a canonical MIME
type with an `application/octet-stream` fallback.

## Validation limitation

`package.json` declares vitest, but `node_modules` is not vendored in this
workspace, so `npm run test:server` / `npx vitest run` cannot execute here. The
new test therefore uses the built-in `node:test` runner — an existing in-repo
pattern (`server/services/external-session-projection.test.js`) — so it runs on a
bare Node install. The pre-existing vitest file
`server/utils/generated-file-path.test.js` was left unchanged and was not run for
the same reason.
