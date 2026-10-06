// Contract for generated-file download paths.
//
// `resolveGeneratedFileCandidatePath` (./generated-file-path.js) only turns a
// requested path into a candidate absolute path; it does not itself judge
// safety. The download handler (server/handlers/files.js) is what rejects a
// candidate that resolves outside the agent workspace, using the same
// `posix.relative(...)` containment test reproduced here.
//
// This module makes that contract executable: given a workspace root and a
// requested path it returns a normalized result that is either rejected
// (unsafe) or an accepted candidate that is guaranteed to stay inside the
// workspace root. Encoded separators / traversal tokens are rejected before
// resolution so that a downstream layer decoding the request can never
// introduce a separator or a `..` segment.

import { posix } from 'node:path'
import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'

// Tokens that only become path separators or traversal segments after a
// downstream layer URL-decodes the request.
export const ENCODED_SEPARATOR_RE = /%2e|%2f|%5c|%00/i

/**
 * Normalized operation result for a generated-file request.
 *
 * @returns {{ok: false, reason: string} | {ok: true, candidatePath: string, pathMode: string, relativePath: string}}
 */
export function normalizeGeneratedFilePath(workspaceReal, requestedPath) {
  const workspace = String(workspaceReal ?? '').replace(/\/+$/, '')
  if (!workspace) return { ok: false, reason: 'workspace-required' }

  const requested = String(requestedPath ?? '')
  if (!requested) return { ok: false, reason: 'empty-path' }
  if (requested.includes('\0')) return { ok: false, reason: 'null-byte' }
  if (ENCODED_SEPARATOR_RE.test(requested)) return { ok: false, reason: 'encoded-separator' }

  const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(workspace, requested)

  const relativePath = posix.relative(workspace, candidatePath)
  const escapesWorkspace =
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    posix.isAbsolute(relativePath)
  if (escapesWorkspace) return { ok: false, reason: 'escapes-workspace' }

  return { ok: true, candidatePath, pathMode, relativePath }
}

// Fixture workspace root used by the traversal / encoded-separator cases.
export const FIXTURE_WORKSPACE = '/home/wattman/.wattclaw/user/report-agent'

// Each case pins the contract for one input:
//   expect: 'reject' -> unsafe path must be rejected with `reason`
//   expect: 'accept' -> valid generated path must stay inside the root and
//                       resolve to `relativePath` under `pathMode`
export const GENERATED_FILE_PATH_FIXTURE_CASES = [
  // --- unsafe: plain traversal segments ---
  { name: 'parent traversal', path: '../outside.txt', expect: 'reject', reason: 'escapes-workspace' },
  { name: 'nested parent traversal', path: 'downloads/../../outside.txt', expect: 'reject', reason: 'escapes-workspace' },
  { name: 'backslash traversal', path: '..\\..\\outside.txt', expect: 'reject', reason: 'escapes-workspace' },
  { name: 'leading-slash traversal', path: '/../outside.txt', expect: 'reject', reason: 'escapes-workspace' },
  { name: 'workspace root itself is not a file', path: '/', expect: 'reject', reason: 'escapes-workspace' },

  // --- unsafe: encoded separators / traversal tokens ---
  { name: 'encoded ../ traversal', path: '%2e%2e%2foutside.txt', expect: 'reject', reason: 'encoded-separator' },
  { name: 'encoded backslash traversal', path: 'downloads%5c..%5coutside.txt', expect: 'reject', reason: 'encoded-separator' },
  { name: 'encoded slashes with traversal', path: 'reports%2f..%2f..%2fetc%2fpasswd', expect: 'reject', reason: 'encoded-separator' },
  { name: 'uppercase encoded traversal', path: '%2E%2E%2Foutside.txt', expect: 'reject', reason: 'encoded-separator' },
  { name: 'encoded null byte', path: 'reports%2fevil.pdf%00', expect: 'reject', reason: 'encoded-separator' },

  // --- unsafe: malformed requests ---
  { name: 'null byte', path: 'reports/\0evil.pdf', expect: 'reject', reason: 'null-byte' },
  { name: 'empty path', path: '', expect: 'reject', reason: 'empty-path' },

  // --- valid: generated paths that must remain inside the root ---
  { name: 'workspace-relative path', path: 'downloads/report.pdf', expect: 'accept', relativePath: 'downloads/report.pdf', pathMode: 'workspace-relative' },
  { name: 'workspace-root-relative path', path: '/downloads/report.pdf', expect: 'accept', relativePath: 'downloads/report.pdf', pathMode: 'workspace-root-relative' },
  { name: 'workspace-absolute path', path: `${FIXTURE_WORKSPACE}/downloads/report.pdf`, expect: 'accept', relativePath: 'downloads/report.pdf', pathMode: 'workspace-absolute' },
  { name: 'nested path with spaces', path: 'reports/2026 Q1/quarterly summary.pdf', expect: 'accept', relativePath: 'reports/2026 Q1/quarterly summary.pdf', pathMode: 'workspace-relative' },
  { name: 'interior dot-segment stays inside root', path: 'downloads/../downloads/report.pdf', expect: 'accept', relativePath: 'downloads/report.pdf', pathMode: 'workspace-relative' },
  { name: 'sibling-prefix absolute path is re-rooted, not escaped', path: `${FIXTURE_WORKSPACE}-evil/x.pdf`, expect: 'accept', relativePath: 'home/wattman/.wattclaw/user/report-agent-evil/x.pdf', pathMode: 'workspace-root-relative' },
]
