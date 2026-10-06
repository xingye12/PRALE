// Traversal / encoded-separator contract fixture for generated-file downloads.
//
// Contract under test (GET /api/chat/generated-file?path=<value>):
//   1. Express percent-decodes the query value exactly once (server/handlers/files.js:74-75),
//      then the route trims it and normalizes "\" to "/" (files.js:75).
//   2. resolveGeneratedFileCandidatePath() maps the request onto a candidate path
//      (server/utils/generated-file-path.js:1-15). Its output is a *candidate*, not a verdict:
//      a traversal request yields a candidate that still escapes the workspace root.
//   3. The route canonicalizes the candidate with `realpath -e` (files.js:122-132) and derives
//      posix.relative(workspaceReal, targetReal) (files.js:134).
//   4. Escape / deny predicate (files.js:39-45, 135-139): empty relative path, "..", "../*" or an
//      absolute relative path -> 403; denied segments (.git, .openclaw) or denied names
//      (agent memory/env files) -> 403.
//
// `server/handlers/files.js` cannot be imported here (it pulls in express/multer/pty), so this
// fixture imports the real resolver from './generated-file-path.js' and restates the escape/deny
// predicates verbatim, with source citations, so the contract is executable with only
// `node --test` and zero installed dependencies.
//
// Executable: node --test server/utils/generated-file-path.traversal.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'

// ---------------------------------------------------------------------------
// Mirrors of the route predicates (server/handlers/files.js)
// ---------------------------------------------------------------------------

// files.js:26-27
const GENERATED_FILE_DENIED_SEGMENTS = new Set(['.git', '.openclaw'])
// files.js:28-37
const GENERATED_FILE_DENIED_NAMES = new Set([
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

// files.js:39-45
function isGeneratedFilePathAllowed(relativePath) {
  const segments = relativePath.split('/').filter(Boolean).map((segment) => segment.toLowerCase())
  if (segments.some((segment) => GENERATED_FILE_DENIED_SEGMENTS.has(segment))) return false
  const name = segments[segments.length - 1] || ''
  if (name === '.env' || name.startsWith('.env.')) return false
  return !GENERATED_FILE_DENIED_NAMES.has(name)
}

// files.js:134-135 — the workspace containment predicate.
function containmentDecision(workspaceReal, targetReal) {
  const workspace = workspaceReal.replace(/\/+$/, '')
  const relativePath = posix.relative(workspace, targetReal)
  const escaped = !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || posix.isAbsolute(relativePath)
  return { relativePath, escaped }
}

/**
 * Normalized operation result for one generated-file request.
 *
 * `canonicalize` stands in for `realpath -e` (files.js:122-132): the default models an existing,
 * non-symlinked target; tests pass an override to model a symlink that leaves the workspace.
 */
export function evaluateGeneratedFileRequest(workspaceReal, wirePath, { canonicalize } = {}) {
  const workspace = workspaceReal.replace(/\/+$/, '')
  const resolveTarget = canonicalize || ((candidate) => posix.normalize(candidate))
  const outcome = {
    wirePath,
    workspaceReal: workspace,
    decision: 'deny',
    status: 403,
    reason: null,
    pathMode: null,
    candidatePath: null,
    candidateRelativePath: null,
    targetReal: null,
    relativePath: null,
  }

  let decoded
  try {
    decoded = decodeURIComponent(wirePath)
  } catch {
    return { ...outcome, status: 400, reason: 'invalid-percent-encoding' }
  }

  // files.js:75
  const requestedPath = decoded.trim().replace(/\\/g, '/')

  // files.js:89
  if (!requestedPath || requestedPath.includes('\0')) {
    return { ...outcome, status: 400, reason: 'invalid-request' }
  }

  // files.js:112
  const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(workspace, requestedPath)
  const candidateRelativePath = posix.relative(workspace, posix.normalize(candidatePath))
  const targetReal = resolveTarget(candidatePath)
  const { relativePath, escaped } = containmentDecision(workspace, targetReal)

  Object.assign(outcome, { pathMode, candidatePath, candidateRelativePath, targetReal, relativePath })

  if (escaped) return { ...outcome, reason: 'escaped-workspace' }
  if (!isGeneratedFilePathAllowed(relativePath)) return { ...outcome, reason: 'denied-path' }
  return { ...outcome, decision: 'allow', status: 200, reason: 'inside-workspace' }
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const WORKSPACE = '/home/wattman/.wattclaw/user/report-agent'

const VALID_PATH_CASES = [
  {
    name: 'plain workspace-relative path',
    wirePath: 'downloads/report.pdf',
    pathMode: 'workspace-relative',
    resolved: `${WORKSPACE}/downloads/report.pdf`,
    relativePath: 'downloads/report.pdf',
  },
  {
    name: 'root-relative path anchored at the workspace root',
    wirePath: '/downloads/report.pdf',
    pathMode: 'workspace-root-relative',
    resolved: `${WORKSPACE}/downloads/report.pdf`,
    relativePath: 'downloads/report.pdf',
  },
  {
    name: 'absolute path already inside the workspace',
    wirePath: `${WORKSPACE}/downloads/report.pdf`,
    pathMode: 'workspace-absolute',
    resolved: `${WORKSPACE}/downloads/report.pdf`,
    relativePath: 'downloads/report.pdf',
  },
  {
    name: 'Windows-style backslash separators are normalized inside the root',
    wirePath: 'reports\\2026\\q1.pdf',
    pathMode: 'workspace-relative',
    resolved: `${WORKSPACE}/reports/2026/q1.pdf`,
    relativePath: 'reports/2026/q1.pdf',
  },
  {
    name: 'interior traversal that stays inside the root is canonicalized away',
    wirePath: './downloads/../downloads/report.pdf',
    pathMode: 'workspace-relative',
    resolved: `${WORKSPACE}/downloads/report.pdf`,
    relativePath: 'downloads/report.pdf',
  },
  {
    name: 'percent-encoded dot segment inside the root',
    wirePath: '%2e/downloads/report.pdf',
    pathMode: 'workspace-relative',
    resolved: `${WORKSPACE}/downloads/report.pdf`,
    relativePath: 'downloads/report.pdf',
  },
  {
    name: 'double-encoded separators stay a literal in-root file name (single decode only)',
    wirePath: '%252e%252e%252fsecret.txt',
    pathMode: 'workspace-relative',
    resolved: `${WORKSPACE}/%2e%2e%2fsecret.txt`,
    relativePath: '%2e%2e%2fsecret.txt',
  },
  {
    name: 'sibling directory sharing the root prefix does not escape the root',
    wirePath: '/home/wattman/.wattclaw/user/report-agent-v2/notes.txt',
    pathMode: 'workspace-root-relative',
    resolved: `${WORKSPACE}/home/wattman/.wattclaw/user/report-agent-v2/notes.txt`,
    relativePath: 'home/wattman/.wattclaw/user/report-agent-v2/notes.txt',
  },
]

const UNSAFE_PATH_CASES = [
  {
    name: 'relative traversal via ..',
    wirePath: '../secret.txt',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'root-relative traversal via /..',
    wirePath: '/../etc/passwd',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'encoded traversal %2e%2e%2f',
    wirePath: '%2e%2e%2fsecret.txt',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'encoded separators with literal dots (..%2f..%2f)',
    wirePath: '..%2f..%2fetc%2fpasswd',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'fully encoded traversal %2e%2e%2f%2e%2e%2f',
    wirePath: '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'percent-encoded backslash traversal %5c',
    wirePath: '..%5c..%5csecret.txt',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'backslash traversal that the resolver normalizes into ../',
    wirePath: '..\\..\\etc\\passwd',
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'workspace-absolute prefix is not an allow signal',
    wirePath: `${WORKSPACE}/../../outside.txt`,
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'traversal from an absolute path with a duplicated root prefix',
    wirePath: `${WORKSPACE}/../${WORKSPACE.slice(1)}/../../outside.txt`,
    status: 403,
    reason: 'escaped-workspace',
  },
  {
    name: 'NUL byte injection is rejected before resolution',
    wirePath: 'downloads/report.pdf%00/../../etc/passwd',
    status: 400,
    reason: 'invalid-request',
  },
  {
    name: 'denied metadata segment .git',
    wirePath: '.git/config',
    status: 403,
    reason: 'denied-path',
  },
  {
    name: 'denied metadata segment .openclaw',
    wirePath: '.openclaw/workspace-state.json',
    status: 403,
    reason: 'denied-path',
  },
  {
    name: 'denied agent memory file memory.md',
    wirePath: 'notes/memory.md',
    status: 403,
    reason: 'denied-path',
  },
  {
    name: 'denied env file .env.local',
    wirePath: '.env.local',
    status: 403,
    reason: 'denied-path',
  },
  {
    name: 'denied name is matched case-insensitively',
    wirePath: 'Notes/MEMORY.MD',
    status: 403,
    reason: 'denied-path',
  },
  {
    name: 'the workspace root itself is not a downloadable file',
    wirePath: '.',
    status: 403,
    reason: 'escaped-workspace',
  },
]

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

test('valid generated paths resolve inside the intended root', async (t) => {
  for (const item of VALID_PATH_CASES) {
    await t.test(item.name, () => {
      const result = evaluateGeneratedFileRequest(WORKSPACE, item.wirePath)

      assert.equal(result.decision, 'allow', `${item.wirePath} must be allowed`)
      assert.equal(result.status, 200)
      assert.equal(result.reason, 'inside-workspace')
      assert.equal(result.pathMode, item.pathMode)
      assert.equal(result.targetReal, item.resolved)
      assert.equal(result.relativePath, item.relativePath)

      // The download-relative path handed back to the client never escapes the root.
      assert.notEqual(result.relativePath, '')
      assert.ok(!result.relativePath.startsWith('../'))
      assert.ok(!posix.isAbsolute(result.relativePath))
      assert.ok(result.targetReal.startsWith(`${WORKSPACE}/`))
    })
  }
})

test('unsafe generated paths are rejected', async (t) => {
  for (const item of UNSAFE_PATH_CASES) {
    await t.test(item.name, () => {
      const result = evaluateGeneratedFileRequest(WORKSPACE, item.wirePath)

      assert.equal(result.decision, 'deny', `${item.wirePath} must be rejected`)
      assert.equal(result.status, item.status)
      assert.equal(result.reason, item.reason)
      assert.notEqual(result.status, 200)
    })
  }
})

test('the resolver output is a candidate, not a verdict: the containment guard is the boundary', () => {
  const traversals = [
    '../secret.txt',
    '/../etc/passwd',
    '%2e%2e%2fsecret.txt',
    '..%2f..%2fetc%2fpasswd',
    '..\\..\\etc\\passwd',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '..%5c..%5csecret.txt',
    `${WORKSPACE}/../../outside.txt`,
  ]

  for (const wirePath of traversals) {
    // Step 1-2 of the contract: the resolver returns an escaping candidate untouched.
    const decoded = decodeURIComponent(wirePath).replace(/\\/g, '/')
    const { candidatePath } = resolveGeneratedFileCandidatePath(WORKSPACE, decoded)
    const candidateRelativePath = posix.relative(WORKSPACE, posix.normalize(candidatePath))
    assert.ok(
      candidateRelativePath === '..' || candidateRelativePath.startsWith('../'),
      `${wirePath} should produce a candidate that escapes the root`,
    )

    // Step 3-4 of the contract: the guard rejects exactly that escaping candidate.
    const result = evaluateGeneratedFileRequest(WORKSPACE, wirePath)
    assert.equal(result.decision, 'deny')
    assert.equal(result.reason, 'escaped-workspace')
    assert.equal(result.candidateRelativePath, candidateRelativePath)
  }
})

test('a symlink inside the root that resolves outside the root is rejected', () => {
  const symlinkedCandidate = `${WORKSPACE}/downloads/report.pdf`
  const realTargetOutside = '/home/wattman/.wattclaw/user/secret-vault/credentials.json'

  const result = evaluateGeneratedFileRequest(WORKSPACE, '/downloads/report.pdf', {
    // Stands in for `realpath -e` following the symlink (files.js:122-132).
    canonicalize: (candidate) => (candidate === symlinkedCandidate ? realTargetOutside : posix.normalize(candidate)),
  })

  assert.equal(result.decision, 'deny')
  assert.equal(result.status, 403)
  assert.equal(result.reason, 'escaped-workspace')
  assert.equal(result.candidatePath, symlinkedCandidate)
  assert.equal(result.targetReal, realTargetOutside)
  assert.equal(result.relativePath, '../secret-vault/credentials.json')
})

test('normalized operation result keeps every allowed target inside the root', () => {
  const results = [
    ...VALID_PATH_CASES.map((item) => evaluateGeneratedFileRequest(WORKSPACE, item.wirePath)),
    ...UNSAFE_PATH_CASES.map((item) => evaluateGeneratedFileRequest(WORKSPACE, item.wirePath)),
  ]

  const allowed = results.filter((result) => result.decision === 'allow')
  assert.equal(allowed.length, VALID_PATH_CASES.length)

  for (const result of results) {
    assert.ok(['allow', 'deny'].includes(result.decision))
    if (result.decision === 'allow') {
      const { escaped } = containmentDecision(WORKSPACE, result.targetReal)
      assert.equal(escaped, false)
      assert.ok(result.targetReal.startsWith(`${WORKSPACE}/`))
    } else {
      assert.ok([400, 403].includes(result.status))
    }
  }

  // Every rejection is attributable to one of the request-resolution outcomes in the route.
  const reasons = new Set(results.filter((r) => r.decision === 'deny').map((r) => r.reason))
  assert.deepEqual([...reasons].sort(), ['denied-path', 'escaped-workspace', 'invalid-request'])
})
