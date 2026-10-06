// Offline-safe fixture verification for the WattClaw generated-file path fixture.
//
// Runs with ONLY the Node.js binary:
//   node .prale-eval/verify-fixture.mjs
//
// Why this is offline-safe:
//   * server/utils/generated-file-path.js is a pure ES module with ZERO imports
//     (only String.prototype methods), so it needs no package resolution.
//   * src/utils/generated-attachments.ts contains only type declarations plus a
//     pure function; Node >= 22.18 strips the types at load time with no toolchain.
//   * No vitest/vite/vue-tsc, no Express/SQLite/Postgres/WebSocket gateway, no
//     .env file, no network socket and no filesystem writes are touched by the
//     modules under test.
//   * The assertions below mirror the checked-in fixture expectations in
//     server/utils/generated-file-path.test.js and src/utils/generated-attachments.test.ts.

import assert from 'node:assert/strict'

import { resolveGeneratedFileCandidatePath } from '../server/utils/generated-file-path.js'
import { extractGeneratedAttachments } from '../src/utils/generated-attachments.ts'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, status: 'pass' })
  } catch (error) {
    results.push({ name, status: 'fail', error: error.message })
  }
}

// ── Server fixture: server/utils/generated-file-path.js ──
const workspace = '/home/wattman/.wattclaw/user/report-agent'

check('server fixture: leading-slash downloads path resolves from workspace root', () => {
  assert.deepEqual(resolveGeneratedFileCandidatePath(workspace, '/downloads/report.pdf'), {
    candidatePath: `${workspace}/downloads/report.pdf`,
    pathMode: 'workspace-root-relative',
  })
})

check('server fixture: ordinary relative path resolves from workspace root', () => {
  assert.deepEqual(resolveGeneratedFileCandidatePath(workspace, 'downloads/report.pdf'), {
    candidatePath: `${workspace}/downloads/report.pdf`,
    pathMode: 'workspace-relative',
  })
})

check('server fixture: absolute path already inside workspace is preserved', () => {
  const absolutePath = `${workspace}/downloads/report.pdf`
  assert.deepEqual(resolveGeneratedFileCandidatePath(workspace, absolutePath), {
    candidatePath: absolutePath,
    pathMode: 'workspace-absolute',
  })
})

// ── Frontend fixture: src/utils/generated-attachments.ts ──
check('frontend fixture: standalone MEDIA line becomes an absolute attachment', () => {
  const result = extractGeneratedAttachments(
    'The report is ready.\n\nMEDIA:/home/wattman/.wattclaw/user/agent/downloads/report.pdf',
  )
  assert.deepEqual(result.attachments, [
    { name: 'report.pdf', path: '/home/wattman/.wattclaw/user/agent/downloads/report.pdf', media: true },
  ])
  assert.equal(result.content, 'The report is ready.')
})

check('frontend fixture: relative markdown link is extracted and unwrapped', () => {
  const result = extractGeneratedAttachments('请下载 [分析报告](artifacts/report.pdf)。')
  assert.deepEqual(result.attachments, [{ name: '分析报告', path: 'artifacts/report.pdf' }])
  assert.equal(result.content, '请下载 分析报告。')
})

const failed = results.filter((entry) => entry.status === 'fail')
for (const entry of results) {
  console.log(`${entry.status === 'pass' ? 'PASS' : 'FAIL'}  ${entry.name}${entry.error ? ` — ${entry.error}` : ''}`)
}
console.log(`\nfixture verification: ${results.length - failed.length}/${results.length} passed (offline, node-only)`)

if (failed.length > 0) {
  process.exitCode = 1
}
