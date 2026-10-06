// Traversal / encoded-separator fixture for the generated-file download path
// contract. Runs on Node's built-in test runner, so no dev dependencies are
// required:
//
//   node --test server/utils/generated-file-path.traversal.test.js
//
// The fixture asserts the two halves of the contract:
//   1. unsafe paths (traversal, encoded separators, null bytes) are rejected
//   2. valid generated paths stay inside the intended workspace root

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'

import {
  normalizeGeneratedFilePath,
  FIXTURE_WORKSPACE,
  GENERATED_FILE_PATH_FIXTURE_CASES,
} from './generated-file-path.contract.js'

describe('generated-file-path traversal / encoded-separator contract', () => {
  for (const testCase of GENERATED_FILE_PATH_FIXTURE_CASES) {
    it(`${testCase.expect}s ${testCase.name} (${JSON.stringify(testCase.path)})`, () => {
      const result = normalizeGeneratedFilePath(FIXTURE_WORKSPACE, testCase.path)

      if (testCase.expect === 'reject') {
        assert.equal(result.ok, false, `expected rejection for ${testCase.path}`)
        assert.equal(result.reason, testCase.reason)
        return
      }

      assert.equal(result.ok, true, `expected acceptance for ${testCase.path}`)
      assert.equal(result.pathMode, testCase.pathMode)
      assert.equal(result.relativePath, testCase.relativePath)

      // The accepted candidate must be a strict descendant of the root, with
      // no `..` segments and no absolute escape.
      assert.ok(
        result.candidatePath.startsWith(`${FIXTURE_WORKSPACE}/`),
        `candidate ${result.candidatePath} is not inside ${FIXTURE_WORKSPACE}`,
      )
      assert.equal(posix.isAbsolute(result.relativePath), false)
      assert.equal(result.relativePath.startsWith('../'), false)
      assert.equal(result.relativePath.includes('/../'), false)
      assert.equal(posix.normalize(result.candidatePath), posix.join(FIXTURE_WORKSPACE, result.relativePath))
    })
  }

  it('never yields an accepted candidate outside the intended root', () => {
    for (const testCase of GENERATED_FILE_PATH_FIXTURE_CASES) {
      const result = normalizeGeneratedFilePath(FIXTURE_WORKSPACE, testCase.path)
      if (!result.ok) continue
      const rel = posix.relative(FIXTURE_WORKSPACE, result.candidatePath)
      assert.ok(rel && !rel.startsWith('..') && !posix.isAbsolute(rel))
    }
  })

  it('prints the normalized operation results', () => {
    console.log(`\nworkspace root: ${FIXTURE_WORKSPACE}`)
    for (const testCase of GENERATED_FILE_PATH_FIXTURE_CASES) {
      const result = normalizeGeneratedFilePath(FIXTURE_WORKSPACE, testCase.path)
      const outcome = result.ok
        ? `ACCEPT -> ${result.relativePath} [${result.pathMode}]`
        : `REJECT (${result.reason})`
      console.log(`  ${JSON.stringify(testCase.path).padEnd(48)} ${outcome}`)
    }
  })
})
