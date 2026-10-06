# Operate deliverable — generated-file path resolution + attachment utilities

Task `20` · repository `wattclaw` · mode `operate`

Executable demo: **`.prale-eval/demo/generated-file-path-demo.mjs`**
Raw run output: **`.prale-eval/demo/demo-output.json`**

Run it (no dependencies required — pure Node ESM against the repository's real modules):

```bash
node .prale-eval/demo/generated-file-path-demo.mjs
```

## What is being operated

| Module | Symbol(s) | Role |
| --- | --- | --- |
| `server/utils/generated-file-path.js` | `resolveGeneratedFileCandidatePath` | Pure builder of a *candidate* path for `GET /api/chat/generated-file`; classifies input into one of three path modes. Performs **no** validation and **no** rejection. |
| `server/gateway-file-transfer.js` | `sanitizeFilename`, `buildRemoteFileName`, `uploadToGateway`, `deleteRemoteFile`, `writeRemoteFile` | Attachment name sanitization and local-filesystem attachment read/write/delete. |

The actual accept/reject decision lives one layer up in `server/handlers/files.js`: after the candidate is produced, the route canonicalizes it with `realpath -e` and applies a `posix.relative` containment test plus a denied-name policy. The demo mirrors that guard because `isGeneratedFilePathAllowed` and the denied sets are module-private.

## Contract

`resolveGeneratedFileCandidatePath(workspaceReal, requestedPath) → { candidatePath, pathMode }`

- Backslashes in `requestedPath` are normalized to `/`; trailing slashes are stripped from the workspace.
- `pathMode` is exactly one of:
  - `workspace-absolute` — request equals the workspace or starts with `<workspace>/`; returned unchanged.
  - `workspace-root-relative` — request started with `/`; joined under the workspace root.
  - `workspace-relative` — any other relative request; joined under the workspace root.
- **`candidatePath` is not canonical.** `..` segments are preserved and no rejection happens here.

The effective route verdict (`server/handlers/files.js`) is:

| Condition | Result |
| --- | --- |
| Missing/empty path, or path contains `\0` | `400 Invalid generated file request` |
| `realpath -e` fails | `404 File not found` |
| canonical target escapes workspace (`relativePath` empty, `..`, `../*`, or absolute) | `403 File access denied` |
| canonical target inside workspace but matches denied segment/name | `403 File access denied` |
| canonical target is a regular in-workspace file | `200` with base64 content |

## Controlled fixture

```
.prale-eval/demo/fixture/
├── workspace/                 <- workspaceReal (the agent workspace root)
│   ├── downloads/report.pdf   <- safe, in-workspace file
│   ├── notes.md
│   ├── .env                   <- denied name
│   ├── agents.md              <- denied name
│   └── escape-link -> ../secret.txt   (symlink escaping the workspace)
└── secret.txt                 <- outside the workspace
```

## Normalized operation result

Canonical paths below are abbreviated: `WS` = the fixture workspace root,
`FX` = `.prale-eval/demo/fixture`.

| `requestedPath` | `pathMode` | canonical path | verdict | rejection reason |
| --- | --- | --- | --- | --- |
| `downloads/report.pdf` | `workspace-relative` | `WS/downloads/report.pdf` | **allowed 200** | — |
| `/downloads/report.pdf` | `workspace-root-relative` | `WS/downloads/report.pdf` | **allowed 200** | — |
| `WS/downloads/report.pdf` | `workspace-absolute` | `WS/downloads/report.pdf` | **allowed 200** | — |
| `../secret.txt` | `workspace-relative` | `FX/secret.txt` | **rejected 403** | canonical path escapes workspace (`relativePath` = `../secret.txt`) |
| `..\secret.txt` | `workspace-relative` | `FX/secret.txt` | **rejected 403** | same, after backslash normalization |
| `escape-link` | `workspace-relative` | `FX/secret.txt` | **rejected 403** | symlink canonicalizes outside the workspace |
| `.env` | `workspace-relative` | `WS/.env` | **rejected 403** | denied name (`.env`) |
| `agents.md` | `workspace-relative` | `WS/agents.md` | **rejected 403** | denied name (`agents.md`) |
| `.git/config` | `workspace-relative` | — | **rejected 404** | file absent (`realpath -e` fails before the name policy) |
| `downloads/report.pdf\0` | — | — | **rejected 400** | invalid request (NUL byte) |
| *(empty)* | — | — | **rejected 400** | invalid request (empty path) |

Key finding: the resolver alone would happily emit `<WS>/../secret.txt`; safety comes entirely from canonicalizing the candidate and testing containment. The `escape-link` case makes this explicit — textual prefix matching would pass, but the canonical path (`FX/secret.txt`) is rejected.

## Attachment utilities result

| Operation | Input | Result |
| --- | --- | --- |
| `sanitizeFilename` | `../../etc/pass wd?.pdf` | `.._.._etc_pass_wd_.pdf` — `/`, `\`, space, `?` all replaced with `_`; dots kept but harmless without separators |
| `buildRemoteFileName` | `report.pdf` | `{ fileName: 'report---<8hex>.pdf', baseName: 'report', ext: '.pdf' }` |
| `uploadToGateway` | 27-byte buffer → fixture media dir | wrote `<mediaDir>/report---<8hex>.pdf`; canonical path stayed inside the media directory |
| `deleteRemoteFile` | uploaded path / missing path | `true` / `true` (idempotent on `ENOENT`) |
| `writeRemoteFile` | text inside media dir | `true` (creates parent dirs recursively) |

## Validation

- Command: `node .prale-eval/demo/generated-file-path-demo.mjs` — **passed** (exit 0), 11 path cases + 5 attachment operations.
- Limitation: `node_modules` is absent, so the repository's `vitest` suite (including `server/utils/generated-file-path.test.js`) could not be executed and dependency installation was out of scope. No linter is configured in this repository.
- Scope: no repository source file was modified; only `.prale-eval/` artifacts were created.
