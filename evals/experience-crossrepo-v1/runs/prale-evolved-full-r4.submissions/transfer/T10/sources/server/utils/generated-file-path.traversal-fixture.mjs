#!/usr/bin/env node
/**
 * Traversal / encoded-separator contract fixture for
 * `resolveGeneratedFileCandidatePath` (server/utils/generated-file-path.js).
 *
 * Executable with the Node.js standard library only - no vitest, no
 * node_modules, no network:
 *
 *   node server/utils/generated-file-path.traversal-fixture.mjs
 *
 * It pins the two halves of the generated-file download contract:
 *
 *   1. RESOLUTION. `resolveGeneratedFileCandidatePath` is a pure normalizer:
 *      it strips trailing slashes from the workspace, rewrites backslash
 *      ("encoded") separators to `/`, keeps requests that already start with
 *      the workspace root as `workspace-absolute`, and otherwise joins the
 *      request onto the workspace root. It never rejects, clamps or resolves
 *      `..` segments, so its output alone is NOT a containment decision.
 *
 *   2. CONTAINMENT. The caller decides exactly as
 *      server/handlers/files.js does: realpath the candidate, then reject when
 *      `path.posix.relative(workspaceReal, targetReal)` is empty, `..`, starts
 *      with `../` or is absolute. Unsafe requests (literal traversal,
 *      backslash-encoded traversal, percent-encoded traversal decoded by
 *      Express, symlink escapes, missing targets) are rejected; valid generated
 *      paths must realpath to a target strictly inside the workspace root.
 *
 * Exit code 0 = every contract case held; non-zero = a case failed.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path, { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

// Build a throw-away tree inside the repository (git-ignored `.tmp/`) so the
// fixture exercises realpath on a real filesystem without touching anything
// outside the workspace.
const tmpRoot = path.join(repoRoot, '.tmp', 'generated-file-path-traversal-fixture')
// The agent root is nested two levels under tmpRoot so that `../..` traversals
// can reach a real sibling file that lives outside the root.
const workspaceDir = path.join(tmpRoot, 'workspace', 'agent-root')
const outsideDir = path.join(tmpRoot, 'outside')

rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(path.join(workspaceDir, 'downloads'), { recursive: true })
mkdirSync(outsideDir, { recursive: true })
writeFileSync(path.join(workspaceDir, 'downloads', 'report.pdf'), 'report')
writeFileSync(path.join(workspaceDir, '.env'), 'SECRET=1')
writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')
// A symlink that is lexically inside the workspace but really lands outside it.
symlinkSync(path.join('..', '..', 'outside'), path.join(workspaceDir, 'escape-link'), 'dir')

const workspaceReal = realpathSync(workspaceDir)

// --- mirrors of the caller gates in server/handlers/files.js ----------------

// request-shape gate (files.js:89) - null byte / empty request.
function passesRequestShapeGate(sessionKey, agentId, requestedPath) {
  return Boolean(sessionKey && agentId && requestedPath && !requestedPath.includes('\0'))
}

// name gate (files.js:29-44) - `.env`, `.env.*`, `.git`/`.openclaw` segments, dotfiles.
const DENIED_SEGMENTS = new Set(['.git', '.openclaw'])
const DENIED_NAMES = new Set([
  'agents.md',
  'soul.md',
  'user.md',
  'identity.md',
  'tools.md',
  'bootstrap.md',
  'memory.md',
  'workspace-state.json',
  'openclaw-workspace-state.json',
])
function isGeneratedFilePathAllowed(relativePath) {
  const segments = relativePath.split('/').filter(Boolean).map((segment) => segment.toLowerCase())
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return false
  const name = segments[segments.length - 1] || ''
  if (name === '.env' || name.startsWith('.env.')) return false
  return !DENIED_NAMES.has(name)
}

// containment gate (files.js:122-138) - realpath + posix.relative.
function realpathOrNull(candidatePath) {
  try {
    return realpathSync(candidatePath)
  } catch {
    return null
  }
}

function decide(requestedPath) {
  const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(workspaceReal, requestedPath)
  const targetReal = realpathOrNull(candidatePath)
  if (targetReal === null) {
    return { decision: 'rejected:not-found', candidatePath, pathMode, relativePath: null }
  }
  const relativePath = posix.relative(workspaceReal, targetReal)
  const escapedWorkspace = !relativePath || relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)
  if (escapedWorkspace) {
    return { decision: 'rejected:escape', candidatePath, pathMode, relativePath }
  }
  if (!isGeneratedFilePathAllowed(relativePath)) {
    return { decision: 'rejected:denied-name', candidatePath, pathMode, relativePath }
  }
  return { decision: 'accepted', candidatePath, pathMode, relativePath }
}

// --- contract cases --------------------------------------------------------

// name, request, expected decision
const UNSAFE_CASES = [
  ['literal parent traversal', '../../outside/secret.txt', 'rejected:escape'],
  ['backslash-encoded traversal', '..\\..\\outside\\secret.txt', 'rejected:escape'],
  ['root-relative (leading slash) traversal', '/../../outside/secret.txt', 'rejected:escape'],
  ['nested traversal after a valid prefix', 'downloads/../../../outside/secret.txt', 'rejected:escape'],
  ['root-relative nested traversal', '/downloads/../../../outside/secret.txt', 'rejected:escape'],
  ['percent-encoded traversal after Express decoding', decodeURIComponent('..%2F..%2Foutside%2Fsecret.txt'), 'rejected:escape'],
  ['symlink that leaves the root lexically', 'escape-link/secret.txt', 'rejected:escape'],
  ['absolute path that names a target outside the root', path.join(outsideDir, 'secret.txt'), 'rejected:not-found'],
  ['nonexistent relative target', 'downloads/missing.pdf', 'rejected:not-found'],
  ['denied dotfile name', 'downloads/../.env', 'rejected:denied-name'],
]

// name, request, expected pathMode, expected relativePath
const VALID_CASES = [
  ['workspace-relative generated path', 'downloads/report.pdf', 'workspace-relative', 'downloads/report.pdf'],
  ['backslash-encoded valid path', 'downloads\\report.pdf', 'workspace-relative', 'downloads/report.pdf'],
  ['workspace-root-relative generated path', '/downloads/report.pdf', 'workspace-root-relative', 'downloads/report.pdf'],
  ['workspace-absolute generated path', path.join(workspaceReal, 'downloads', 'report.pdf'), 'workspace-absolute', 'downloads/report.pdf'],
  ['dot segment that stays inside', './downloads/report.pdf', 'workspace-relative', 'downloads/report.pdf'],
  ['absolute dot-dot that normalizes back inside', `${workspaceReal}/downloads/../downloads/report.pdf`, 'workspace-absolute', 'downloads/report.pdf'],
]

const lines = []
let passed = 0
let total = 0

function check(label, condition, detail) {
  total += 1
  if (condition) passed += 1
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
  assert.ok(condition, `${label} -> ${detail}`)
}

try {
  lines.push(`workspaceReal = ${workspaceReal}`)
  lines.push('')
  lines.push('unsafe requests (must be rejected):')
  for (const [label, request, expected] of UNSAFE_CASES) {
    const result = decide(request)
    check(
      `reject: ${label}`,
      result.decision === expected,
      `request=${JSON.stringify(request)} decision=${result.decision} (expected ${expected}) candidate=${result.candidatePath}`,
    )
  }

  lines.push('')
  lines.push('valid generated paths (must stay strictly inside the root):')
  for (const [label, request, expectedMode, expectedRelative] of VALID_CASES) {
    const result = decide(request)
    const strictlyInside = result.decision === 'accepted'
      && result.relativePath === expectedRelative
      && realpathOrNull(result.candidatePath).startsWith(`${workspaceReal}${path.sep}`)
    check(
      `accept: ${label}`,
      result.decision === 'accepted' && result.pathMode === expectedMode && strictlyInside,
      `request=${JSON.stringify(request)} decision=${result.decision} pathMode=${result.pathMode} relative=${result.relativePath} candidate=${result.candidatePath}`,
    )
  }

  lines.push('')
  lines.push('resolver normalization properties:')
  const traversalInside = resolveGeneratedFileCandidatePath(workspaceReal, '../../outside/secret.txt')
  check(
    'resolver does not reject or clamp traversal (it is a normalizer, the caller contains)',
    traversalInside.candidatePath === `${workspaceReal}/../../outside/secret.txt` && traversalInside.pathMode === 'workspace-relative',
    `candidate=${traversalInside.candidatePath} pathMode=${traversalInside.pathMode}`,
  )
  const encoded = resolveGeneratedFileCandidatePath(workspaceReal, 'downloads\\report.pdf')
  check(
    'encoded separators are rewritten to "/" before classification',
    encoded.candidatePath === `${workspaceReal}/downloads/report.pdf` && encoded.pathMode === 'workspace-relative',
    `candidate=${encoded.candidatePath} pathMode=${encoded.pathMode}`,
  )
  const trailingSlash = resolveGeneratedFileCandidatePath(`${workspaceReal}/`, 'downloads/report.pdf')
  check(
    'trailing slashes on the workspace root are stripped',
    trailingSlash.candidatePath === `${workspaceReal}/downloads/report.pdf`,
    `candidate=${trailingSlash.candidatePath}`,
  )

  lines.push('')
  lines.push('request-shape gate:')
  check('null byte in the request is rejected before resolution', !passesRequestShapeGate('agent:a:main', 'a', 'downloads/report.pdf\u0000.txt'), 'path with NUL char -> invalid request')
  check('null byte free request passes the shape gate', passesRequestShapeGate('agent:a:main', 'a', 'downloads/report.pdf'), 'valid request shape')

  console.log(lines.join('\n'))
  console.log(`\nCONTRACT FIXTURE PASSED: ${passed}/${total} checks`)
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
  assert.ok(!existsSync(tmpRoot), 'fixture scratch tree was cleaned up')
}
