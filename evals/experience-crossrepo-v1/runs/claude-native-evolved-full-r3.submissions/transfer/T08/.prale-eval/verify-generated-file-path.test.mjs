// Narrow, offline-safe verification of the frontend/server fixture
// `server/utils/generated-file-path.js`.
//
// It uses ONLY Node's built-in test runner (node:test) and assert (node:assert),
// so it needs no vitest, no node_modules, no SQLite/Gateway/network/env.
// Run: node --test .prale-eval/verify-generated-file-path.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGeneratedFileCandidatePath } from '../server/utils/generated-file-path.js'

const workspace = '/home/wattman/.wattclaw/user/report-agent'

describe('resolveGeneratedFileCandidatePath (offline fixture)', () => {
  it('resolves a leading-slash downloads path from the workspace root', () => {
    assert.deepEqual(resolveGeneratedFileCandidatePath(workspace, '/downloads/report.pdf'), {
      candidatePath: `${workspace}/downloads/report.pdf`,
      pathMode: 'workspace-root-relative',
    })
  })

  it('resolves an ordinary relative path from the workspace root', () => {
    assert.deepEqual(resolveGeneratedFileCandidatePath(workspace, 'downloads/report.pdf'), {
      candidatePath: `${workspace}/downloads/report.pdf`,
      pathMode: 'workspace-relative',
    })
  })

  it('preserves an absolute path already inside the workspace', () => {
    const absolutePath = `${workspace}/downloads/report.pdf`
    assert.deepEqual(resolveGeneratedFileCandidatePath(workspace, absolutePath), {
      candidatePath: absolutePath,
      pathMode: 'workspace-absolute',
    })
  })

  it('tolerates a trailing slash on the workspace root', () => {
    assert.deepEqual(resolveGeneratedFileCandidatePath(`${workspace}/`, 'x.pdf'), {
      candidatePath: `${workspace}/x.pdf`,
      pathMode: 'workspace-relative',
    })
  })
})
