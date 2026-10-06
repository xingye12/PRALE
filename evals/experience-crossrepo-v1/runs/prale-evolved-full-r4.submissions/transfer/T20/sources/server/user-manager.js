import { randomUUID, createHash, randomBytes } from 'crypto'
import db, { ensureDefaultAdmin } from './database.js'
import {
  normalizeDisplayTitleCandidate,
  shouldBackfillDisplayTitle,
} from './services/session-title-service.js'
import { syncAllTenantOpenClawConfigsFromDB } from './openclaw-config-sync.js'

const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000
const SALT_LENGTH = 32

function syncModelProvidersToOpenClawConfigs(label) {
  try {
    return syncAllTenantOpenClawConfigsFromDB()
  } catch (err) {
    console.error(`[UserManager] openclaw.json sync error on ${label}:`, err.message)
    return []
  }
}

function hashPassword(password, salt) {
  if (!salt) salt = randomBytes(SALT_LENGTH).toString('hex')
  const hash = createHash('sha256').update(salt + password).digest('hex')
  return { hash, salt }
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt)
  return hash === storedHash
}

export function initDefaultAdmin(username, password) {
  if (!username || !password) return
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (!existing) {
    const { hash, salt } = hashPassword(password)
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, display_name, status, settings, password_changed_at)
      VALUES (?, ?, ?, 'admin', 'Administrator', 'active', ?, ?)
    `).run(randomUUID(), username, `${salt}:${hash}`, JSON.stringify({ salt }), Date.now())
  } else {
    const { hash, salt } = hashPassword(password)
    db.prepare(`
      UPDATE users SET password_hash = ?, settings = ?, updated_at = ?, password_changed_at = COALESCE(password_changed_at, ?)
      WHERE id = ?
    `).run(`${salt}:${hash}`, JSON.stringify({ salt }), Date.now(), Date.now(), existing.id)
  }
}

export function createUser({ username, password, role = 'user', displayName, email }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) {
    throw new Error('Username already exists')
  }

  const { hash, salt } = hashPassword(password)
  const id = randomUUID()

  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, display_name, email, status, settings)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, username, `${salt}:${hash}`, role, displayName || username, email || null, JSON.stringify({ salt }))

  return getUserById(id)
}

export function getUserById(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  if (!user) return null
  return sanitizeUser(user)
}

export function getUserByUsername(username) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) return null
  return user
}

export function authenticateUser(username, password) {
  const user = getUserByUsername(username)
  if (!user) return null
  if (user.status !== 'active') return null

  const settings = JSON.parse(user.settings || '{}')
  const parts = user.password_hash.split(':')
  if (parts.length !== 2) return null

  const [salt, storedHash] = parts
  if (!verifyPassword(password, storedHash, salt)) return null

  return sanitizeUser(user)
}

export function createAuthToken(userId, userAgent, ipAddress) {
  const token = randomUUID()
  const id = randomUUID()
  const expiresAt = Date.now() + TOKEN_EXPIRY

  db.prepare(`
    INSERT INTO auth_tokens (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, token, userAgent || null, ipAddress || null, expiresAt, Date.now(), Date.now())

  return { token, expiresAt }
}

const _tokenCache = new Map() // token -> { user, token, ts }
const TOKEN_CACHE_TTL = 30_000
const _lastUsedUpdates = new Map() // token -> lastUpdateTime
const LAST_USED_THROTTLE = 60_000

export function invalidateTokenCache(token) {
  _tokenCache.delete(token)
  _lastUsedUpdates.delete(token)
}

export function validateToken(token) {
  if (!token) return null

  // Check in-memory cache first
  const cached = _tokenCache.get(token)
  if (cached && Date.now() - cached.ts < TOKEN_CACHE_TTL) {
    // Throttle last_used_at writes to once per minute per token
    const lastUpdate = _lastUsedUpdates.get(token) || 0
    if (Date.now() - lastUpdate > LAST_USED_THROTTLE) {
      _lastUsedUpdates.set(token, Date.now())
      try { db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token = ?').run(Date.now(), token) } catch {}
    }
    return cached.result
  }

  const authToken = db.prepare('SELECT * FROM auth_tokens WHERE token = ? AND expires_at > ?').get(token, Date.now())
  if (!authToken) return null

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authToken.user_id)
  if (!user || user.status !== 'active') {
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token)
    _tokenCache.delete(token)
    return null
  }

  // Throttle last_used_at writes
  const lastUpdate = _lastUsedUpdates.get(token) || 0
  if (Date.now() - lastUpdate > LAST_USED_THROTTLE) {
    _lastUsedUpdates.set(token, Date.now())
    db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token = ?').run(Date.now(), token)
  }

  const result = { user: sanitizeUser(user), token: authToken }
  _tokenCache.set(token, { result, ts: Date.now() })
  return result
}

export function deleteToken(token) {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token)
  invalidateTokenCache(token)
}

export function deleteUserTokens(userId) {
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId)
  // Clear all cached tokens for this user
  for (const [key, val] of _tokenCache) {
    if (val.result.user.id === userId) _tokenCache.delete(key)
  }
}

function normalizeUserSearch(search) {
  return String(search || '').trim().replace(/[\\%_]/g, '\\$&')
}

export function listUsers(limit = 50, offset = 0, search = '') {
  const normalizedSearch = normalizeUserSearch(search)
  const users = normalizedSearch
    ? db.prepare(`
        SELECT * FROM users
        WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(`%${normalizedSearch}%`, `%${normalizedSearch}%`, limit, offset)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
  return users.map(sanitizeUser)
}

export function getUserCount(search = '') {
  const normalizedSearch = normalizeUserSearch(search)
  if (!normalizedSearch) return db.prepare('SELECT COUNT(*) as count FROM users').get().count
  return db.prepare(`
    SELECT COUNT(*) as count FROM users
    WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
  `).get(`%${normalizedSearch}%`, `%${normalizedSearch}%`).count
}

export function updateUser(id, updates) {
  const allowed = ['displayName', 'email', 'role', 'status', 'avatar']
  const fields = []
  const values = []

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      fields.push(`${dbKey} = ?`)
      values.push(updates[key])
    }
  }

  if (updates.password) {
    const { hash, salt } = hashPassword(updates.password)
    fields.push('password_hash = ?')
    values.push(`${salt}:${hash}`)
    fields.push('settings = ?')
    values.push(JSON.stringify({ salt }))
    fields.push('password_changed_at = ?')
    values.push(Date.now())
  }

  if (fields.length === 0) return getUserById(id)

  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getUserById(id)
}

export function deleteUser(id) {
  deleteUserTokens(id)
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM user_agents WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM user_channels WHERE user_id = ?').run(id)
  db.prepare(`
    DELETE FROM wattclaw_project_feishu_members
    WHERE project_id IN (
      SELECT project_id FROM wattclaw_project_feishu_sync WHERE user_id = ?
    )
  `).run(id)
  db.prepare('DELETE FROM wattclaw_project_feishu_sync WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM user_feishu_bots WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

export function getUserAgents(userId) {
  return db.prepare('SELECT * FROM user_agents WHERE user_id = ? ORDER BY created_at DESC').all(userId)
}

export function createUserAgent(userId, agent) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO user_agents (id, user_id, gateway_agent_id, workspace, name, description, config, system_prompt, model, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    id,
    userId,
    agent.gatewayAgentId || null,
    agent.workspace || null,
    agent.name,
    agent.description || null,
    JSON.stringify(agent.config || {}),
    agent.systemPrompt || null,
    agent.model || null
  )
  return db.prepare('SELECT * FROM user_agents WHERE id = ?').get(id)
}

export function updateUserAgent(id, updates) {
  const allowed = ['gatewayAgentId', 'name', 'description', 'config', 'systemPrompt', 'model', 'status']
  const fields = []
  const values = []

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      fields.push(`${dbKey} = ?`)
      values.push(key === 'config' ? JSON.stringify(updates[key]) : updates[key])
    }
  }

  if (fields.length === 0) return null

  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  db.prepare(`UPDATE user_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return db.prepare('SELECT * FROM user_agents WHERE id = ?').get(id)
}

export function deleteUserAgent(id) {
  const row = db.prepare('SELECT gateway_agent_id FROM user_agents WHERE id = ?').get(id)
  if (row) {
    db.prepare('DELETE FROM skill_store_agent_skill WHERE agent_id = ?').run(row.gateway_agent_id)
  }
  db.prepare('DELETE FROM user_agents WHERE id = ?').run(id)
}

export function getUserSessions(userId) {
  return db.prepare(`
    SELECT *
    FROM user_sessions
    WHERE user_id = ?
    ORDER BY last_message_at DESC, updated_at DESC
  `).all(userId)
}

export function createUserSession(userId, session) {
  const tenantId = resolveTenantIdForUser(userId) || resolveTenantIdForAgent(session.agentId)
  const existing = db.prepare('SELECT id FROM user_sessions WHERE session_key = ?').get(session.sessionKey)
  if (existing) {
    db.prepare(`
      UPDATE user_sessions
      SET updated_at = ?,
          label = ?,
          tenant_id = COALESCE(NULLIF(tenant_id, ''), ?)
      WHERE id = ?
    `).run(Date.now(), session.label || null, tenantId || null, existing.id)
    return db.prepare('SELECT * FROM user_sessions WHERE id = ?').get(existing.id)
  }
  const id = randomUUID()
  db.prepare(`
    INSERT INTO user_sessions (id, user_id, session_key, agent_id, label, channel, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, session.sessionKey, session.agentId || null, session.label || null, session.channel || null, tenantId || null)
  return db.prepare('SELECT * FROM user_sessions WHERE id = ?').get(id)
}

export function deleteUserSession(userId, sessionKey) {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND session_key = ?').run(userId, sessionKey)
}

export function getUserChannels(userId) {
  return db.prepare('SELECT * FROM user_channels WHERE user_id = ? ORDER BY created_at DESC').all(userId)
}

export function createUserChannel(userId, channel) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO user_channels (id, user_id, agent_id, channel_type, name, config, webhook_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId,
    channel.agentId || null,
    channel.channelType,
    channel.name,
    JSON.stringify(channel.config || {}),
    channel.webhookUrl || null,
    channel.status || 'inactive'
  )
  return db.prepare('SELECT * FROM user_channels WHERE id = ?').get(id)
}

export function updateUserChannel(id, updates) {
  const allowed = ['name', 'config', 'webhookUrl', 'status', 'lastSyncAt', 'errorMessage', 'agentId']
  const fields = []
  const values = []

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      fields.push(`${dbKey} = ?`)
      values.push(key === 'config' ? JSON.stringify(updates[key]) : updates[key])
    }
  }

  if (fields.length === 0) return null

  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)

  db.prepare(`UPDATE user_channels SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return db.prepare('SELECT * FROM user_channels WHERE id = ?').get(id)
}

export function deleteUserChannel(id) {
  db.prepare('DELETE FROM user_channels WHERE id = ?').run(id)
}

function sanitizeUser(user) {
  if (!user) return null
  const { password_hash, settings, ...safe } = user
  return {
    ...safe,
    settings: typeof settings === 'string' ? JSON.parse(settings || '{}') : settings,
  }
}

export function getUserOwnedAgentIds(userId) {
  const rows = db.prepare('SELECT gateway_agent_id FROM user_agents WHERE user_id = ? AND status = \'active\'').all(userId)
  return rows.map(r => r.gateway_agent_id).filter(Boolean)
}

export function getUserIdsByAgentId(agentId) {
  const rows = db.prepare('SELECT DISTINCT user_id FROM user_agents WHERE gateway_agent_id = ? AND status = \'active\'').all(agentId)
  return rows.map(r => r.user_id)
}

export function touchWattClawProjectAccess(userId, projectId, tenantId = '') {
  if (!userId || !projectId) return
  db.prepare(`
    INSERT INTO wattclaw_project_access (user_id, project_id, tenant_id, last_accessed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      last_accessed_at = excluded.last_accessed_at
  `).run(userId, projectId, tenantId || '', Date.now())
}

export function getWattClawProjectAccessTimes(userId) {
  if (!userId) return new Map()
  const rows = db.prepare(`
    SELECT project_id, last_accessed_at
    FROM wattclaw_project_access
    WHERE user_id = ?
  `).all(userId)
  return new Map(rows.map(row => [row.project_id, row.last_accessed_at]))
}

export function getWattClawProjectAccessStates(userId) {
  if (!userId) return new Map()
  const rows = db.prepare(`
    SELECT project_id, last_accessed_at, restored_at
    FROM wattclaw_project_access
    WHERE user_id = ?
  `).all(userId)
  return new Map(rows.map(row => [row.project_id, {
    lastAccessedAt: Number(row.last_accessed_at) || 0,
    restoredAt: Number(row.restored_at) || 0,
  }]))
}

export function getWattClawProjectAccessStatesForRetention() {
  const rows = db.prepare(`
    SELECT
      project_id,
      MAX(last_accessed_at) AS last_accessed_at,
      MAX(restored_at) AS restored_at
    FROM wattclaw_project_access
    GROUP BY project_id
  `).all()
  return new Map(rows.map(row => [row.project_id, {
    lastAccessedAt: Number(row.last_accessed_at) || 0,
    restoredAt: Number(row.restored_at) || 0,
  }]))
}

export function markWattClawProjectRestored(userId, projectId, tenantId = '', restoredAt = Date.now()) {
  if (!userId || !projectId) return
  db.prepare(`
    INSERT INTO wattclaw_project_access (user_id, project_id, tenant_id, last_accessed_at, restored_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      tenant_id = COALESCE(NULLIF(excluded.tenant_id, ''), wattclaw_project_access.tenant_id),
      last_accessed_at = excluded.last_accessed_at,
      restored_at = excluded.restored_at
  `).run(userId, projectId, tenantId || '', restoredAt, restoredAt)
}

export function markWattClawProjectArchived(userId, projectId, archivedAt = Date.now()) {
  if (!userId || !projectId) return
  db.prepare(`
    INSERT INTO wattclaw_project_access (user_id, project_id, tenant_id, last_accessed_at, restored_at)
    VALUES (?, ?, '', ?, 0)
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      last_accessed_at = excluded.last_accessed_at,
      restored_at = 0
  `).run(userId, projectId, archivedAt)
}

export function markWattClawProjectArchivedForRetention(projectId, archivedAt = Date.now()) {
  if (!projectId) return
  db.prepare(`
    UPDATE wattclaw_project_access
    SET last_accessed_at = ?, restored_at = 0
    WHERE project_id = ?
  `).run(archivedAt, projectId)
}

export function removeWattClawProjectAccess(userId, projectId) {
  if (!userId || !projectId) return
  db.prepare('DELETE FROM wattclaw_project_access WHERE user_id = ? AND project_id = ?').run(userId, projectId)
}

export function getAllGatewayAgentIds() {
  const rows = db.prepare('SELECT DISTINCT gateway_agent_id FROM user_agents WHERE status = \'active\' AND gateway_agent_id IS NOT NULL').all()
  return rows.map(r => r.gateway_agent_id).filter(Boolean)
}

export function resolveTenantIdForUser(userId) {
  if (!userId) return ''
  const row = db.prepare('SELECT tenant_id FROM user_tenant_assignments WHERE user_id = ?').get(userId)
  return row?.tenant_id || ''
}

export function resolveTenantIdForAgent(agentId) {
  if (!agentId) return ''
  const row = db.prepare(`
    SELECT uta.tenant_id
    FROM user_agents ua
    INNER JOIN user_tenant_assignments uta ON uta.user_id = ua.user_id
    WHERE ua.gateway_agent_id = ? AND ua.status = 'active'
    ORDER BY ua.updated_at DESC
    LIMIT 1
  `).get(agentId)
  return row?.tenant_id || ''
}

export function resolveTenantIdForSession(sessionKey) {
  if (!sessionKey) return ''

  const sessionRow = db.prepare(`
    SELECT session_key, user_id, agent_id, tenant_id
    FROM user_sessions
    WHERE session_key = ?
    LIMIT 1
  `).get(sessionKey)

  if (sessionRow?.tenant_id) return sessionRow.tenant_id

  let tenantId = ''
  if (sessionRow?.user_id) {
    tenantId = resolveTenantIdForUser(sessionRow.user_id)
  }

  const agentId = sessionRow?.agent_id || sessionKey.match(/^agent:([^:]+):/)?.[1] || ''
  if (!tenantId && agentId) {
    tenantId = resolveTenantIdForAgent(agentId)
  }

  if (tenantId && sessionRow) {
    db.prepare(`
      UPDATE user_sessions
      SET tenant_id = ?
      WHERE session_key = ? AND (tenant_id IS NULL OR tenant_id = '')
    `).run(tenantId, sessionKey)
  }

  return tenantId
}

export function getUserAgentsList(userId) {
  return db.prepare('SELECT gateway_agent_id, name FROM user_agents WHERE user_id = ? AND status = \'active\' ORDER BY created_at DESC').all(userId)
}

export function getUserOwnedSessionKeys(userId) {
  const rows = db.prepare('SELECT session_key FROM user_sessions WHERE user_id = ?').all(userId)
  return rows.map(r => r.session_key)
}

export function normalizeSessionUpdatedAt(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000)
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1e12 ? Math.floor(numeric) : Math.floor(numeric * 1000)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function logSessionDiagnostic(scope, payload) {
  if (process.env.SESSION_DIAG !== '1') return
  console.log(`[SessionDiag:${scope}]`, payload)
}

function readNormalizedDisplayTitle(title, peerId) {
  return shouldBackfillDisplayTitle(title, peerId) ? null : normalizeDisplayTitleCandidate(title)
}

function readNormalizedLabel(label, peerId) {
  return shouldBackfillDisplayTitle(label, peerId) ? null : String(label || '').trim() || null
}

export function trackSessionForUser(userId, sessionKey, agentId, label, channel) {
  const displayTitle = readNormalizedDisplayTitle(label)
  const tenantId = resolveTenantIdForUser(userId) || resolveTenantIdForAgent(agentId)
  const existing = db.prepare('SELECT id, user_id, label, display_title, agent_id, channel, tenant_id FROM user_sessions WHERE session_key = ?').get(sessionKey)
  logSessionDiagnostic('trackSessionForUser', {
    userId,
    sessionKey,
    agentId: agentId || null,
    hasIncomingLabel: typeof label === 'string' && label.trim().length > 0,
    hasIncomingDisplayTitle: !!displayTitle,
    channel: channel || null,
    action: existing ? 'update' : 'insert',
    hasExistingLabel: typeof existing?.label === 'string' && existing.label.trim().length > 0,
    hasExistingDisplayTitle: typeof existing?.display_title === 'string' && existing.display_title.trim().length > 0,
    existingAgentId: existing?.agent_id || null,
    existingChannel: existing?.channel || null,
    existingTenantId: existing?.tenant_id || null,
  })
  if (existing) {
    const existingDisplayTitle = readNormalizedDisplayTitle(existing.display_title)
    db.prepare(`
      UPDATE user_sessions
      SET agent_id = COALESCE(?, agent_id),
          label = COALESCE(label, ?),
          channel = COALESCE(channel, ?),
          display_title = COALESCE(?, ?),
          tenant_id = COALESCE(NULLIF(tenant_id, ''), ?)
      WHERE id = ?
    `).run(agentId || null, label || null, channel || null, existingDisplayTitle, displayTitle, tenantId || null, existing.id)
  } else {
    db.prepare(`
      INSERT INTO user_sessions (id, user_id, session_key, agent_id, label, channel, display_title, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), userId, sessionKey, agentId || null, label || null, channel || null, displayTitle, tenantId || null)
  }
}

export function upsertSyncedUserSession({ userId, sessionKey, agentId, channel, peer, label, lastActivity }) {
  if (!userId || !sessionKey) return { changed: false, action: 'skipped' }

  const now = Date.now()
  const tenantId = resolveTenantIdForUser(userId) || resolveTenantIdForAgent(agentId)
  const lastMessageAt = normalizeSessionUpdatedAt(lastActivity, null)
  const incomingDisplayTitle = readNormalizedDisplayTitle(label, peer)
  const existing = db.prepare(`
    SELECT id, user_id, agent_id, channel, peer_id, label, display_title, last_message_at, tenant_id
    FROM user_sessions
    WHERE session_key = ?
  `).get(sessionKey)

  if (!existing) {
    db.prepare(`
      INSERT INTO user_sessions (
        id, user_id, session_key, agent_id, label, channel,
        peer_id, display_title, last_message_at, updated_at, tenant_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      userId,
      sessionKey,
      agentId || null,
      label || null,
      channel || null,
      peer || null,
      incomingDisplayTitle,
      lastMessageAt,
      now,
      tenantId || null
    )
    return { changed: true, action: 'inserted' }
  }

  const cleanExistingDisplayTitle = readNormalizedDisplayTitle(existing.display_title, existing.peer_id)
  const cleanExistingLabel = readNormalizedLabel(existing.label, existing.peer_id)
  const cleanIncomingLabel = readNormalizedLabel(label, peer)
  const nextAgentId = agentId || existing.agent_id || null
  const nextChannel = channel || existing.channel || null
  const nextPeerId = peer || existing.peer_id || null
  const nextLabel = cleanExistingLabel || cleanIncomingLabel || null
  const nextDisplayTitle = cleanExistingDisplayTitle || incomingDisplayTitle || null
  const nextTenantId = existing.tenant_id || tenantId || null
  const currentLastMessageAt = Number(existing.last_message_at) || 0
  const nextLastMessageAt = lastMessageAt == null
    ? existing.last_message_at || null
    : Math.max(currentLastMessageAt, lastMessageAt)

  const changed =
    nextAgentId !== (existing.agent_id || null) ||
    nextChannel !== (existing.channel || null) ||
    nextPeerId !== (existing.peer_id || null) ||
    nextLabel !== (existing.label || null) ||
    nextDisplayTitle !== (existing.display_title || null) ||
    nextTenantId !== (existing.tenant_id || null) ||
    nextLastMessageAt !== (existing.last_message_at || null)

  if (!changed) return { changed: false, action: 'unchanged' }

  db.prepare(`
    UPDATE user_sessions
    SET updated_at = ?,
        agent_id = ?,
        channel = ?,
        peer_id = ?,
        label = ?,
        display_title = ?,
        last_message_at = ?,
        tenant_id = ?
    WHERE id = ?
  `).run(now, nextAgentId, nextChannel, nextPeerId, nextLabel, nextDisplayTitle, nextLastMessageAt, nextTenantId, existing.id)

  return { changed: true, action: 'updated' }
}

export function upsertExternalSessionProjection({ userId, sessionKey, agentId, channel, peer, title, lastActivity }) {
  if (!userId || !sessionKey) return { changed: false, action: 'skipped', titleWritten: false }

  const now = Date.now()
  const tenantId = resolveTenantIdForUser(userId) || resolveTenantIdForAgent(agentId)
  const lastMessageAt = normalizeSessionUpdatedAt(lastActivity, null)
  const incomingTitle = readNormalizedDisplayTitle(title, peer)
  const existing = db.prepare(`
    SELECT id, user_id, agent_id, channel, peer_id, display_title, last_message_at, tenant_id
    FROM user_sessions
    WHERE session_key = ?
  `).get(sessionKey)

  if (!existing) {
    db.prepare(`
      INSERT INTO user_sessions (
        id, user_id, session_key, agent_id, channel,
        peer_id, display_title, last_message_at, updated_at, tenant_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      userId,
      sessionKey,
      agentId || null,
      channel || null,
      peer || null,
      incomingTitle || null,
      lastMessageAt,
      now,
      tenantId || null
    )
    return { changed: true, action: 'inserted', titleWritten: !!incomingTitle }
  }

  const existingTitle = readNormalizedDisplayTitle(existing.display_title, existing.peer_id)
  const canReplaceTitle = shouldBackfillDisplayTitle(existing.display_title, existing.peer_id || peer)
  const nextAgentId = agentId || existing.agent_id || null
  const nextChannel = channel || existing.channel || null
  const nextPeerId = peer || existing.peer_id || null
  const nextTitle = canReplaceTitle ? incomingTitle || existingTitle || null : existingTitle || null
  const nextTenantId = existing.tenant_id || tenantId || null
  const currentLastMessageAt = Number(existing.last_message_at) || 0
  const nextLastMessageAt = lastMessageAt == null
    ? existing.last_message_at || null
    : Math.max(currentLastMessageAt, lastMessageAt)

  const titleWritten = canReplaceTitle && !!incomingTitle && incomingTitle !== (existing.display_title || null)
  const changed =
    nextAgentId !== (existing.agent_id || null) ||
    nextChannel !== (existing.channel || null) ||
    nextPeerId !== (existing.peer_id || null) ||
    nextTitle !== (existing.display_title || null) ||
    nextTenantId !== (existing.tenant_id || null) ||
    nextLastMessageAt !== (existing.last_message_at || null)

  if (!changed) return { changed: false, action: 'unchanged', titleWritten: false }

  db.prepare(`
    UPDATE user_sessions
    SET updated_at = ?,
        agent_id = ?,
        channel = ?,
        peer_id = ?,
        display_title = ?,
        last_message_at = ?,
        tenant_id = ?
    WHERE id = ?
  `).run(now, nextAgentId, nextChannel, nextPeerId, nextTitle, nextLastMessageAt, nextTenantId, existing.id)

  return { changed: true, action: 'updated', titleWritten }
}

const _batchTrackStmts = {
  select: db.prepare('SELECT id FROM user_sessions WHERE session_key = ?'),
  update: db.prepare('UPDATE user_sessions SET agent_id = COALESCE(?, agent_id), tenant_id = COALESCE(NULLIF(tenant_id, \'\'), ?) WHERE id = ?'),
  insert: db.prepare('INSERT INTO user_sessions (id, user_id, session_key, agent_id, tenant_id) VALUES (?, ?, ?, ?, ?)'),
}

export const trackSessionsBatch = db.transaction((entries) => {
  for (const { userId, sessionKey, agentId } of entries) {
    const tenantId = resolveTenantIdForUser(userId) || resolveTenantIdForAgent(agentId)
    const existing = _batchTrackStmts.select.get(sessionKey)
    if (existing) {
      _batchTrackStmts.update.run(agentId || null, tenantId || null, existing.id)
    } else {
      _batchTrackStmts.insert.run(randomUUID(), userId, sessionKey, agentId || null, tenantId || null)
    }
  }
})

export function trackAgentForUser(userId, gatewayAgentId, name, meta) {
  const existing = db.prepare('SELECT id FROM user_agents WHERE user_id = ? AND gateway_agent_id = ?').get(userId, gatewayAgentId)
  if (!existing) {
    db.prepare(`
      INSERT INTO user_agents (id, user_id, gateway_agent_id, workspace, name, config, status, category, template_id, description, avatar, model)
      VALUES (?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), userId, gatewayAgentId, meta?.workspace ?? null, name || gatewayAgentId,
      meta?.category ?? null, meta?.templateId ?? null,
      meta?.description ?? null, meta?.avatar ?? null,
      meta?.model ?? null
    )
  }
}

export function updateUserAgentMeta(gatewayAgentId, data) {
  const fields = []
  const values = []
  const columnMap = {
    name: 'name', description: 'description', avatar: 'avatar',
    model: 'model', category: 'category', templateId: 'template_id',
  }
  for (const [key, col] of Object.entries(columnMap)) {
    if (data[key] !== undefined) {
      fields.push(`${col} = ?`)
      values.push(data[key])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(gatewayAgentId)
  db.prepare(`UPDATE user_agents SET ${fields.join(', ')} WHERE gateway_agent_id = ?`).run(...values)
}

export function getDigitalEmployees(userId) {
  return db.prepare(
    `SELECT ua.gateway_agent_id, ua.workspace, ua.name, ua.description, ua.avatar, ua.model, ua.category, ua.template_id, ua.status, ua.created_at, ua.updated_at, COALESCE(MAX(us.updated_at), ua.updated_at) AS last_active_at FROM user_agents ua LEFT JOIN user_sessions us ON us.agent_id = ua.gateway_agent_id WHERE ua.user_id = ? AND ua.status = 'active' AND ua.category IS NOT NULL GROUP BY ua.gateway_agent_id ORDER BY ua.created_at DESC`
  ).all(userId)
}

export function getAllDigitalEmployees() {
  return db.prepare(
    `SELECT ua.gateway_agent_id, ua.workspace, ua.name, ua.description, ua.avatar, ua.model, ua.category, ua.template_id, ua.status, ua.created_at, ua.updated_at, ua.user_id, COALESCE(u.display_name, u.username) AS owner_name, COALESCE(MAX(us.updated_at), ua.updated_at) AS last_active_at FROM user_agents ua LEFT JOIN users u ON ua.user_id = u.id LEFT JOIN user_sessions us ON us.agent_id = ua.gateway_agent_id WHERE ua.status = 'active' AND ua.category IS NOT NULL GROUP BY ua.gateway_agent_id ORDER BY ua.created_at DESC`
  ).all()
}

// 全局热门模板：按 template_id 聚合所有用户的创建量（公共模板统计，不泄露个体）。
// 跨用户聚合，仅返回 template_id + count，供员工市场「热门推荐」使用。
export function getHotTemplateIds(limit = 3) {
  const rows = db.prepare(
    `SELECT template_id, COUNT(*) AS count
     FROM user_agents
     WHERE status = 'active' AND category IS NOT NULL
       AND template_id IS NOT NULL AND template_id != ''
     GROUP BY template_id
     ORDER BY count DESC, MAX(created_at) DESC
     LIMIT ?`
  ).all(limit)
  return rows.map((r) => ({ templateId: r.template_id, count: Number(r.count) }))
}

export function getAgentWorkspaceForUser(userId, role, agentId, traceId = '') {
  if (typeof agentId !== 'string' || !agentId.trim()) return null

  const row = role === 'admin'
    ? db.prepare(`
      SELECT gateway_agent_id, workspace
      FROM user_agents
      WHERE gateway_agent_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(agentId.trim())
    : db.prepare(`
      SELECT gateway_agent_id, workspace
      FROM user_agents
      WHERE user_id = ? AND gateway_agent_id = ? AND status = 'active'
    `).get(userId, agentId.trim())

  if (typeof row?.workspace !== 'string' || !row.workspace.trim()) return null
  const workspace = row.workspace.trim()
  console.log(`[AgentWorkspaceDB] hit traceId=${traceId} database=${db.name} agentId=${row.gateway_agent_id} role=${role} workspace=${workspace}`)
  return { agentId: row.gateway_agent_id, workspace }
}

function normalizeGatewayAgentList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.agents)) return payload.agents
  if (Array.isArray(payload?.list)) return payload.list
  if (Array.isArray(payload?.data?.agents)) return payload.data.agents
  if (Array.isArray(payload?.data?.list)) return payload.data.list
  if (Array.isArray(payload?.result?.agents)) return payload.result.agents
  if (Array.isArray(payload?.result?.list)) return payload.result.list
  if (payload && typeof payload === 'object') return Object.values(payload)
  return []
}

function normalizeGatewayAgentWorkspace(agent) {
  if (!agent || typeof agent !== 'object') return null
  const agentId = agent.id || agent.agentId || agent.name
  const workspace = agent.workspace || agent.workspacePath || agent.rootPath
  if (typeof agentId !== 'string' || !agentId.trim()) return null
  if (typeof workspace !== 'string' || !workspace.trim()) return null
  return { agentId: agentId.trim(), workspace: workspace.trim() }
}

export function backfillAgentWorkspacesFromGatewayAgents(payload) {
  const agents = normalizeGatewayAgentList(payload)
  const normalized = agents.map(normalizeGatewayAgentWorkspace).filter(Boolean)

  if (normalized.length === 0) {
    return { scanned: agents.length, updated: 0, skipped: agents.length }
  }

  const updateWorkspace = db.prepare(`
    UPDATE user_agents
    SET workspace = ?, updated_at = ?
    WHERE gateway_agent_id = ?
      AND (workspace IS NULL OR workspace = '')
  `)

  const now = Date.now()
  let updated = 0

  const runBackfill = db.transaction((items) => {
    for (const item of items) {
      const result = updateWorkspace.run(item.workspace, now, item.agentId)
      updated += result.changes
    }
  })

  runBackfill(normalized)

  return {
    scanned: agents.length,
    updated,
    skipped: Math.max(0, agents.length - updated),
  }
}

export function getDigitalEmployeeByAgentId(agentId, userId) {
  const baseSql = `SELECT ua.*, COALESCE(MAX(us.updated_at), ua.updated_at) AS last_active_at FROM user_agents ua LEFT JOIN user_sessions us ON us.agent_id = ua.gateway_agent_id WHERE ua.gateway_agent_id = ? AND ua.status = 'active'`
  if (userId) {
    return db.prepare(baseSql + ` AND ua.user_id = ? GROUP BY ua.gateway_agent_id`).get(agentId, userId)
  }
  return db.prepare(baseSql + ` GROUP BY ua.gateway_agent_id`).get(agentId)
}

export function removeSessionForUser(userId, sessionKey) {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND session_key = ?').run(userId, sessionKey)
}

export function getChannelsByAgentId(agentId) {
  return db.prepare('SELECT * FROM user_channels WHERE agent_id = ?').all(agentId)
}

export function removeChannelsByAgentId(agentId) {
  return db.prepare('DELETE FROM user_channels WHERE agent_id = ?').run(agentId)
}

export function removeAgentForUser(userId, gatewayAgentId) {
  db.prepare('DELETE FROM skill_store_agent_skill WHERE agent_id = ?').run(gatewayAgentId)
  db.prepare('DELETE FROM user_agents WHERE user_id = ? AND gateway_agent_id = ?').run(userId, gatewayAgentId)
  db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND agent_id = ?').run(userId, gatewayAgentId)
}

export function deduplicateSharedSessions() {
  const rows = db.prepare(`
    SELECT session_key, GROUP_CONCAT(user_id) AS uids, COUNT(*) AS cnt
    FROM user_sessions
    GROUP BY session_key
    HAVING cnt > 1
  `).all()
  for (const row of rows) {
    const users = row.uids.split(',')
    for (let i = 1; i < users.length; i++) {
      db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND session_key = ?').run(users[i], row.session_key)
    }
  }
  if (rows.length > 0) {
    console.log(`[SessionDedup] Cleaned ${rows.length} shared session entries`)
  }
}

// --- User Model Providers ---

export function getUserModelProviders(userId) {
  return db.prepare('SELECT * FROM user_model_providers WHERE user_id = ? ORDER BY created_at DESC').all(userId)
}

export function getAllModelProviderOwnership() {
  return db.prepare('SELECT provider_id, user_id FROM user_model_providers').all()
}

export function getUserModelProvider(userId, providerId) {
  return db.prepare('SELECT * FROM user_model_providers WHERE user_id = ? AND provider_id = ?').get(userId, providerId)
}

export function getUserModelProviderById(id) {
  return db.prepare('SELECT * FROM user_model_providers WHERE id = ?').get(id)
}

export function createUserModelProvider(userId, providerId, config, remark = '', description = '') {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO user_model_providers (id, user_id, provider_id, config, remark, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, providerId, JSON.stringify(config || {}), remark || '', description || '')
  syncModelProvidersToOpenClawConfigs('create model provider')
  return db.prepare('SELECT * FROM user_model_providers WHERE id = ?').get(id)
}

export function updateUserModelProvider(id, updates) {
  const allowed = ['config', 'isPrimary', 'remark', 'description']
  const fields = []
  const values = []
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const dbKey = key === 'isPrimary' ? 'is_primary' : key.replace(/([A-Z])/g, '_$1').toLowerCase()
      fields.push(`${dbKey} = ?`)
      values.push(key === 'config' ? JSON.stringify(updates[key]) : updates[key])
    }
  }
  if (fields.length === 0) return null
  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)
  db.prepare(`UPDATE user_model_providers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  syncModelProvidersToOpenClawConfigs('update model provider')
  return db.prepare('SELECT * FROM user_model_providers WHERE id = ?').get(id)
}

export function deleteUserModelProvider(id) {
  db.prepare('DELETE FROM user_model_providers WHERE id = ?').run(id)
  syncModelProvidersToOpenClawConfigs('delete model provider')
}

export function deleteUserModelProviderByProviderId(userId, providerId) {
  db.prepare('DELETE FROM user_model_providers WHERE user_id = ? AND provider_id = ?').run(userId, providerId)
  syncModelProvidersToOpenClawConfigs('delete model provider by provider id')
}

export function setUserModelPrimary(userId, providerId) {
  db.prepare('UPDATE user_model_providers SET is_primary = 0, updated_at = ? WHERE user_id = ?').run(Date.now(), userId)
  db.prepare('UPDATE user_model_providers SET is_primary = 1, updated_at = ? WHERE user_id = ? AND provider_id = ?').run(Date.now(), userId, providerId)
  syncModelProvidersToOpenClawConfigs('set primary model provider')
}

export function getAdminUserIds() {
  const rows = db.prepare('SELECT id FROM users WHERE role = ?').all('admin')
  return rows.map(r => r.id)
}

export function getAllUserModelProviders() {
  return db.prepare('SELECT * FROM user_model_providers ORDER BY created_at DESC').all()
}

export function getVisibleUserModelProviders(userId) {
  const adminIds = getAdminUserIds()
  if (adminIds.length === 0) {
    return db.prepare('SELECT * FROM user_model_providers WHERE user_id = ? ORDER BY created_at DESC').all(userId)
  }
  const placeholders = adminIds.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM user_model_providers WHERE user_id = ? OR user_id IN (${placeholders}) ORDER BY created_at DESC`
  ).all(userId, ...adminIds)
}

export function getAgentsWithoutModel() {
  return db.prepare("SELECT id, user_id, model FROM user_agents WHERE model IS NULL OR model = ''").all()
}

export function backfillAgentModel(modelRef) {
  if (!modelRef) return 0
  const result = db.prepare("UPDATE user_agents SET model = ?, updated_at = ? WHERE model IS NULL OR model = ''").run(modelRef, Date.now())
  return result.changes
}
