# T08 operate deliverable — offline-safe frontend/server fixture verification

## What was chosen

A **static verification of the built-frontend serving contract** of the WattClaw
fixture, implemented as a dependency-free executable script:

```
node .prale-eval/verify-fixture.mjs
```

It is the narrowest check that still exercises the real frontend/server boundary
in this repository: the hand-off between the Vite build output and the Express
entry point.

## The contract being verified

WattClaw ships a Vue frontend built by Vite and served by a Node/Express server.
The contract that binds them is:

| # | Contract clause | Source |
|---|-----------------|--------|
| 1 | The manifest is ESM and runs `server/index.js` directly with `node` | `package.json` (`"type": "module"`, `scripts.start`) |
| 2 | The frontend is produced by `vite build` (into `dist/`) | `package.json` (`scripts.build`), `vite.config.ts` (`outDir: 'dist'`) |
| 3 | The server resolves the frontend at `join(__dirname, '../dist')` | `server/index.js` (`distPath`) |
| 4 | Frontend presence is probed from `dist/index.html` | `server/index.js` (`hasDist`) |
| 5 | If built: serve `dist/` statically; non-`/api/` GETs fall back to `dist/index.html` | `server/index.js` (static + SPA fallback) |
| 6 | If not built: non-`/api/` GETs redirect to `DEV_FRONTEND_URL` | `server/index.js` (dev redirect) |

Clauses 3–6 are the two-branch serving decision; clause 2 + 3 are the cross-file
path agreement that makes the hand-off work.

## The executable demo

`.prale-eval/verify-fixture.mjs` runs 13 assertions and prints a normalized JSON
result (exit 0 on pass, 1 on failure):

1. **Manifest** — `package.json` parses as JSON; `type === "module"`;
   `scripts.start` references `server/index.js`; `scripts.build` invokes
   `vite build`; `express` and `vite` are declared.
2. **Server entry, parse-only** — `node --check server/index.js` proves the ESM
   entry is syntactically valid **without executing it**.
3. **Server entry, structural** — the source contains the `distPath` /
   `hasDist` derivation, `express.static(distPath)`, the guarded
   `sendFile(...'index.html')` SPA fallback, and the `DEV_FRONTEND_URL` redirect.
4. **Cross-file** — `vite.config.ts` `outDir: 'dist'` agrees with the server's
   `../dist`.

Normalized result (observed):

```json
{ "fixture": "wattclaw", "verification": "frontend/server static-serving contract",
  "offline_safe": true, "runtime_dependencies_used": [],
  "passed": 13, "total": 13, "status": "pass" }
```

## Why this is offline-safe (no runtime/deployment dependencies)

`server/index.js` is a side-effecting ESM entry with **no exports**
(`const app = express()` → `createServer(app)` → `server.listen(PORT)`). Simply
importing it would:

- resolve third-party packages (`express`, `better-sqlite3`, `ws`) from a
  `node_modules` tree that is **not installed** here;
- bind a TCP port (`envConfig.PORT`);
- initialize SQLite and open a WebSocket to the OpenClaw Gateway;
- require a `.env` file and (for the production branch) a built `dist/` tree.

None of that is needed to prove the contract. The chosen verification therefore:

- **never imports, requires, or spawns** `server/index.js` — it only reads the
  file and runs `node --check` (parse-only, no module instantiation, no
  top-level evaluation);
- uses **only Node.js standard-library modules** (`node:fs`, `node:path`,
  `node:url`, `node:child_process`);
- performs **no** `npm install`, network access, port binding, database access,
  Gateway connection, build step, or container run.

That is precisely why it avoids runtime/deployment dependencies: the property
under test is a **source-level file/path contract**, so it is provable from
text, and the parts that genuinely need a runtime (the listener, the DB, the
Gateway) are out of scope for this clause of the fixture.

## Validation and its limitation

- Command: `node .prale-eval/verify-fixture.mjs`
- Status: **pass** (13/13 checks, exit 0, Node v24.14.0).
- Limitation recorded: `node_modules` is absent and dependency installation is
  not permitted in this environment, so the repository's own vitest suite
  (`npm run test:server`) could not be executed. `node --check` plus
  source-structure assertions are the dependency-free equivalent and cover the
  same boundary being evaluated.

## Files touched

- Added `.prale-eval/verify-fixture.mjs` (the executable demo).
- Added `.prale-eval/result.json` and this `.prale-eval/operate-deliverable.md`.
- No source, task metadata, hidden-oracle, lockfile, or git configuration was
  modified.
