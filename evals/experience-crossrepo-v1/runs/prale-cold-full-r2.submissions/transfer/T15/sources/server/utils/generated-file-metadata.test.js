// Focused parser/normalizer test for the user-controlled metadata of a generated-file
// (chat attachment) download request: the `path` query value sent to
// GET /api/chat/generated-file, the workspace-relative path it is resolved to, and the
// attachment name/MIME type parsed from the resolved file.
//
// Runs with the built-in node test runner and needs no dependencies (vitest/express/
// multer/gateway are all absent from this checkout), matching the existing
// server/services/external-session-projection.test.js precedent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'path'

import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'
import {
  GENERATED_FILE_DENIED_NAMES,
  GENERATED_FILE_DENIED_SEGMENTS,
  generatedFileMimeType,
  isGeneratedFilePathAllowed,
  normalizeGeneratedFileRequestPath,
} from './generated-file-metadata.js'

// The agent workspace exactly as `realpath -e` reports it to the handler.
const WORKSPACE = '/home/wattman/.wattclaw/user/report-agent'

// Mirrors the ordered decision the /api/chat/generated-file handler makes for a single
// request: normalize the user-controlled `path`, resolve it against the workspace, run
// the workspace-containment check and the denylist check, then expose the attachment
// metadata. `posix.relative` stands in for the `realpath -e` round trip the handler
// performs on the candidate path.
function decideGeneratedFileDownload(rawPath, workspace = WORKSPACE) {
  const requestedPath = normalizeGeneratedFileRequestPath(rawPath)
  if (!requestedPath || requestedPath.includes('\0')) {
    return { requestedPath, status: 400, reason: 'invalid-request' }
  }

  const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(workspace, requestedPath)
  const relativePath = posix.relative(workspace.replace(/\/+$/, ''), candidatePath)
  const escapedWorkspace = !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || posix.isAbsolute(relativePath)

  if (escapedWorkspace || !isGeneratedFilePathAllowed(relativePath)) {
    return {
      requestedPath,
      candidatePath,
      pathMode,
      relativePath,
      status: 403,
      reason: 'access-denied',
    }
  }

  return {
    requestedPath,
    candidatePath,
    pathMode,
    relativePath,
    status: 200,
    attachment: {
      name: posix.basename(candidatePath),
      path: relativePath,
      mimeType: generatedFileMimeType(candidatePath),
    },
  }
}

test('normalizeGeneratedFileRequestPath trims and folds user-controlled separators', () => {
  const fixtures = [
    { raw: '/downloads/Q2\\report.pdf', expected: '/downloads/Q2/report.pdf' },
    { raw: '  attachments\\2026\\forecast.XLSX  ', expected: 'attachments/2026/forecast.XLSX' },
    { raw: 'downloads\\\\nested//report.pdf', expected: 'downloads//nested//report.pdf' },
    { raw: '\\\\fileserver\\share\\report.pdf', expected: '//fileserver/share/report.pdf' },
    { raw: '', expected: '' },
    { raw: '   ', expected: '' },
  ]

  for (const { raw, expected } of fixtures) {
    assert.equal(normalizeGeneratedFileRequestPath(raw), expected, `raw=${JSON.stringify(raw)}`)
  }
})

test('normalizeGeneratedFileRequestPath collapses non-string query values to empty', () => {
  for (const raw of [undefined, null, 42, true, ['a/b.pdf'], { path: 'a/b.pdf' }]) {
    assert.equal(normalizeGeneratedFileRequestPath(raw), '', `raw=${JSON.stringify(raw) ?? 'undefined'}`)
  }
})

test('normalizeGeneratedFileRequestPath keeps rejectable input rejectable', () => {
  // Null bytes survive normalization on purpose: the route still has to answer 400.
  const withNullByte = normalizeGeneratedFileRequestPath('downloads/re\0port.pdf')
  assert.equal(withNullByte, 'downloads/re\0port.pdf')
  assert.equal(withNullByte.includes('\0'), true)

  // `..` is not collapsed here either; containment is enforced after resolution.
  assert.equal(normalizeGeneratedFileRequestPath('../outside.txt'), '../outside.txt')
})

test('resolves normalized request paths into the workspace with a stable path mode', () => {
  const fixtures = [
    {
      raw: '/downloads/Q2/report.pdf',
      candidatePath: `${WORKSPACE}/downloads/Q2/report.pdf`,
      pathMode: 'workspace-root-relative',
    },
    {
      raw: '  attachments\\2026\\forecast.XLSX  ',
      candidatePath: `${WORKSPACE}/attachments/2026/forecast.XLSX`,
      pathMode: 'workspace-relative',
    },
    {
      raw: `${WORKSPACE}/notes/summary.md`,
      candidatePath: `${WORKSPACE}/notes/summary.md`,
      pathMode: 'workspace-absolute',
    },
    {
      raw: '//fileserver/share/report.pdf',
      candidatePath: `${WORKSPACE}/fileserver/share/report.pdf`,
      pathMode: 'workspace-root-relative',
    },
  ]

  for (const { raw, candidatePath, pathMode } of fixtures) {
    const normalized = normalizeGeneratedFileRequestPath(raw)
    assert.deepEqual(
      resolveGeneratedFileCandidatePath(WORKSPACE, normalized),
      { candidatePath, pathMode },
      `raw=${JSON.stringify(raw)}`,
    )
  }
})

test('a workspace with a trailing slash still yields workspace-absolute paths', () => {
  const requested = `${WORKSPACE}/downloads/report.pdf`
  assert.deepEqual(
    resolveGeneratedFileCandidatePath(`${WORKSPACE}///`, requested),
    { candidatePath: requested, pathMode: 'workspace-absolute' },
  )
})

test('look-alike sibling workspace paths are re-anchored, never treated as absolute', () => {
  const raw = '/home/wattman/.wattclaw/user/report-agent-evil/leak.txt'
  const resolved = resolveGeneratedFileCandidatePath(WORKSPACE, normalizeGeneratedFileRequestPath(raw))

  assert.equal(resolved.pathMode, 'workspace-root-relative')
  assert.equal(
    resolved.candidatePath,
    `${WORKSPACE}/home/wattman/.wattclaw/user/report-agent-evil/leak.txt`,
  )
  assert.equal(resolved.candidatePath.startsWith(`${WORKSPACE}/`), true)
})

test('denylist segments and names are the case-insensitive contract constants', () => {
  assert.deepEqual([...GENERATED_FILE_DENIED_SEGMENTS].sort(), ['.git', '.openclaw'])
  assert.equal(GENERATED_FILE_DENIED_NAMES.has('agents.md'), true)
  assert.equal(GENERATED_FILE_DENIED_NAMES.has('workspace-state.json'), true)
  assert.equal(GENERATED_FILE_DENIED_NAMES.has('openclaw-workspace-state.json'), true)
})

test('isGeneratedFilePathAllowed accepts ordinary attachments', () => {
  for (const relativePath of [
    'downloads/Q2/report.pdf',
    'downloads/report.PDF',
    'sub/dir/notes.txt',
    'agents.md.bak',
    '.envrc',
    'reports/.gitignore-notes.md',
  ]) {
    assert.equal(isGeneratedFilePathAllowed(relativePath), true, relativePath)
  }
})

test('isGeneratedFilePathAllowed rejects VCS/state dirs and secret or agent-instruction files', () => {
  const denied = [
    '.git/config',
    'downloads/.git/config',
    '.GIT/HEAD',
    '.openclaw/state.json',
    'downloads/.OpenClaw/workspace-state.json',
    '.env',
    '.Env',
    'downloads/.env.local',
    'sub/.env.production',
    'AGENTS.md',
    'agents.md',
    'soul.MD',
    'memory.md',
    'tools.md',
    'identity.md',
    'user.md',
    'bootstrap.md',
    'downloads/Workspace-State.JSON',
    'openclaw-workspace-state.json',
  ]

  for (const relativePath of denied) {
    assert.equal(isGeneratedFilePathAllowed(relativePath), false, relativePath)
  }
})

test('the denylist is a policy check, not the traversal boundary', () => {
  // A plain traversal escapes the workspace through the `../` containment check in the
  // handler, which runs before/independently of the denylist.
  const traversal = '..\\outside.txt'
  const normalizedTraversal = normalizeGeneratedFileRequestPath(traversal)
  assert.equal(normalizedTraversal, '../outside.txt')
  assert.equal(isGeneratedFilePathAllowed(normalizedTraversal), true)
  assert.equal(decideGeneratedFileDownload(traversal).status, 403)

  // A traversal that lands on a denied directory is caught by the denylist too.
  assert.equal(isGeneratedFilePathAllowed('../.git/config'), false)
  assert.equal(isGeneratedFilePathAllowed('../.openclaw/workspace-state.json'), false)
})

test('generatedFileMimeType parses the resolved attachment extension', () => {
  const fixtures = [
    ['report.pdf', 'application/pdf'],
    ['report.PDF', 'application/pdf'],
    ['forecast.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['deck.PPTX', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['notes.csv', 'text/csv'],
    ['summary.md', 'text/markdown'],
    ['data.json', 'application/json'],
    ['photo.JPEG', 'image/jpeg'],
    ['clip.webp', 'image/webp'],
    ['icon.svg', 'image/svg+xml'],
    ['bundle.zip', 'application/zip'],
    ['README', 'application/octet-stream'],
    ['archive.7z', 'application/octet-stream'],
  ]

  for (const [filePath, mimeType] of fixtures) {
    assert.equal(generatedFileMimeType(`${WORKSPACE}/downloads/${filePath}`), mimeType, filePath)
  }
})

test('composes normalization, containment and metadata for user-controlled fixtures', () => {
  const fixtures = [
    {
      raw: '/downloads/Q2\\report.pdf',
      expected: {
        status: 200,
        relativePath: 'downloads/Q2/report.pdf',
        attachment: {
          name: 'report.pdf',
          path: 'downloads/Q2/report.pdf',
          mimeType: 'application/pdf',
        },
      },
    },
    {
      raw: '  attachments\\2026\\forecast.XLSX  ',
      expected: {
        status: 200,
        relativePath: 'attachments/2026/forecast.XLSX',
        attachment: {
          name: 'forecast.XLSX',
          path: 'attachments/2026/forecast.XLSX',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      },
    },
    { raw: '../outside.txt', expected: { status: 403, relativePath: '../outside.txt' } },
    { raw: '../../etc/passwd', expected: { status: 403, relativePath: '../../etc/passwd' } },
    { raw: '.git/config', expected: { status: 403, relativePath: '.git/config' } },
    { raw: '/AGENTS.md', expected: { status: 403, relativePath: 'AGENTS.md' } },
    { raw: '/.env', expected: { status: 403, relativePath: '.env' } },
    { raw: undefined, expected: { status: 400 } },
    { raw: 'downloads/re\0port.pdf', expected: { status: 400 } },
  ]

  for (const { raw, expected } of fixtures) {
    const result = decideGeneratedFileDownload(raw)
    assert.equal(result.status, expected.status, `raw=${JSON.stringify(raw) ?? 'undefined'}`)
    if (expected.relativePath !== undefined) {
      assert.equal(result.relativePath, expected.relativePath, `raw=${JSON.stringify(raw) ?? 'undefined'}`)
    }
    if (expected.attachment !== undefined) {
      assert.deepEqual(result.attachment, expected.attachment, `raw=${JSON.stringify(raw)}`)
    }
  }
})

test('an empty attachment path can never be normalized into the workspace root', () => {
  assert.equal(decideGeneratedFileDownload('   ').status, 400)
  assert.equal(normalizeGeneratedFileRequestPath('   '), '')
  // Only a whitespace-free empty string was previously rejected, so make sure the
  // normalized value - not the raw value - is what the handler validates.
  assert.equal(decideGeneratedFileDownload(undefined).candidatePath, undefined)
})
