#!/usr/bin/env node
// Narrow, offline-safe verification of the WattClaw frontend/server fixture.
//
// It verifies the *static serving contract* that ties the Vite build output to
// the Express entry point, using ONLY the Node.js standard library:
//   - parse-only syntax validation of server/index.js (`node --check`, no execution)
//   - structural assertions over the source text and package.json
//
// It deliberately never imports, requires, or spawns server/index.js. Running
// that module would pull in express / better-sqlite3, bind PORT 3001, open a
// WebSocket to the OpenClaw Gateway and initialize SQLite. None of that is
// needed to prove the fixture's contract, so none of it is touched here.
//
// Exit code 0 = all checks pass; 1 = at least one check failed.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const notes = []

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

const checks = []
function check(id, description, ok, detail) {
  checks.push({ id, description, ok: Boolean(ok), detail })
  if (!ok) notes.push(`FAIL ${id}: ${description}`)
}

// ── A. Fixture manifest: package.json ──────────────────────────────────────
let pkg = null
let pkgRaw = ''
try {
  pkgRaw = read('package.json')
  pkg = JSON.parse(pkgRaw)
  check('pkg.valid-json', 'package.json is valid JSON', true, 'parsed')
} catch (err) {
  check('pkg.valid-json', 'package.json is valid JSON', false, String(err.message))
}

if (pkg) {
  const scripts = pkg.scripts || {}
  const deps = pkg.dependencies || {}
  const devDeps = pkg.devDependencies || {}

  check(
    'pkg.esm',
    'package.json declares ESM ("type": "module") so server/index.js is a Node ESM module',
    pkg.type === 'module',
    `type=${pkg.type}`,
  )
  check(
    'pkg.server-entry',
    'scripts.start runs the server entry directly via node (no bundling step)',
    typeof scripts.start === 'string' && scripts.start.includes('server/index.js'),
    `start=${scripts.start}`,
  )
  check(
    'pkg.build-produces-dist',
    'scripts.build invokes vite build, which emits the dist/ tree server/index.js serves',
    typeof scripts.build === 'string' && scripts.build.includes('vite build'),
    `build=${scripts.build}`,
  )
  check(
    'pkg.express-dep',
    'express is a declared runtime dependency of the server entry',
    Boolean(deps.express),
    `express=${deps.express}`,
  )
  check(
    'pkg.vite-devdep',
    'vite is a declared dev dependency that owns the frontend build',
    Boolean(devDeps.vite),
    `vite=${devDeps.vite}`,
  )
}

// ── B. Fixture server entry: server/index.js (static, never executed) ──────
const serverSrc = read('server/index.js')

// B.1 parse-only syntax validation — creates no module instance, runs no top level code.
let syntaxOk = true
let syntaxDetail = 'node --check passed (ESM parses)'
try {
  execFileSync(process.execPath, ['--check', join(root, 'server/index.js')], {
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
} catch (err) {
  syntaxOk = false
  syntaxDetail = String(err.stderr || err.message).slice(0, 300)
}
check('server.parseable', 'server/index.js parses as ESM without executing it', syntaxOk, syntaxDetail)

// B.2 the frontend/server path contract.
check(
  'server.dist-path',
  "server/index.js resolves the frontend build to join(__dirname, '../dist')",
  /const distPath = join\(__dirname, '\.\.\/dist'\)/.test(serverSrc),
  'distPath declaration present',
)
check(
  'server.has-dist-probe',
  "presence of the frontend is probed from dist/index.html (hasDist)",
  /const hasDist = existsSync\(join\(distPath, 'index\.html'\)\)/.test(serverSrc),
  'hasDist probe present',
)
check(
  'server.static-dist',
  'when built, Express serves dist/ statically',
  /express\.static\(distPath\)/.test(serverSrc),
  'express.static(distPath) present',
)
check(
  'server.spa-fallback',
  'when built, non-/api GETs fall back to dist/index.html (SPA routing)',
  /res\.sendFile\(join\(distPath, 'index\.html'\)\)/.test(serverSrc) &&
    /!req\.path\.startsWith\('\/api\/'\)/.test(serverSrc),
  'SPA fallback + /api guard present',
)
check(
  'server.dev-redirect',
  'when not built, non-/api GETs redirect to the dev frontend instead of 404',
  /res\.redirect\(envConfig\.DEV_FRONTEND_URL \+ req\.originalUrl\)/.test(serverSrc),
  'DEV_FRONTEND_URL redirect present',
)

// B.3 cross-file: Vite must emit to the same directory the server serves.
const viteSrc = read('vite.config.ts')
check(
  'vite.outdir-matches-dist',
  "vite.config.ts outDir 'dist' matches the server's distPath (shared path contract)",
  /outDir:\s*'dist'/.test(viteSrc) && /const distPath = join\(__dirname, '\.\.\/dist'\)/.test(serverSrc),
  "outDir 'dist' versus ../dist",
)

const failed = checks.filter((c) => !c.ok)
const result = {
  fixture: 'wattclaw',
  verification: 'frontend/server static-serving contract',
  offline_safe: true,
  runtime_dependencies_used: [],
  checks,
  passed: checks.length - failed.length,
  total: checks.length,
  status: failed.length === 0 ? 'pass' : 'fail',
}
console.log(JSON.stringify(result, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
