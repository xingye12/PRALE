// Executable demo for the generated-file request contract implemented by
// GET /api/chat/generated-file (see server/handlers/files.js).
//
// It replays the handler's ordered decision for user-controlled `path` query values
// using the same pure helpers the handler calls, and prints the normalized result for
// every fixture. No dependencies, no server, no gateway access:
//
//   node server/utils/generated-file-metadata.demo.mjs
import { posix } from 'path'

import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'
import {
  generatedFileMimeType,
  isGeneratedFilePathAllowed,
  normalizeGeneratedFileRequestPath,
} from './generated-file-metadata.js'

const WORKSPACE = '/home/wattman/.wattclaw/user/report-agent'

const FIXTURES = [
  '/downloads/Q2\\report.pdf',
  '  attachments\\2026\\forecast.XLSX  ',
  `${WORKSPACE}/notes/summary.md`,
  '/home/wattman/.wattclaw/user/report-agent-evil/leak.txt',
  '../outside.txt',
  '.git/config',
  '/AGENTS.md',
  '/.env',
  undefined,
]

function decide(rawPath) {
  const requestedPath = normalizeGeneratedFileRequestPath(rawPath)
  if (!requestedPath || requestedPath.includes('\0')) {
    return { raw: rawPath ?? null, requestedPath, status: 400, reason: 'invalid-request' }
  }

  const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(WORKSPACE, requestedPath)
  const relativePath = posix.relative(WORKSPACE, candidatePath)
  const escapedWorkspace = !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || posix.isAbsolute(relativePath)

  if (escapedWorkspace || !isGeneratedFilePathAllowed(relativePath)) {
    return {
      raw: rawPath ?? null,
      requestedPath,
      candidatePath,
      pathMode,
      status: 403,
      reason: 'access-denied',
    }
  }

  return {
    raw: rawPath ?? null,
    requestedPath,
    candidatePath,
    pathMode,
    status: 200,
    attachment: {
      name: posix.basename(candidatePath),
      path: relativePath,
      mimeType: generatedFileMimeType(candidatePath),
    },
  }
}

console.log(`workspace: ${WORKSPACE}`)
for (const fixture of FIXTURES) {
  console.log(JSON.stringify(decide(fixture)))
}
