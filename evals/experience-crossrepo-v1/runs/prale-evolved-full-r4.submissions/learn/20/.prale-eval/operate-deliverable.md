# Operate deliverable — canonical path resolution & unsafe-input rejection

Task: `wattclaw` task `20` (mode `operate`).
Subject: `server/utils/generated-file-path.js` plus the attachment utilities in
`server/gateway-file-transfer.js`, exercised on a controlled file fixture.

## Executable demo

```
node scripts/operate-generated-file-path-demo.mjs
```

- Exit code `0`; `DEMO OK: 35 assertions passed; fixture removed`.
- The script creates a throwaway fixture inside the repository workspace
  (`<workspace>/.operate-fixture-*/`), runs all operations, prints a JSON report
  to stdout, and removes the fixture in a `finally` block.
- Imported from the repository, not re-implemented:
  `resolveGeneratedFileCandidatePath` (pure resolver) and
  `sanitizeFilename`, `buildRemoteFileName`, `uploadToGateway`,
  `deleteRemoteFile`, `writeRemoteFile` (attachment utilities).
- Because `createFileRoutes` in `server/handlers/files.js` is not exported, the
  demo replays the exact acceptance gates that route composes around the
  resolver (`realpath -e`, `posix.relative` escape check, denied name/segment
  check, regular-file check, size check).

## Fixture

```
<fixture>/workspace/downloads/report.pdf          (regular file, 22 B)
<fixture>/workspace/downloads/notes.txt
<fixture>/workspace/downloads/.env                (denied by name)
<fixture>/workspace/downloads/.git/config          (denied by segment)
<fixture>/workspace/AGENTS.md                      (denied by name)
<fixture>/workspace/downloads/escape-link.txt      -> <fixture>/outside/secret.txt (symlink)
<fixture>/outside/secret.txt                        (outside the workspace root)
<fixture>/media/inbound/                            (attachment target dir)
```

## Normalized operation result — path resolution

`workspaceReal = <fixture>/workspace` (realpath, trailing slash removed).
`canonicalPath` is the realpath of the resolved candidate (what the route would
serve); it is `null` when `realpath -e` fails.

| # | requested input | mode | canonical path | status | reason |
|---|-----------------|------|----------------|--------|--------|
| 1 | `downloads/report.pdf` | `workspace-relative` | `<ws>/downloads/report.pdf` | 200 | served (`application/pdf`, 22 B) |
| 2 | `/downloads/report.pdf` | `workspace-root-relative` | `<ws>/downloads/report.pdf` | 200 | served |
| 3 | `./downloads/notes.txt` | `workspace-relative` | `<ws>/downloads/notes.txt` | 200 | served |
| 4 | `<ws>/downloads/report.pdf` | `workspace-absolute` | `<ws>/downloads/report.pdf` | 200 | served |
| 5 | `downloads/../downloads/report.pdf` | `workspace-relative` | `<ws>/downloads/report.pdf` | 200 | served (interior `..` stays inside) |
| 6 | `../outside/secret.txt` | `workspace-relative` | `<fixture>/outside/secret.txt` | 403 | File access denied: resolves outside workspace root |
| 7 | `/../outside/secret.txt` | `workspace-root-relative` | `<fixture>/outside/secret.txt` | 403 | File access denied: resolves outside workspace root |
| 8 | `downloads/../../outside/secret.txt` | `workspace-relative` | `<fixture>/outside/secret.txt` | 403 | File access denied: resolves outside workspace root |
| 9 | `downloads/escape-link.txt` | `workspace-relative` | `<fixture>/outside/secret.txt` | 403 | File access denied: resolves outside workspace root (symlink followed by realpath) |
| 10 | `downloads/.env` | `workspace-relative` | `<ws>/downloads/.env` | 403 | File access denied: denied name or segment |
| 11 | `/downloads/.git/config` | `workspace-root-relative` | `<ws>/downloads/.git/config` | 403 | File access denied: denied name or segment |
| 12 | `AGENTS.md` | `workspace-relative` | `<ws>/AGENTS.md` | 403 | File access denied: denied name or segment |
| 13 | `/etc/hostname` | `workspace-root-relative` | `null` | 404 | File not found — host absolute path is re-rooted under the workspace, never reaches the host FS |
| 14 | `downloads` | `workspace-relative` | `<ws>/downloads` | 400 | Only regular files can be downloaded |
| 15 | `downloads/missing.pdf` | `workspace-relative` | `null` | 404 | File not found |
| 16 | `downloads/report.pdf\0.txt` | — | — | 400 | Invalid generated file request (NUL byte, pre-resolution) |

Canonical-path contract demonstrated:

1. Relative and leading-slash inputs are both canonicalised **under the
   workspace root**; the leading slash selects `workspace-root-relative` but does
   **not** mean host-absolute (case 13).
2. A workspace-absolute input is preserved verbatim (case 4).
3. `..` segments are not stripped by the resolver; they are neutralised
   downstream by `realpath` + `posix.relative`, which yields a 403 (cases 6–8).
4. Realpath following makes symlink escapes indistinguishable from textual
   traversal and rejected identically (case 9).
5. Contained-but-sensitive names (`.env`, `.git/*`, `AGENTS.md`) are rejected
   even though they never leave the workspace (cases 10–12).

## Normalized operation result — attachment utilities

| operation | input | result |
|-----------|-------|--------|
| `sanitizeFilename` | `../etc/passwd` | `.._etc_passwd` (no `/`, no `\`) |
| `sanitizeFilename` | `报表 2026?.pdf` | `报表_2026_.pdf` (unicode kept) |
| `sanitizeFilename` | `"  "` | `''` → caller falls back to `file` |
| `sanitizeFilename` | 80×`a` + `.pdf` | 60 chars (truncated) |
| `buildRemoteFileName` | `../../etc/passwd` | `{ fileName: ".._.._etc_passwd---<8hex>", baseName: ".._.._etc_passwd", ext: "" }` — single path segment |
| `buildRemoteFileName` | `季度 报告 2026.pdf` | `{ fileName: "季度_报告_2026---<8hex>.pdf", ext: ".pdf" }` |
| `uploadToGateway` | `Buffer("fixture payload")`, `季度 报告.pdf`, `GATEWAY_MEDIA_DIR=<fixture>/media/inbound` | `path` exactly `<mediaDir>/<fileName>`, `size` 15, bytes round-trip on disk |
| `deleteRemoteFile` | uploaded path (twice) | `true`, `true` — removal is idempotent (ENOENT → true) |
| `writeRemoteFile` | `<mediaDir>/nested/deep/note.txt` | `true` (parents created, content verified) |
| `writeRemoteFile` | `<mediaDir>/blocked.txt/child.txt` where `blocked.txt` is a file | `false` (mkdir ENOTDIR, never throws) |

## Contract summary

- **Resolver** (`resolveGeneratedFileCandidatePath`): pure, normalises `\` → `/`,
  strips trailing slashes from the workspace, preserves workspace-absolute
  inputs, and otherwise joins the workspace root with the input after dropping
  leading slashes. It returns `{ candidatePath, pathMode }` where `pathMode` is
  one of `workspace-absolute`, `workspace-root-relative`, `workspace-relative`.
  It performs **no** traversal checking — that responsibility is downstream.
- **Route gate** (`GET /api/chat/generated-file`): `realpath -e` the candidate
  (miss → 404), compute `posix.relative(workspaceReal, targetReal)`, reject with
  403 if that is empty/`..`/`../*`/absolute **or** if the relative path hits a
  denied segment (`.git`, `.openclaw`) or a denied name (`.env`, `.env.*`,
  `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `BOOTSTRAP.md`,
  `MEMORY.md`, `workspace-state.json`, `openclaw-workspace-state.json`), then
  reject non-regular files with 400 and files over 100 MiB with 413.
- **Attachments** (`gateway-file-transfer.js`): filenames are flattened to a
  single segment and the remote name is `{sanitized}---{8-hex-uuid}{ext}`;
  uploads are confined to `GATEWAY_MEDIA_DIR` (or an explicit `targetDir`);
  delete is idempotent; write returns `false` instead of throwing on failure.

## Validation

```
node scripts/operate-generated-file-path-demo.mjs     # status: pass (exit 0, 35/35 assertions)
```

Optional repo-native validation **not run**: `npx vitest run
server/utils/generated-file-path.test.js` requires `vitest`, which is declared in
`package.json` but absent because `node_modules/` is not installed in this
workspace; installing dependencies is out of scope, so the limitation is
recorded instead. The demo independently re-asserts the three cases covered by
that test file (leading-slash, relative, and workspace-absolute resolution).
