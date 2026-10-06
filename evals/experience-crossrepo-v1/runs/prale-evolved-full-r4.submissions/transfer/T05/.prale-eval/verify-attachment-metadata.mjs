// Dependency-free validation harness for the generated-file attachment
// metadata fixture (T05, wattclaw, mode=contract).
//
// node_modules is intentionally empty in this checkout, so vitest cannot run.
// This harness therefore executes the same fixture expectations directly
// against the real modules:
//   1. behavioral: server/utils/generated-file-path.js  (no imports, runs as-is)
//   2. behavioral: server/handlers/files.js pure helpers, loaded through a
//      narrow resolve hook that substitutes only the four unloadable import
//      edges (multer, core/auth.js, user-manager.js, core/system.js)
//   3. static: source anchors for the request parsing / containment guards the
//      handler applies around the normalized path
//
// Run: node .prale-eval/verify-attachment-metadata.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const report = { task_id: 'T05', checks: [], failures: [] }

function check(name, fn) {
  try {
    const detail = fn()
    report.checks.push({ name, status: 'pass', detail: detail ?? null })
  } catch (error) {
    report.checks.push({ name, status: 'fail', detail: error.message })
    report.failures.push({ name, message: error.message })
  }
}

const fixtureUrl = new URL('../server/utils/__fixtures__/generated-file-path.attachments.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf-8'))
const filesSourceUrl = new URL('../server/handlers/files.js', import.meta.url)
const filesSource = readFileSync(filesSourceUrl, 'utf-8')

const stripTrailingSlashes = (value) => String(value).replace(/\/+$/, '')

// ---------------------------------------------------------------- 1. normalizer
const { resolveGeneratedFileCandidatePath } = await import('../server/utils/generated-file-path.js')

const STUBS = new Map([
  ['multer', './stubs/multer.stub.mjs'],
  ['../core/auth.js', './stubs/auth.stub.mjs'],
  ['../user-manager.js', './stubs/user-manager.stub.mjs'],
  ['../core/system.js', './stubs/system.stub.mjs'],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && fileURLToPath(context.parentURL) === fileURLToPath(filesSourceUrl)) {
      const stub = STUBS.get(specifier)
      if (stub) return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const {
  isGeneratedFilePathAllowed,
  generatedFileMimeType,
} = await import('../server/handlers/files.js')

check('fixture-parses', () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, 'fixture must have cases')
  assert.deepEqual(fixture.pathModes, ['workspace-absolute', 'workspace-root-relative', 'workspace-relative'])
  return { cases: fixture.cases.length }
})

const normalizedResults = []

for (const entry of fixture.cases) {
  check(`normalize: ${entry.name}`, () => {
    const result = resolveGeneratedFileCandidatePath(entry.workspaceReal, entry.attachment.requestedPath)
    assert.deepEqual(result, entry.expected)
    assert.ok(fixture.pathModes.includes(result.pathMode), `unexpected path mode ${result.pathMode}`)
    const workspaceRoot = stripTrailingSlashes(entry.workspaceReal)
    assert.ok(
      result.candidatePath === workspaceRoot || result.candidatePath.startsWith(`${workspaceRoot}/`),
      'normalized candidate must stay anchored on the workspace root',
    )
    normalizedResults.push({
      requestedPath: entry.attachment.requestedPath,
      declaredMimeType: entry.attachment.declaredMimeType,
      declaredSizeBytes: entry.attachment.declaredSizeBytes,
      candidatePath: result.candidatePath,
      pathMode: result.pathMode,
    })
    return result
  })
}

check('normalize: declared client metadata never changes the normalized path', () => {
  const byInput = new Map()
  for (const entry of fixture.cases) {
    const key = `${stripTrailingSlashes(entry.workspaceReal)}\u0000${entry.attachment.requestedPath.replace(/\\/g, '/')}`
    const result = resolveGeneratedFileCandidatePath(entry.workspaceReal, entry.attachment.requestedPath)
    if (!byInput.has(key)) byInput.set(key, [])
    byInput.get(key).push(result)
  }
  const compared = [...byInput.values()].filter((group) => group.length > 1)
  for (const group of compared) {
    for (const result of group) assert.deepEqual(result, group[0])
  }
  return { sharedInputGroups: compared.length }
})

check('normalize: traversal is left for the handler realpath containment check', () => {
  const requestedPath = '../../secrets/notes.txt'
  const workspace = fixture.cases[0].workspaceReal
  const result = resolveGeneratedFileCandidatePath(workspace, requestedPath)
  assert.equal(result.pathMode, 'workspace-relative')
  assert.ok(result.candidatePath.includes('/../'), 'lexical normalizer must not collapse .. segments')
  assert.equal(result.candidatePath, `${workspace}/${requestedPath}`)
  return result
})

// ------------------------------------------------- 2. files.js pure helpers
check('files.js: isGeneratedFilePathAllowed allows ordinary attachment paths', () => {
  const allowed = [
    'downloads/report.pdf',
    'downloads/2026/q1 report.csv',
    'notes.md',
    'deep/nested/folder/file.txt',
  ]
  for (const path of allowed) assert.equal(isGeneratedFilePathAllowed(path), true, `${path} should be allowed`)
  return { allowed }
})

check('files.js: isGeneratedFilePathAllowed denies hidden/internal workspace paths', () => {
  const denied = [
    '.git/config',
    'downloads/.git/HEAD',
    '.openclaw/config.json',
    'downloads/../.openclaw/config.json',
    '.env',
    'downloads/.env.production',
    'AGENTS.md',
    'downloads/workspace-state.json',
    'openclaw-workspace-state.json',
    'nested/soul.md',
    'nested/USER.md',
  ]
  for (const path of denied) assert.equal(isGeneratedFilePathAllowed(path), false, `${path} should be denied`)
  return { denied }
})

check('files.js: generatedFileMimeType derives mime from the server-side path', () => {
  const cases = [
    ['downloads/report.pdf', 'application/pdf'],
    ['downloads/2026/q1 report.csv', 'text/csv'],
    ['notes.md', 'text/markdown'],
    ['data/REPORT.PDF', 'application/pdf'],
    ['archive.tar.gz', 'application/octet-stream'],
    ['payload.exe', 'application/octet-stream'],
    ['no-extension', 'application/octet-stream'],
  ]
  for (const [path, expected] of cases) {
    assert.equal(generatedFileMimeType(path), expected, `${path} -> ${expected}`)
  }
  return { cases: cases.length }
})

check('files.js: user-controlled attachment metadata stays confined to one workspace', () => {
  const workspace = '/home/wattman/.wattclaw/user/report-agent'
  const attacks = [
    { requestedPath: '../../other-user/secrets.env', declaredMimeType: 'text/plain' },
    { requestedPath: '..\\..\\other-user\\secrets.env', declaredMimeType: 'text/plain' },
    { requestedPath: 'C:\\Users\\wattman\\.ssh\\id_rsa', declaredMimeType: 'application/octet-stream' },
  ]
  for (const attack of attacks) {
    const { candidatePath } = resolveGeneratedFileCandidatePath(workspace, attack.requestedPath)
    assert.ok(candidatePath.startsWith(`${workspace}/`), 'candidate must stay lexically anchored on the workspace')
    assert.equal(candidatePath.includes('\\'), false, 'backslash separators must be unified')
  }
  return { attacks: attacks.length }
})

// ------------------------------------------------------- 3. handler anchors
check('files.js: request parsing normalizes the user-controlled path query', () => {
  assert.match(
    filesSource,
    /const requestedPath = typeof req\.query\.path === 'string' \? req\.query\.path\.trim\(\)\.replace\(\/\\\\\/g, '\/'\) : ''/,
    'expected the path query normalizer',
  )
  assert.match(filesSource, /!requestedPath \|\| requestedPath\.includes\('\\0'\)/, 'expected the empty/NUL guard')
  return 'path query is trimmed, backslash-unified, and rejected when empty or NUL-containing'
})

check('files.js: containment is enforced on the realpath-resolved target', () => {
  assert.match(filesSource, /const relativePath = posix\.relative\(workspaceReal, targetReal\)/)
  assert.match(
    filesSource,
    /const escapedWorkspace = !relativePath \|\| relativePath === '\.\.' \|\| relativePath\.startsWith\('\.\.\/'\) \|\| posix\.isAbsolute\(relativePath\)/,
  )
  assert.match(filesSource, /if \(escapedWorkspace \|\| !isGeneratedFilePathAllowed\(relativePath\)\)/)
  return 'normalized candidate -> realpath -> posix.relative containment -> deny-list gate'
})

check('files.js: response attachment metadata is server-derived', () => {
  assert.match(filesSource, /name: basename\(targetReal\)/)
  assert.match(filesSource, /path: relativePath/)
  assert.match(filesSource, /mimeType: generatedFileMimeType\(targetReal\)/)
  return 'name/path/mimeType come from the resolved real target, not from client-declared metadata'
})

report.normalizedResults = normalizedResults
report.status = report.failures.length === 0 ? 'pass' : 'fail'
report.summary = `${report.checks.filter((c) => c.status === 'pass').length}/${report.checks.length} checks passed`

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.failures.length === 0 ? 0 : 1
