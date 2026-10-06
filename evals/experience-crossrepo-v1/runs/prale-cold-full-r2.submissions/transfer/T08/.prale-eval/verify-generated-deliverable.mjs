// Offline-safe verification of the generated-deliverable fixture shared by the
// WattClaw frontend (`src/utils/generated-attachments.ts`) and server
// (`server/utils/generated-file-path.js` + `server/handlers/files.js`).
//
// Run with:  node .prale-eval/verify-generated-deliverable.mjs
//
// It touches no network, no HTTP server, no database, no gateway, no Docker and
// no third-party package: only Node's built-in stdlib and the two pure modules.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FRONTEND_MODULE = '../src/utils/generated-attachments.ts'
const SERVER_MODULE = '../server/utils/generated-file-path.js'

const { extractGeneratedAttachments } = await import(FRONTEND_MODULE)
const { resolveGeneratedFileCandidatePath } = await import(SERVER_MODULE)

// The workspace the server resolves a generated-file request against.
const WORKSPACE = '/home/wattman/.wattclaw/user/agent'

// ── Offline-safety invariant: neither module has a runtime dependency ──
function runtimeImports(relativePath) {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf-8')
  return source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line))
}

assert.deepEqual(runtimeImports(FRONTEND_MODULE), [], 'frontend fixture module must have no runtime imports')
assert.deepEqual(runtimeImports(SERVER_MODULE), [], 'server fixture module must have no runtime imports')

// ── Shared fixtures: agent output text -> frontend path -> server resolution ──
const fixtures = [
  {
    id: 'media-absolute',
    content: 'The report is ready.\n\nMEDIA:/home/wattman/.wattclaw/user/agent/downloads/report.pdf',
    expectedAttachments: [
      { name: 'report.pdf', path: '/home/wattman/.wattclaw/user/agent/downloads/report.pdf', media: true },
    ],
    expectedContent: 'The report is ready.',
    expectedResolution: {
      candidatePath: '/home/wattman/.wattclaw/user/agent/downloads/report.pdf',
      pathMode: 'workspace-absolute',
    },
  },
  {
    id: 'table-relative',
    content: '处理完成。\n\n| 文件名 | 文件路径 |\n| --- | --- |\n| 报告.xlsx | outputs/报告.xlsx |',
    expectedAttachments: [{ name: '报告.xlsx', path: 'outputs/报告.xlsx' }],
    expectedContent: '处理完成。',
    expectedResolution: {
      candidatePath: '/home/wattman/.wattclaw/user/agent/outputs/报告.xlsx',
      pathMode: 'workspace-relative',
    },
  },
  {
    id: 'cue-root-relative',
    content: 'HTML 文件已生成，保存在：\n\n**`/downloads/东北旅游攻略.html`**\n\n直接在浏览器打开即可浏览。',
    expectedAttachments: [{ name: '东北旅游攻略.html', path: '/downloads/东北旅游攻略.html' }],
    expectedContent: 'HTML 文件已生成，保存在：\n\n直接在浏览器打开即可浏览。',
    expectedResolution: {
      candidatePath: '/home/wattman/.wattclaw/user/agent/downloads/东北旅游攻略.html',
      pathMode: 'workspace-root-relative',
    },
  },
  {
    id: 'rejected-unsafe-links',
    content: '[官网](https://example.com/report.pdf) [配置](../.env)',
    expectedAttachments: [],
    expectedContent: '[官网](https://example.com/report.pdf) [配置](../.env)',
    expectedResolution: null,
  },
]

const results = []
for (const fixture of fixtures) {
  const parsed = extractGeneratedAttachments(fixture.content)
  assert.deepEqual(parsed.attachments, fixture.expectedAttachments, `${fixture.id}: attachments`)
  assert.equal(parsed.content, fixture.expectedContent, `${fixture.id}: cleaned content`)

  const resolutions = parsed.attachments.map((attachment) =>
    resolveGeneratedFileCandidatePath(WORKSPACE, attachment.path),
  )
  if (fixture.expectedResolution) {
    assert.deepEqual(resolutions, [fixture.expectedResolution], `${fixture.id}: server resolution`)
  } else {
    assert.deepEqual(resolutions, [], `${fixture.id}: nothing reaches the server`)
  }

  results.push({
    fixture: fixture.id,
    frontendPaths: parsed.attachments.map((attachment) => attachment.path),
    serverResolutions: resolutions,
  })
}

const normalized = {
  operation: 'generated-deliverable-fixture-verification',
  workspace: WORKSPACE,
  frontendModule: 'src/utils/generated-attachments.ts#extractGeneratedAttachments',
  serverModule: 'server/utils/generated-file-path.js#resolveGeneratedFileCandidatePath',
  runtimeDependencies: { frontend: 0, server: 0 },
  fixtures: results,
  status: 'pass',
}

console.log(JSON.stringify(normalized, null, 2))
