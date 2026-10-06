import { describe, expect, it } from 'vitest'
import { posix } from 'path'
import { resolveGeneratedFileCandidatePath } from './generated-file-path.js'

// Same containment rule the generated-file route applies to the realpathed
// target (server/handlers/files.js): a request may only name a target inside
// the workspace root.
function containment(workspaceRoot, candidatePath) {
  const relativePath = posix.relative(workspaceRoot, posix.normalize(candidatePath))
  const escaped = !relativePath || relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)
  return { relativePath, escaped }
}

describe('resolveGeneratedFileCandidatePath', () => {
  const workspace = '/home/wattman/.wattclaw/user/report-agent'

  it('resolves a leading-slash downloads path from the workspace root', () => {
    expect(resolveGeneratedFileCandidatePath(workspace, '/downloads/report.pdf')).toEqual({
      candidatePath: `${workspace}/downloads/report.pdf`,
      pathMode: 'workspace-root-relative',
    })
  })

  it('resolves an ordinary relative path from the workspace root', () => {
    expect(resolveGeneratedFileCandidatePath(workspace, 'downloads/report.pdf')).toEqual({
      candidatePath: `${workspace}/downloads/report.pdf`,
      pathMode: 'workspace-relative',
    })
  })

  it('preserves an absolute path already inside the workspace', () => {
    const absolutePath = `${workspace}/downloads/report.pdf`
    expect(resolveGeneratedFileCandidatePath(workspace, absolutePath)).toEqual({
      candidatePath: absolutePath,
      pathMode: 'workspace-absolute',
    })
  })

  // Traversal / encoded-separator contract. The resolver is a normalizer: it
  // rewrites encoded separators and joins the request onto the root, but it
  // never rejects, so containment is asserted on top of its output in the same
  // way the route does it.
  it('rewrites backslash-encoded separators before classifying the path', () => {
    expect(resolveGeneratedFileCandidatePath(workspace, 'downloads\\report.pdf')).toEqual({
      candidatePath: `${workspace}/downloads/report.pdf`,
      pathMode: 'workspace-relative',
    })
  })

  it('exposes a relative traversal unchanged for the caller to contain', () => {
    const resolved = resolveGeneratedFileCandidatePath(workspace, '../../outside/secret.txt')
    expect(resolved).toEqual({
      candidatePath: `${workspace}/../../outside/secret.txt`,
      pathMode: 'workspace-relative',
    })
    expect(containment(workspace, resolved.candidatePath)).toEqual({
      relativePath: '../../outside/secret.txt',
      escaped: true,
    })
  })

  it('keeps a backslash-encoded traversal escaping the root after normalization', () => {
    const resolved = resolveGeneratedFileCandidatePath(workspace, '..\\..\\outside\\secret.txt')
    expect(resolved).toEqual({
      candidatePath: `${workspace}/../../outside/secret.txt`,
      pathMode: 'workspace-relative',
    })
    expect(containment(workspace, resolved.candidatePath).escaped).toBe(true)
  })

  it('rejects a leading-slash traversal against the workspace root', () => {
    const resolved = resolveGeneratedFileCandidatePath(workspace, '/../outside/secret.txt')
    expect(resolved).toEqual({
      candidatePath: `${workspace}/../outside/secret.txt`,
      pathMode: 'workspace-root-relative',
    })
    expect(containment(workspace, resolved.candidatePath).escaped).toBe(true)
  })

  it('keeps the documented valid path modes inside the workspace root', () => {
    const requests = [
      resolveGeneratedFileCandidatePath(workspace, 'downloads/report.pdf'),
      resolveGeneratedFileCandidatePath(workspace, '/downloads/report.pdf'),
      resolveGeneratedFileCandidatePath(workspace, `${workspace}/downloads/report.pdf`),
    ]
    for (const request of requests) {
      expect(containment(workspace, request.candidatePath)).toEqual({
        relativePath: 'downloads/report.pdf',
        escaped: false,
      })
    }
  })
})
