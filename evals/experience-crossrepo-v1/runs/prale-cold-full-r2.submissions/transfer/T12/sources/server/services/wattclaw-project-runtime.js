const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 300

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function readError(result, fallback) {
  return result?.error?.message || result?.error || fallback
}

function projectFromRecord(record) {
  if (!record) return null
  if (typeof record.id === 'string' && Array.isArray(record.members)) return record

  for (const key of ['project', 'data', 'result', 'payload']) {
    const nested = projectFromRecord(asRecord(record[key]))
    if (nested) return nested
  }

  return null
}

export function extractWattClawProject(payload) {
  return projectFromRecord(asRecord(payload))
}

export function extractWattClawProjects(payload) {
  if (Array.isArray(payload)) {
    return payload.map(item => projectFromRecord(asRecord(item))).filter(Boolean)
  }

  const record = asRecord(payload)
  if (!record) return []
  for (const key of ['projects', 'items', 'list', 'data']) {
    if (Array.isArray(record[key])) {
      return record[key].map(item => projectFromRecord(asRecord(item))).filter(Boolean)
    }
  }
  return []
}

export function extractGatewayAgents(payload) {
  if (Array.isArray(payload)) return payload
  const record = asRecord(payload)
  if (!record) return []

  for (const key of ['agents', 'items', 'list', 'data']) {
    if (Array.isArray(record[key])) return record[key]
  }

  const data = asRecord(record.data)
  if (Array.isArray(data?.agents)) return data.agents
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.list)) return data.list
  return []
}

export function getWattClawProjectAgentIds(project) {
  if (!project || !Array.isArray(project.members)) return []
  return [...new Set(project.members
    .map(member => typeof member?.agentId === 'string' ? member.agentId.trim() : '')
    .filter(Boolean))]
}

export function getWattClawManagerAgentId(project) {
  const manager = project?.members?.find(member => member?.isLead)
  return typeof manager?.agentId === 'string' ? manager.agentId.trim() : ''
}

export function userOwnsWattClawProject(project, ownedAgentIds) {
  const owned = ownedAgentIds instanceof Set ? ownedAgentIds : new Set(ownedAgentIds || [])
  return getWattClawProjectAgentIds(project).some(agentId => owned.has(agentId))
}

export function filterWattClawProjectsByOwnedAgents(projects, ownedAgentIds) {
  return projects.filter(project => userOwnsWattClawProject(project, ownedAgentIds))
}

const FINAL_PROJECT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
const RESTORED_PROJECT_RETENTION_MS = 24 * 60 * 60 * 1000
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

export function nextWattClawRetentionRunAt(now = Date.now()) {
  const shanghaiNow = new Date(now + SHANGHAI_UTC_OFFSET_MS)
  let nextRunAt = Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
    18,
  ) - SHANGHAI_UTC_OFFSET_MS
  if (nextRunAt <= now) nextRunAt += 24 * 60 * 60 * 1000
  return nextRunAt
}

function projectStatus(project) {
  return typeof project?.status === 'string' ? project.status.trim().toLowerCase() : ''
}

function projectTimestamp(project, fallback = 0) {
  const updatedAt = Date.parse(typeof project?.updatedAt === 'string' ? project.updatedAt : '')
  if (Number.isFinite(updatedAt)) return updatedAt
  const createdAt = Date.parse(typeof project?.createdAt === 'string' ? project.createdAt : '')
  if (Number.isFinite(createdAt)) return createdAt
  return fallback
}

function projectAccessState(project, projectAccessStates, projectAccessTimes) {
  const state = projectAccessStates?.get(project?.id)
  if (state && typeof state === 'object') return state
  const legacyAccess = projectAccessTimes?.get(project?.id)
  return {
    lastAccessedAt: Number.isFinite(legacyAccess) ? legacyAccess : 0,
    restoredAt: 0,
  }
}

function unwrapGatewayPayload(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return result.ok ? result.payload : null
  }
  return result
}

export async function pruneWattClawProjectsForUser({
  gatewayRpc,
  ownedAgentIds,
  now = Date.now(),
  projectAccessStates,
  projectAccessTimes,
}) {
  if (typeof gatewayRpc !== 'function') {
    return { scanned: 0, kept: [], archived: [], skipped: [], failed: [] }
  }

  let projects
  try {
    const result = await gatewayRpc('wattclaw.team.project.list', {})
    projects = extractWattClawProjects(unwrapGatewayPayload(result))
  } catch (error) {
    console.warn('[WattClawRetention] failed to list projects:', error?.message || error)
    return { scanned: 0, kept: [], archived: [], skipped: [], failed: [] }
  }

  const ownedProjects = ownedAgentIds == null
    ? projects
    : filterWattClawProjectsByOwnedAgents(projects, ownedAgentIds)
  const archived = []
  const skipped = []
  const failed = []
  let loadedAgentIds = null

  try {
    const agentsResult = await gatewayRpc('agents.list', {})
    loadedAgentIds = new Set(
      extractGatewayAgents(unwrapGatewayPayload(agentsResult))
        .map(agentIdFromGatewayAgent)
        .filter(Boolean),
    )
  } catch {}

  for (const project of ownedProjects) {
    const status = projectStatus(project)
    const accessState = projectAccessState(project, projectAccessStates, projectAccessTimes)
    const restoredAt = Number(accessState.restoredAt) || 0
    const terminalStatus = status === 'success' || status === 'failed' || status === 'fail'
    const terminalAt = projectTimestamp(project)
    const terminalExpired = terminalStatus && terminalAt > 0 && now - terminalAt >= FINAL_PROJECT_RETENTION_MS
    const restoredExpired = status === 'archived'
      && restoredAt > 0
      && now - restoredAt >= RESTORED_PROJECT_RETENTION_MS
    const projectAgentIds = getWattClawProjectAgentIds(project)
    const hasLoadedAgent = loadedAgentIds === null
      || projectAgentIds.some(agentId => loadedAgentIds.has(agentId))
    const archivedNeedsUnload = status === 'archived' && restoredAt === 0 && hasLoadedAgent

    if (!terminalExpired && !restoredExpired && !archivedNeedsUnload) {
      skipped.push({ id: project.id, status: project.status })
      continue
    }

    if (status === 'archived' && !hasLoadedAgent) {
      archived.push(project.id)
      continue
    }
    try {
      await gatewayRpc('wattclaw.team.project.archive', { id: project.id })
      archived.push(project.id)
    } catch (error) {
      failed.push({ id: project.id, error: error?.message || String(error) })
      console.warn('[WattClawRetention] failed to archive project:', {
        projectId: project.id,
        error: error?.message || error,
      })
    }
  }

  return {
    scanned: ownedProjects.length,
    kept: skipped.map(project => project.id),
    archived,
    skipped,
    failed,
  }
}

export async function activateWattClawProjectRuntime({
  project,
  gatewayRpc,
}) {
  if (!project || typeof gatewayRpc !== 'function') {
    throw new Error('WattClaw project and gateway RPC are required')
  }

  const currentProject = project

  const initialAgentsResult = await gatewayRpc('agents.list', {})
  let agents = extractGatewayAgents(unwrapGatewayPayload(initialAgentsResult))
  const loaded = new Set(agents.map(agentIdFromGatewayAgent).filter(Boolean))
  const missingMembers = (currentProject.members || []).filter((member) => {
    const agentId = typeof member?.agentId === 'string' ? member.agentId.trim() : ''
    return agentId && !loaded.has(agentId)
  })

  for (const member of missingMembers) {
    const memberParams = {
      projectId: currentProject.id,
      agentId: member.agentId,
      ...(typeof member.name === 'string' ? { name: member.name } : {}),
      ...(typeof member.role === 'string' ? { role: member.role } : {}),
      ...(typeof member.soul === 'string' ? { soul: member.soul } : {}),
      ...(Array.isArray(member.skills) ? { skills: member.skills } : {}),
      ...(Array.isArray(member.richSkills) ? { richSkills: member.richSkills } : {}),
      ...(member.models !== undefined ? { models: member.models } : {}),
    }
    await gatewayRpc('wattclaw.team.project.member.update', memberParams)
  }

  if (missingMembers.length > 0) {
    const refreshedAgentsResult = await gatewayRpc('agents.list', {})
    agents = extractGatewayAgents(unwrapGatewayPayload(refreshedAgentsResult))
  }

  const missingAgentIds = getWattClawProjectAgentIds(currentProject).filter((agentId) => {
    return !agents.some(agent => agentIdFromGatewayAgent(agent) === agentId)
  })
  if (missingAgentIds.length > 0) {
    throw new Error(`WattClaw agents were not restored: ${missingAgentIds.join(', ')}`)
  }

  return {
    project: currentProject,
    agents,
    restored: projectStatus(currentProject) === 'archived',
  }
}

function agentIdFromGatewayAgent(agent) {
  const record = asRecord(agent)
  const id = record?.id || record?.agentId || record?.name
  return typeof id === 'string' ? id.trim() : ''
}

function findMissingAgentIds(agentIds, agents) {
  const loaded = new Set(agents.map(agentIdFromGatewayAgent).filter(Boolean))
  return agentIds.filter(agentId => !loaded.has(agentId))
}

async function listGatewayAgents(gatewayAdminRpc) {
  const result = await gatewayAdminRpc('agents.list', {})
  if (!result?.ok) throw new Error(readError(result, 'agents.list failed'))
  return extractGatewayAgents(result.payload)
}

async function applyCurrentGatewayConfig(gatewayAdminRpc) {
  const configResult = await gatewayAdminRpc('config.get', {})
  if (!configResult?.ok) throw new Error(readError(configResult, 'config.get failed'))

  const payload = asRecord(configResult.payload)
  const sourceConfig = payload?.sourceConfig || payload?.config || payload?.parsed
  const raw = typeof payload?.raw === 'string'
    ? payload.raw
    : sourceConfig
      ? JSON.stringify(sourceConfig)
      : ''
  const baseHash = typeof payload?.hash === 'string' ? payload.hash : ''

  if (!raw || !baseHash) throw new Error('Gateway config.get did not return raw config and hash')

  try {
    const applyResult = await gatewayAdminRpc('config.apply', { raw, baseHash })
    if (!applyResult?.ok) throw new Error(readError(applyResult, 'config.apply failed'))
  } catch (err) {
    // config.apply triggers a gateway reload which disconnects the WebSocket
    // before sending a response — treat connection errors as expected
    const msg = err?.message || ''
    if (!msg.includes('Connection closed') && !msg.includes('WebSocket not connected')) {
      throw err
    }
    // Connection closed is expected after config.apply — ignore and continue
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function ensureWattClawProjectRuntime({
  project,
  gatewayAdminRpc,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const agentIds = getWattClawProjectAgentIds(project)
  if (agentIds.length === 0) throw new Error('WattClaw project has no agents')

  let agents = await listGatewayAgents(gatewayAdminRpc)
  let missingAgentIds = findMissingAgentIds(agentIds, agents)
  if (missingAgentIds.length === 0) return agents

  await applyCurrentGatewayConfig(gatewayAdminRpc)

  // Gateway needs time to reconnect after config.apply triggered a reload
  await delay(pollIntervalMs)

  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    await delay(pollIntervalMs)
    try {
      agents = await listGatewayAgents(gatewayAdminRpc)
      missingAgentIds = findMissingAgentIds(agentIds, agents)
      if (missingAgentIds.length === 0) return agents
    } catch (error) {
      lastError = error
      // Continue polling even on connection errors during reconnect window
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`WattClaw agents were not loaded: ${missingAgentIds.join(', ')}${detail}`)
}

export function trackWattClawProjectOwnership({
  project,
  agents,
  userId,
  trackAgent,
  trackSession,
}) {
  if (!project || !userId) return { agentIds: [], sessionKeys: [] }

  const agentsById = new Map(agents.map(agent => [agentIdFromGatewayAgent(agent), agent]))
  const agentIds = []
  const sessionKeys = []

  for (const member of project.members || []) {
    const agentId = typeof member?.agentId === 'string' ? member.agentId.trim() : ''
    if (!agentId) continue

    const gatewayAgent = asRecord(agentsById.get(agentId))
    trackAgent(userId, agentId, member.name || gatewayAgent?.name || agentId, {
      workspace: gatewayAgent?.workspace || null,
      description: member.role || null,
    })
    agentIds.push(agentId)

    const sessionKey = `agent:${agentId}:main`
    trackSession(userId, sessionKey, agentId, project.name || member.name || agentId, 'main')
    sessionKeys.push(sessionKey)
  }

  return { agentIds, sessionKeys }
}
