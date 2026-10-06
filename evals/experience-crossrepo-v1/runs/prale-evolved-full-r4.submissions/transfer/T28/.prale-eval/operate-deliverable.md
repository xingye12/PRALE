# Operate deliverable — offline-safe fixture verification (WattClaw, T28)

## Chosen verification

**Target fixture (frontend ↔ server pair of the generated-file path contract):**

| Side | File | Symbol |
| --- | --- | --- |
| Server | `server/utils/generated-file-path.js` | `resolveGeneratedFileCandidatePath` |
| Server test | `server/utils/generated-file-path.test.js` | fixture expectations |
| Frontend | `src/utils/generated-attachments.ts` | `extractGeneratedAttachments` |
| Frontend test | `src/utils/generated-attachments.test.ts` | fixture expectations |

**Executable demo:** `.prale-eval/verify-fixture.mjs`

```
node .prale-eval/verify-fixture.mjs
```

It imports both fixture modules directly and asserts the checked-in expectations
(5 assertions: 3 server path-resolution cases, 2 frontend attachment-extraction
cases). It writes no repository files, opens no socket, and reads no `.env`.

Observed result:

```
PASS  server fixture: leading-slash downloads path resolves from workspace root
PASS  server fixture: ordinary relative path resolves from workspace root
PASS  server fixture: absolute path already inside workspace is preserved
PASS  frontend fixture: standalone MEDIA line becomes an absolute attachment
PASS  frontend fixture: relative markdown link is extracted and unwrapped

fixture verification: 5/5 passed (offline, node-only)
```

## Contract it normalizes

Both fixtures encode one shared contract: *a delivered file is addressed by a
workspace-relative path, and the server is the only party allowed to resolve it
to an absolute path inside the agent workspace.*

- Server side (`resolveGeneratedFileCandidatePath`, lines 1–14): normalizes the
  workspace (trailing slashes stripped), converts `\` to `/`, and classifies the
  request as `workspace-absolute`, `workspace-root-relative` (leading `/`) or
  `workspace-relative`. It is a pure function — string in, tagged object out.
- Frontend side (`extractGeneratedAttachments`, lines 93–214): recovers the same
  workspace-relative addresses from assistant output (`MEDIA:` lines, delivery
  cues, file tables, markdown links) and deduplicates them, e.g. collapsing
  `/downloads/report.pdf`, `/home/.../downloads/report.pdf` and
  `downloads/report.pdf` to a single attachment.

The verification asserts that contract by feeding the exact fixture inputs and
comparing the normalized outputs; it does not exercise any route, database or
gateway.

## Why this avoids runtime/deployment dependencies

1. **The server fixture module has zero imports.** `server/utils/generated-file-path.js`
   (lines 1–14) uses only `String.replace`/`startsWith`; there is nothing for
   Node to resolve, so the absent `node_modules` is irrelevant.
2. **The frontend fixture module is type-only + pure.** `extractGeneratedAttachments`
   (lines 93–214) imports nothing; Node 24 strips its TypeScript declarations at
   load time, so no `vite`/`vue-tsc` build is needed.
3. **The official test entrypoints are toolchain-bound.** `package.json`
   `scripts.test:server` (line 13) runs `vitest run …` and `scripts.build`
   (line 11) runs `vue-tsc -b && vite build`; both need installed dev
   dependencies, which this workspace does not have. The harness therefore
   reproduces the fixture assertions with `node:assert` instead of invoking
   vitest.
4. **The runtime entrypoint is deliberately not touched.** `server/index.js`
   builds an Express app over an HTTP server (line 352–353) and reaches
   `server.listen(envConfig.PORT, …)` (line 2240), whose startup path schedules
   retention, a model-health monitor, gateway workspace sync and the message
   store. Importing it would require `.env` values, a database, a live Gateway
   and a free port. The verification never imports `server/index.js`; it only
   uses it as the contrast case explaining why fixture-level checking is the
   narrow, dependency-free slice.
5. **Nothing outside the workspace is read or written.** The modules under test
   are in-memory transforms; the harness emits to stdout and sets an exit code.

## Scope and limitations

- `node_modules` is absent, so `npm run test:server` (vitest + `node --test`)
  could not be executed. This limitation is recorded in
  `result.json → validation.notes`.
- As a secondary syntax guard, `node --check` was run on `server/index.js` and
  `server/utils/generated-file-path.js`; this proves parseability only and is
  **not** equivalent to the full suite.
- The check is intentionally narrow: it covers the path/attachment fixture
  contract, not routing, persistence, auth or deployment wiring.
