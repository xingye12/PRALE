# T08 — Operate deliverable (wattclaw): offline-safe generated-deliverable fixture check

## What was operated

Executable demo (the only command needed, no install step):

```bash
node .prale-eval/verify-generated-deliverable.mjs
```

`status: pass` (exit code 0). The script `.prale-eval/verify-generated-deliverable.mjs` is a
self-contained Node harness that loads **two pure modules straight from the repository** and drives
one shared fixture set through both sides of the generated-file contract:

| Side | Module | Symbol |
| --- | --- | --- |
| frontend (browser) | `src/utils/generated-attachments.ts` | `extractGeneratedAttachments` |
| server (Express handler) | `server/utils/generated-file-path.js` | `resolveGeneratedFileCandidatePath` (used by `server/handlers/files.js`) |

## The contract being verified

The frontend turns agent output into clickable attachments; the download component
(`src/views/workspace/components/GeneratedAttachment.vue`, `download()`) sends
`?sessionKey=…&path=<attachment.path>` to `GET /api/chat/generated-file`, and the server resolves
that path against the agent workspace before doing any filesystem work
(`server/handlers/files.js` lines 112‑119). The fixture therefore asserts, for each case:
*frontend extraction* → *server resolution* → expected absolute candidate path + `pathMode`.

| Fixture (agent output) | Frontend attachment path | Server resolution (workspace `/home/wattman/.wattclaw/user/agent`) |
| --- | --- | --- |
| `MEDIA:/…/agent/downloads/report.pdf` | `/home/wattman/.wattclaw/user/agent/downloads/report.pdf` | same path, `workspace-absolute` |
| markdown file table `outputs/报告.xlsx` | `outputs/报告.xlsx` | `/…/agent/outputs/报告.xlsx`, `workspace-relative` |
| delivery cue + `` `/downloads/东北旅游攻略.html` `` | `/downloads/东北旅游攻略.html` | `/…/agent/downloads/东北旅游攻略.html`, `workspace-root-relative` |
| `[官网](https://example.com/report.pdf) [配置](../.env)` | *(none — rejected)* | *(nothing reaches the server)* |

All three `pathMode` values the server can emit are exercised, and the rejection rules that keep
non-file URLs and `..` traversal out of the request (frontend, `normalizeAttachmentPath`) are asserted
too — a fixture whose unsafe entries never reach `/api/chat/generated-file`.

## Normalized operation result

The harness prints a deterministic JSON report (abridged):

```json
{
  "operation": "generated-deliverable-fixture-verification",
  "workspace": "/home/wattman/.wattclaw/user/agent",
  "frontendModule": "src/utils/generated-attachments.ts#extractGeneratedAttachments",
  "serverModule": "server/utils/generated-file-path.js#resolveGeneratedFileCandidatePath",
  "runtimeDependencies": { "frontend": 0, "server": 0 },
  "fixtures": [
    { "fixture": "media-absolute",   "serverResolutions": [{ "candidatePath": "/home/wattman/.wattclaw/user/agent/downloads/report.pdf", "pathMode": "workspace-absolute" }] },
    { "fixture": "table-relative",   "serverResolutions": [{ "candidatePath": "/home/wattman/.wattclaw/user/agent/outputs/报告.xlsx", "pathMode": "workspace-relative" }] },
    { "fixture": "cue-root-relative","serverResolutions": [{ "candidatePath": "/home/wattman/.wattclaw/user/agent/downloads/东北旅游攻略.html", "pathMode": "workspace-root-relative" }] },
    { "fixture": "rejected-unsafe-links", "serverResolutions": [] }
  ],
  "status": "pass"
}
```

`runtimeDependencies` is not a hand-written label: the harness reads both module sources and asserts
that each has **zero runtime `import` statements** (only the erased `import type` of
`generated-attachments.ts`), which is what makes it importable by bare Node.

## Why this avoids runtime and deployment dependencies

- **No HTTP/Express boot.** `server/index.js` is a deployment-bound assembler:
  `loadEnvConfig()` (line 161) merges `process.env` with `../.env`, and `server.listen(envConfig.PORT, …)`
  (line 2240) starts Express plus the gateway, SQLite message store, cron manager, model-health monitor
  and retention jobs. Importing *that* file already fails here with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'express'`. The verification imports only the two pure
  modules, so nothing binds a port, opens a socket, or touches `data/`.
- **No database, gateway, container or filesystem state.** Both verified functions are pure string
  transforms (`resolveGeneratedFileCandidatePath` normalizes separators and classifies one of three
  path modes; `extractGeneratedAttachments` parses text). They never call `gatewayExec`, `realpath`,
  `stat`, `basename`-on-disk or the SQLite layer that the surrounding handler uses — those live in
  `server/handlers/files.js`, which the harness deliberately does not load.
- **No network.** The fixtures are inline strings; the only I/O is `readFileSync` of the two local
  module sources for the "zero runtime imports" assertion. Nothing resolves a remote host.
- **No dependency install / no build step.** The harness uses `node:assert/strict`, `node:fs` and
  `node:url` only, and Node 24's built-in TypeScript type stripping loads the `.ts` frontend module
  directly, so `npm install`, Vite/vue-tsc and Playwright are all bypassed.

## Recorded limitation (optional validation dependency unavailable)

The repository's own focused check for the server half is
`server/utils/generated-file-path.test.js`, run through the `test:server` npm script
(`vitest run …`, `package.json` lines 13 and 77). `node_modules` is **not installed** in this
environment and dependencies must not be installed, so:

- `node --test server/utils/generated-file-path.test.js` → `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'`
- `npm run test:server` → same missing `vitest` (plus, for the full suite, `express`/`better-sqlite3`)
- `import('./server/index.js')` → `ERR_MODULE_NOT_FOUND: Cannot find package 'express'`

The stdlib-only harness above is the closest available substitute: it re-implements the intent of that
fixture test (`server/utils/generated-file-path.test.js`, lines 7‑27) with `node:assert` and extends it
across the frontend/server boundary, and it passed without any optional dependency being present.
