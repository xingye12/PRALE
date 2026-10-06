export function resolveGeneratedFileCandidatePath(workspaceReal, requestedPath) {
  const normalizedWorkspace = workspaceReal.replace(/\/+$/, '')
  const normalizedRequested = requestedPath.replace(/\\/g, '/')
  const isWorkspaceAbsolute = normalizedRequested === normalizedWorkspace
    || normalizedRequested.startsWith(`${normalizedWorkspace}/`)

  if (isWorkspaceAbsolute) {
    return { candidatePath: normalizedRequested, pathMode: 'workspace-absolute' }
  }

  return {
    candidatePath: `${normalizedWorkspace}/${normalizedRequested.replace(/^\/+/, '')}`,
    pathMode: normalizedRequested.startsWith('/') ? 'workspace-root-relative' : 'workspace-relative',
  }
}
