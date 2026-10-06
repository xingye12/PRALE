// Shared in-memory doubles for the duplicate-event contract fixture.
//
// Scope note: `vitest` and `better-sqlite3` are not installed in this offline
// workspace, so the fixture drives the *real* production modules
// (server/core/session-usage-cache.js, server/core/usage-sync.js,
// server/core/session-sync.js) and replaces only their module boundaries:
//
//   server/core/session-usage-cache.js  -> default export (the SQLite db handle)
//   server/core/usage-sync.js           -> gateway-client / multi-tenant-gateway / sse
//   server/core/session-sync.js         -> ../user-manager.js
//
// The db double implements exactly the statements those modules issue on the
// duplicate-event path: the owner-scoped UPDATE user_sessions (mirroring
// `_persistOwnerScopedUpdate`), the ownership SELECT used by
// `batchUpdateMatchedGatewayUsage`, and the `getSessionOwner` lookup.

const SEP = '\u0000'
const k = (userId, sessionKey) => `${userId}${SEP}${sessionKey}`

const usageRows = new Map() // key: user_id + session_key -> row (single physical row per composite key)
const sessionMeta = new Map() // key: session_key -> metadata written by upsertSyncedUserSession
const ownedAgents = new Map() // key: userId -> [agentId]
const statements = [] // every db.prepare() result, in order

// ---------------------------------------------------------------------------
// Introspection helpers used by the fixture assertions
// ---------------------------------------------------------------------------

export function resetAll() {
  usageRows.clear()
  sessionMeta.clear()
  ownedAgents.clear()
  statements.length = 0
}

export function preparedStatements() {
  return statements.slice()
}

export function findStatement(fragment) {
  return statements.find((s) => s.sql.includes(fragment)) || null
}

export function updateStatements() {
  return statements.filter((s) => /UPDATE\s+user_sessions/i.test(s.sql))
}

export function getUsageRow(userId, sessionKey) {
  return usageRows.get(k(userId, sessionKey)) || null
}

export function usageRowsForSession(sessionKey) {
  return [...usageRows.values()].filter((r) => r.session_key === sessionKey)
}

export function seedUsageRow(row) {
  const full = {
    id: row.id || `row-${usageRows.size + 1}`,
    agent_id: null,
    model: null,
    model_provider: null,
    token_input: 0,
    token_output: 0,
    token_cache_read: 0,
    token_cache_write: 0,
    token_total: 0,
    cost_total: 0,
    msg_total: 0,
    msg_user: 0,
    msg_assistant: 0,
    msg_tool_calls: 0,
    msg_tool_results: 0,
    msg_errors: 0,
    tool_usage_json: null,
    usage_synced_at: null,
    updated_at: null,
    ...row,
  }
  usageRows.set(k(full.user_id, full.session_key), full)
  return full
}

// ---------------------------------------------------------------------------
// SQLite double
// ---------------------------------------------------------------------------

function parseUpdateColumns(sql) {
  const setClause = String(sql).match(/SET([\s\S]*?)\s*WHERE/i)?.[1] || ''
  return setClause.split(',').map((part) => ({
    column: part.split('=')[0].trim(),
    placeholders: (part.match(/\?/g) || []).length,
  }))
}

const db = {
  prepare(sql) {
    const text = String(sql)
    const stmt = {
      sql: text,
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    }
    statements.push(stmt)

    if (/^\s*UPDATE\s+user_sessions\s+SET/i.test(text)) {
      const binds = parseUpdateColumns(text)
      stmt.run = (...args) => {
        const userId = args[args.length - 2]
        const sessionKey = args[args.length - 1]
        const row = usageRows.get(k(userId, sessionKey))
        // Zero matching owner rows => changes === 0 => caller treats it as a skip.
        if (!row) return { changes: 0 }
        let cursor = 0
        for (const { column, placeholders } of binds) {
          const value = args[cursor]
          cursor += placeholders
          // Mirror "CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE <existing> END".
          if ((column === 'model' || column === 'model_provider') && (value === null || value === '')) continue
          row[column] = value
        }
        return { changes: 1 }
      }
    } else if (/SELECT\s+user_id,\s*session_key\s+FROM\s+user_sessions/i.test(text)) {
      stmt.all = (...args) =>
        [...usageRows.values()]
          .filter((r) =>
            args.length >= 2
              ? r.user_id === args[0] && r.session_key === args[1]
              : r.session_key === args[0],
          )
          .map((r) => ({ user_id: r.user_id, session_key: r.session_key }))
    } else if (/SELECT\s+user_id\s+FROM\s+user_sessions\s+WHERE\s+session_key\s*=\s*\?/i.test(text)) {
      stmt.get = (sessionKey) => {
        const row = [...usageRows.values()].find((r) => r.session_key === sessionKey)
        return row ? { user_id: row.user_id } : undefined
      }
    }

    return stmt
  },
}

export default db

// ---------------------------------------------------------------------------
// usage-sync.js boundaries: gateway-client.js / multi-tenant-gateway.js / sse.js
// ---------------------------------------------------------------------------

export const gatewayState = {
  usageCalls: [],
  usageResponse: { sessions: [] },
  targets: null, // null => single-gateway path
}

export async function callGatewayUsage(params = {}) {
  gatewayState.usageCalls.push(params)
  return JSON.parse(JSON.stringify(gatewayState.usageResponse))
}

export async function callGatewayUsageForTarget() {
  throw new Error('callGatewayUsageForTarget is not exercised by the duplicate-event fixture')
}

export async function getGatewayHttpTargetsForAllTenants() {
  return gatewayState.targets
}

export const sseBroadcasts = []

export function broadcastSSE(...args) {
  sseBroadcasts.push(args)
}

// ---------------------------------------------------------------------------
// session-sync.js boundary: ../user-manager.js
//
// upsertSyncedUserSession mirrors the real implementation's idempotency
// (server/user-manager.js: existing row keyed by session_key, `Math.max` on
// last_message_at, `{ changed: false, action: 'unchanged' }` when nothing
// differs, so a replayed session update never inserts a duplicate row).
// ---------------------------------------------------------------------------

export function setOwnedAgents(userId, ids) {
  ownedAgents.set(userId, ids)
}

export function getAllGatewayAgentIds() {
  return [...ownedAgents.values()].flat()
}

export function getUserOwnedAgentIds(userId) {
  return ownedAgents.get(userId) || []
}

export function upsertSyncedUserSession({ userId, sessionKey, agentId, channel, peer, label, lastActivity }) {
  if (!userId || !sessionKey) return { changed: false, action: 'skipped' }

  const incomingLastActivity = Number.isFinite(Number(lastActivity)) ? Number(lastActivity) : null
  const existing = sessionMeta.get(sessionKey)

  if (!existing) {
    sessionMeta.set(sessionKey, {
      user_id: userId,
      session_key: sessionKey,
      agent_id: agentId || null,
      channel: channel || null,
      peer_id: peer || null,
      label: label || null,
      last_message_at: incomingLastActivity,
    })
    // The row inserted by metadata sync is the same physical row the usage
    // cache later updates; usage_synced_at stays NULL until a usage sync stamps it.
    seedUsageRow({
      user_id: userId,
      session_key: sessionKey,
      agent_id: agentId || null,
      usage_synced_at: null,
    })
    return { changed: true, action: 'inserted' }
  }

  const nextAgentId = agentId || existing.agent_id || null
  const nextChannel = channel || existing.channel || null
  const nextPeerId = peer || existing.peer_id || null
  const nextLabel = existing.label || label || null
  const currentLastMessageAt = Number(existing.last_message_at) || 0
  const nextLastMessageAt =
    incomingLastActivity == null ? existing.last_message_at || null : Math.max(currentLastMessageAt, incomingLastActivity)

  const changed =
    nextAgentId !== (existing.agent_id || null) ||
    nextChannel !== (existing.channel || null) ||
    nextPeerId !== (existing.peer_id || null) ||
    nextLabel !== (existing.label || null) ||
    nextLastMessageAt !== (existing.last_message_at || null)

  if (!changed) return { changed: false, action: 'unchanged' }

  existing.agent_id = nextAgentId
  existing.channel = nextChannel
  existing.peer_id = nextPeerId
  existing.label = nextLabel
  existing.last_message_at = nextLastMessageAt
  return { changed: true, action: 'updated' }
}
