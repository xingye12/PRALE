# T05 — wattclaw — contract deliverable

**Task mode:** `contract` · **Repository:** `wattclaw` · **Task id:** `T05`

## 1. What was added

A focused parser/normalizer test for a **user-controlled attachment metadata fixture** on the
generated-file download path (`GET /api/chat/generated-file`):

| Artifact | Role |
| --- | --- |
| `server/utils/__fixtures__/generated-file-path.attachments.json` | 12-case fixture of attacker-influenced attachment metadata (`requestedPath`, `fileName`, `declaredMimeType`, `declaredSizeBytes`) plus the expected lexical normalization |
| `server/utils/generated-file-path.attachment-metadata.test.js` | vitest test that drives the real `resolveGeneratedFileCandidatePath()` with every fixture case (registered in the `test:server` script) |
| `server/handlers/files.js` | two pure helpers (`isGeneratedFilePathAllowed`, `generatedFileMimeType`) made importable (`export` added, no behavior change) so the handler-side metadata rules are directly testable |
| `.prale-eval/verify-attachment-metadata.mjs` | dependency-free executable harness (the validation entry point) |

## 2. Executable demo / validation

```
$ node .prale-eval/verify-attachment-metadata.mjs
{
  "task_id": "T05",
  ...
  "status": "pass",
  "summary": "22/22 checks passed"
}
```

The harness

1. **behaviorally** imports the real, dependency-free normalizer
   `server/utils/generated-file-path.js` and asserts every fixture expectation;
2. **behaviorally** imports `server/handlers/files.js` through a narrow
   `module.registerHooks` resolve hook that substitutes *only* the four import edges that cannot
   load in this checkout (`multer`, `../core/auth.js`, `../user-manager.js`, `../core/system.js` —
   stubs in `.prale-eval/stubs/`), and asserts the deny-list gate and mime derivation;
3. **statically** asserts the source anchors that surround the normalized path
   (`req.query.path` trim + backslash unification, empty/NUL guard, `posix.relative` containment,
   `escapedWorkspace` 403 branch, server-derived response metadata).

## 3. Normalized operation result

`workspaceReal = /home/wattman/.wattclaw/user/report-agent` (server-derived), `requestedPath`
attacker-influenced. Values below are the **observed** return values of the real normalizer,
not hand-written expectations:

| # | `requestedPath` | normalized `candidatePath` | `pathMode` |
| --- | --- | --- | --- |
| 1 | `/downloads/report.pdf` | `<ws>/downloads/report.pdf` | `workspace-root-relative` |
| 2 | `downloads/report.pdf` | `<ws>/downloads/report.pdf` | `workspace-relative` |
| 3 | `downloads/report.pdf` (hostile `declaredMimeType`/`declaredSizeBytes`) | `<ws>/downloads/report.pdf` | `workspace-relative` |
| 4 | `downloads\2026\q1 report.csv` | `<ws>/downloads/2026/q1 report.csv` | `workspace-relative` |
| 5 | `//downloads//report.pdf` | `<ws>/downloads//report.pdf` | `workspace-root-relative` |
| 6 | `<ws>/notes.md` | `<ws>/notes.md` | `workspace-absolute` |
| 7 | `<ws>/` workspace root + `<ws>/notes.md` | `<ws>/notes.md` | `workspace-absolute` |
| 8 | `<ws>` (exactly the workspace root) | `<ws>` | `workspace-absolute` |
| 9 | `./downloads/report.pdf` | `<ws>/./downloads/report.pdf` | `workspace-relative` |
| 10 | `../../secrets/notes.txt` | `<ws>/../../secrets/notes.txt` | `workspace-relative` |
| 11 | `` (empty) | `<ws>/` | `workspace-relative` |
| 12 | `downloads/` | `<ws>/downloads/` | `workspace-relative` |

## 4. Contract pinned by the test

1. **Lexical only.** `resolveGeneratedFileCandidatePath()` strips trailing slashes from the
   workspace, unifies `\` → `/`, and returns exactly one of three modes. Cases 9 and 10 prove it
   does **not** collapse `.` or `..` segments and performs no filesystem/symlink resolution —
   containment is the handler's job.
2. **Client metadata is inert.** Cases 2 and 3 normalize identically although case 3 declares a
   hostile mime type/size, and the test asserts that for any shared `(workspace, requestedPath)`
   input the declared metadata never changes the result.
3. **Anchoring.** Case 8 is the single allowed boundary: the candidate equals the workspace root
   itself; every other candidate is prefixed by `<workspace>/`.
4. **Handler guards remain load-bearing.** Case 11 documents that the empty path is rejected by the
   handler's own 400 guard (and would additionally be caught as a workspace escape); case 12 shows a
   directory-shaped path survives normalization and is rejected later by the regular-file check.
5. **Server-derived attachment metadata.** `isGeneratedFilePathAllowed()` denies `.git`/`.openclaw`
   segments, `.env`/`.env.*` basenames and the internal instruction/state files (case-insensitive),
   and `generatedFileMimeType()` maps the resolved target's extension with an
   `application/octet-stream` fallback — so the response `file.name/path/size/mimeType` never comes
   from the fixture's client-declared fields.

## 5. Validation limits (recorded, not hidden)

`node_modules/` is empty in this checkout, so the repository's own runners cannot execute:

```
$ npm run test:server        # vitest  -> "vitest: not found"
```

Dependencies were **not** installed (out of scope). The vitest file was therefore validated by
`node --check` (syntax) and by executing the identical fixture expectations against the real
modules through the dependency-free harness above; the handler's request-parsing/containment
anchors are covered by static source assertions only. This is a reduced-strength substitute for the
full vitest suite, not an equivalent.
