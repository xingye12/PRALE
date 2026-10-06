// Pure parsers/normalizers for the user-controlled metadata of a generated-file
// (chat attachment) download request: the `path` query value, the workspace-relative
// path computed from the resolved file, and the attachment name/extension that is
// echoed back to the client.
//
// These helpers are kept dependency-free (no express/multer/gateway/fs, only the
// stdlib `path.extname` parser) so the security-relevant parsing and normalization
// can be unit tested directly, following the precedent of ./generated-file-path.js.
// `server/handlers/files.js` only wires them into the HTTP route, it does not own
// the rules.

import { extname } from 'path'

export const GENERATED_FILE_DENIED_SEGMENTS = new Set(['.git', '.openclaw'])

export const GENERATED_FILE_DENIED_NAMES = new Set([
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

const GENERATED_FILE_MIME_TYPES = {  // extension -> MIME type
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

// Normalizes the raw `path` query value of GET /api/chat/generated-file.
// Non-string input collapses to '' so the route can answer 400, and Windows-style
// separators are folded to '/' before any path resolution happens.
export function normalizeGeneratedFileRequestPath(value) {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : ''
}

// Case-insensitive policy check over the segments of the path that is *already*
// known to live inside the agent workspace (the caller computes posix.relative).
// It rejects VCS/agent-state directories by segment and secret/agent-instruction
// files by basename, so a renamed casing cannot slip an attachment through.
export function isGeneratedFilePathAllowed(relativePath) {
  const segments = relativePath.split('/').filter(Boolean).map((segment) => segment.toLowerCase())
  if (segments.some((segment) => GENERATED_FILE_DENIED_SEGMENTS.has(segment))) return false
  const name = segments[segments.length - 1] || ''
  if (name === '.env' || name.startsWith('.env.')) return false
  return !GENERATED_FILE_DENIED_NAMES.has(name)
}

// Parses the attachment extension of the resolved real path into the MIME type
// advertised to the client. The extension is lowercased first, so `REPORT.PDF` and
// `report.pdf` agree; unknown or missing extensions stay generic.
export function generatedFileMimeType(filePath) {
  const ext = extname(filePath).slice(1).toLowerCase()
  return GENERATED_FILE_MIME_TYPES[ext] || 'application/octet-stream'
}
