/**
 * Executable demo: operate `server/utils/generated-file-path.js` and the
 * attachment utilities in `server/gateway-file-transfer.js` on a controlled
 * file fixture, and report the canonical path plus the rejection reason for
 * unsafe input.
 *
 * Run:  node .prale-eval/demo/generated-file-path-demo.mjs
 * (pure Node ESM; no dependencies required)
 *
 * The resolver itself is pure and performs NO rejection. The rejection policy
 * below is a faithful mirror of the guard in `server/handlers/files.js`
 * (lines 25-45 denied-name policy + lines 134-139 workspace-containment check);
 * those helpers are module-private, so they are reproduced verbatim here and
 * cited in the deliverable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveGeneratedFileCandidatePath } from '../../server/utils/generated-file-path.js'
import {
  sanitizeFilename,
  buildRemoteFileName,
  uploadToGateway,
  deleteRemoteFile,
  writeRemoteFile,
} from '../../server/gateway-file-transfer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(here, 'fixture')

// ---------------------------------------------------------------------------
// 1. Controlled fixture
// ---------------------------------------------------------------------------
fs.rmSync(fixtureRoot, { recursive: true, force: true })
const workspace = path.join(fixtureRoot, 'workspace')
fs.mkdirSync(path.join(workspace, 'downloads'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'downloads', 'report.pdf'), '%PDF-1.7 fixture\n')
fs.writeFileSync(path.join(workspace, 'notes.md'), '# notes\n')
fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1\n')
fs.writeFileSync(path.join(workspace, 'agents.md'), '# agent config\n')
// A file OUTSIDE the workspace, reachable only by escaping it.
fs.writeFileSync(path.join(fixtureRoot, 'secret.txt'), 'TOP SECRET\n')
// A symlink inside the workspace that canonicalises outside it — proves why
// `realpath` (not textual prefix matching) is the authoritative containment test.
fs.symlinkSync(path.join(fixtureRoot, 'secret.txt'), path.join(workspace, 'escape-link'))

const workspaceReal = fs.realpathSync(workspace).replace(/\\/g, '/')

// ---------------------------------------------------------------------------
// 2. Rejection policy — mirror of server/handlers/files.js
// ---------------------------------------------------------------------------
const GENERATED_FILE_DENIED_SEGMENTS = new Set(['.git', '.openclaw'])
const GENERATED_FILE_DENIED_NAMES = new Set([
  'agents.md', 'soul.md', 'user.md', 'identity.md', 'tools.md',
  'bootstrap.md', 'memory.md', 'workspace-state.json', 'openclaw-workspace-state.json',
])

function isGeneratedFilePathAllowed(relativePath) {
  const segments = relativePath.split('/').filter(Boolean).map((segment) => segment.toLowerCase())
  if (segments.some((segment) => GENERATED_FILE_DENIED_SEGMENTS.has(segment))) return false
  const name = segments[segments.length - 1] || ''
  if (name === '.env' || name.startsWith('.env.')) return false
  return !GENERATED_FILE_DENIED_NAMES.has(name)
}

// Emulates `realpath -e -- <path>` via gatewayExec: fails when the path is absent.
function realpathE(p) {
  try {
    return fs.realpathSync(p).replace(/\\/g, '/')
  } catch {
    return null
  }
}

/**
 * The full route operation, reduced to its decision: resolve the candidate,
 * canonicalise it, then apply the containment + denied-name guard.
 */
function operate(requestedPath) {
  const trimmed = typeof requestedPath === 'string' ? requestedPath.trim().replace(/\\/g, '/') : ''

  // Request validation (files.js:89) — happens before resolution.
  if (!trimmed || trimmed.includes('\0')) {
    return {
      requestedPath,
      outcome: 'rejected',
      status: 400,
      reason: 'Invalid generated file request',
      candidatePath: null,
      canonicalPath: null,
      relativePath: null,
      pathMode: null,
    }
  }

  const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(workspaceReal, trimmed)
  const canonicalPath = realpathE(candidatePath)

  if (canonicalPath === null) {
    return {
      requestedPath,
      outcome: 'rejected',
      status: 404,
      reason: 'File not found',
      candidatePath,
      canonicalPath: null,
      relativePath: null,
      pathMode,
    }
  }

  const relativePath = path.posix.relative(workspaceReal, canonicalPath)
  const escapedWorkspace =
    !relativePath || relativePath === '..' || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)

  if (escapedWorkspace) {
    return {
      requestedPath,
      outcome: 'rejected',
      status: 403,
      reason: 'File access denied (canonical path escapes workspace)',
      candidatePath,
      canonicalPath,
      relativePath,
      pathMode,
    }
  }
  if (!isGeneratedFilePathAllowed(relativePath)) {
    return {
      requestedPath,
      outcome: 'rejected',
      status: 403,
      reason: 'File access denied (denied segment or name)',
      candidatePath,
      canonicalPath,
      relativePath,
      pathMode,
    }
  }

  return {
    requestedPath,
    outcome: 'allowed',
    status: 200,
    reason: 'ok',
    candidatePath,
    canonicalPath,
    relativePath,
    pathMode,
    size: fs.statSync(canonicalPath).size,
  }
}

const cases = [
  'downloads/report.pdf',                    // workspace-relative safe
  '/downloads/report.pdf',                   // workspace-root-relative safe
  `${workspaceReal}/downloads/report.pdf`,   // workspace-absolute safe
  '../secret.txt',                           // traversal escape (posix)
  '..\\secret.txt',                          // traversal escape (windows sep)
  'escape-link',                             // symlink escape (canonicalises out)
  '.env',                                    // denied name
  'agents.md',                               // denied name
  '.git/config',                             // denied segment (not found -> 404 wins)
  'downloads/report.pdf\0',                  // NUL byte -> invalid request
  '',                                        // empty -> invalid request
]

const results = cases.map(operate)

console.log('workspaceReal =', workspaceReal)
console.log('')
for (const r of results) {
  console.log(`requestedPath=${JSON.stringify(r.requestedPath)}`)
  console.log(`  outcome=${r.outcome} status=${r.status} reason=${r.reason}`)
  console.log(`  pathMode=${r.pathMode} candidatePath=${r.candidatePath}`)
  console.log(`  canonicalPath=${r.canonicalPath} relativePath=${r.relativePath}`)
}

// ---------------------------------------------------------------------------
// 3. Attachment utilities (server/gateway-file-transfer.js)
// ---------------------------------------------------------------------------
const mediaDir = path.join(fixtureRoot, 'media', 'inbound')
const sanitized = sanitizeFilename('../../etc/pass wd?.pdf')
const built = buildRemoteFileName('report.pdf')
const uploadBuffer = Buffer.from('attachment fixture payload\n')
const upload = await uploadToGateway(uploadBuffer, 'report.pdf', {}, mediaDir)
const wroteInside = await writeRemoteFile(path.join(mediaDir, 'notes.txt'), 'hi')

// Canonicalise the upload BEFORE deleting it.
const uploadCanonicalPath = realpathE(upload.path)
const mediaDirReal = realpathE(mediaDir)
const insideMediaDir = uploadCanonicalPath !== null
  && !path.posix.relative(mediaDirReal, uploadCanonicalPath).startsWith('..')

const deletedExisting = await deleteRemoteFile(upload.path)
const deletedMissing = await deleteRemoteFile(path.join(mediaDir, 'missing.txt'))

const attachments = {
  sanitizeFilename: { input: '../../etc/pass wd?.pdf', output: sanitized },
  buildRemoteFileName: { input: 'report.pdf', output: built },
  uploadToGateway: {
    targetDir: mediaDir,
    returnedPath: upload.path,
    fileName: upload.fileName,
    originalName: upload.originalName,
    size: upload.size,
    canonicalPath: uploadCanonicalPath,
    insideMediaDir,
  },
  writeRemoteFile: { wroteInside },
  deleteRemoteFile: { deletedExisting, deletedMissing },
}
console.log('\n--- attachment utilities ---')
console.log(JSON.stringify(attachments, null, 2))

fs.writeFileSync(
  path.join(here, 'demo-output.json'),
  JSON.stringify({ workspaceReal, pathResolution: results, attachments }, null, 2) + '\n',
)
console.log('\nwrote .prale-eval/demo/demo-output.json')
