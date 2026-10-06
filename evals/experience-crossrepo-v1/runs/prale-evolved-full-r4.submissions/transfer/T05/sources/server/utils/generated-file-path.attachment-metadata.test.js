import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'

// User-controlled attachment metadata fixture: every `requestedPath` below is
// attacker-influenced input that reaches the generated-file download route,
// while `workspaceReal` is server-derived. The fixture pins the lexical
// normalization contract consumed by server/handlers/files.js.
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/generated-file-path.attachments.json', import.meta.url), 'utf-8'),
)

const stripTrailingSlashes = (value) => String(value).replace(/\/+$/, '')

describe('resolveGeneratedFileCandidatePath attachment metadata fixture', () => {
  it('provides a non-empty fixture of user-controlled attachment metadata', () => {
    expect(Array.isArray(fixture.cases)).toBe(true)
    expect(fixture.cases.length).toBeGreaterThan(0)
    for (const entry of fixture.cases) {
      expect(entry.name).toEqual(expect.any(String))
      expect(entry.workspaceReal).toEqual(expect.any(String))
      expect(entry.attachment.requestedPath).toEqual(expect.any(String))
      expect(entry.expected.pathMode).toEqual(expect.any(String))
    }
  })

  for (const entry of fixture.cases) {
    it(`normalizes ${entry.name}`, () => {
      const result = resolveGeneratedFileCandidatePath(entry.workspaceReal, entry.attachment.requestedPath)

      expect(result).toEqual(entry.expected)
      expect(fixture.pathModes).toContain(result.pathMode)

      // The lexical candidate is always anchored on the declared workspace root;
      // the root itself (no trailing slash) is the single allowed boundary case.
      const workspaceRoot = stripTrailingSlashes(entry.workspaceReal)
      expect(
        result.candidatePath === workspaceRoot || result.candidatePath.startsWith(`${workspaceRoot}/`),
      ).toBe(true)
    })
  }

  it('never lets declared client attachment metadata change the normalized path', () => {
    const byResolvedInput = new Map()
    for (const entry of fixture.cases) {
      const key = `${stripTrailingSlashes(entry.workspaceReal)}\u0000${entry.attachment.requestedPath.replace(/\\/g, '/')}`
      const result = resolveGeneratedFileCandidatePath(entry.workspaceReal, entry.attachment.requestedPath)
      if (!byResolvedInput.has(key)) byResolvedInput.set(key, [])
      byResolvedInput.get(key).push({ declaredMimeType: entry.attachment.declaredMimeType, result })
    }

    for (const results of byResolvedInput.values()) {
      for (const candidate of results) {
        expect(candidate.result).toEqual(results[0].result)
      }
    }
  })

  it('leaves traversal paths unresolved so the handler realpath containment check still has work to do', () => {
    const traversal = fixture.cases.find((entry) => entry.name.includes('parent traversal'))
    expect(traversal).toBeDefined()

    const result = resolveGeneratedFileCandidatePath(traversal.workspaceReal, traversal.attachment.requestedPath)

    expect(result.pathMode).toBe('workspace-relative')
    expect(result.candidatePath.includes('/../')).toBe(true)
  })

  it('treats a single leading slash as workspace-root-relative instead of an escaping absolute path', () => {
    const entry = fixture.cases.find((item) => item.attachment.requestedPath === '/downloads/report.pdf')
    expect(entry).toBeDefined()

    const result = resolveGeneratedFileCandidatePath(entry.workspaceReal, entry.attachment.requestedPath)

    expect(result.pathMode).toBe('workspace-root-relative')
    expect(result.candidatePath).toBe(
      `${stripTrailingSlashes(entry.workspaceReal)}/downloads/report.pdf`,
    )
  })
})
