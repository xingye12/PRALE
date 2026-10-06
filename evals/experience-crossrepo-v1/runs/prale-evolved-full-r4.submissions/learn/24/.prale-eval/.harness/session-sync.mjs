import {
  getAllGatewayAgentIds,
  getUserOwnedAgentIds,
  upsertSyncedUserSession,
} from './user-manager-stub.mjs'

export const DEFAULT_SESSION_SYNC_OPTIONS = Object.freeze({
  perAgentLimit: 50,
  cooldownMs: 60_000,
  overallTimeoutMs: 8_000,
  gatewayConcurrency: 2,
})

const inFlightByUserId = new Map()
const lastSyncAtByUserId = new Map()

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function extractSessions(payload) {
  if (Array.isArray(payload)) return payload
  const row = asRecord(payload)
  if (!row) return []
  if (Array.isArray(row.sessions)) return row.sessions
  if (Array.isArray(row.items)) return row.items
  if (Array.isArray(row.list)) return row.list
  if (Array.isArray(row.data)) return row.data
  const data = asRecord(row.data)
  if (Array.isArray(data?.sessions)) return data.sessions
  if (Array.isArray(data?.items)) return data.items
  return []
}

function readString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function readExplicitMessageActivity(row) {
  return row.lastMessageAt
    ?? row.last_message_at
    ?? row.lastActivity
    ?? row.last_activity
    ?? row.updatedAt
    ?? row.updated_at
    ?? row.updated
    ?? row.createdAt
    ?? row.created_at
    ?? null
}

export function extractAgentIdFromSessionKey(sessionKey) {
  return sessionKey.match(/^agent:([^:]+):/)?.[1] || ''
}

export function normalizeGatewaySessionForSync(value, fallbackAgentId = '') {
  const row = asRecord(value)
  if (!row) return null

  const sessionKey = readString(row.key, row.sessionKey, row.session_key, row.id)
  if (!sessionKey) return null

  const agentId = readString(row.agentId, row.agent_id, row.agent, extractAgentIdFromSessionKey(sessionKey), fallbackAgentId)
  if (!agentId) return null

  return {
    sessionKey,
    agentId,
    channel: readString(row.channel, row.channelKey, row.channel_key),
    peer: readString(row.peer, row.peerId, row.peer_id, row.userId, row.user_id),
    label: readString(row.displayTitle, row.display_title, row.label, row.title, row.name),
    lastActivity: readExplicitMessageActivity(row),
  }
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = []
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`session sync timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function getAgentIdsForUser(userId, role) {
  const ids = role === 'admin' ? getAllGatewayAgentIds() : getUserOwnedAgentIds(userId)
  return [...new Set(ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
}

async function listGatewaySessionsForAgent({ agentId, gatewayRpc, perAgentLimit }) {
  const result = await gatewayRpc('sessions.list', { agentId, limit: perAgentLimit })
  if (!result?.ok) {
    const message = result?.error?.message || result?.error || `sessions.list failed for ${agentId}`
    throw new Error(message)
  }
  return extractSessions(result.payload)
}

export async function syncUserSessionsFromGateway({
  userId,
  role,
  gatewayRpc,
  recentlyDeletedSessionKeys = new Set(),
  perAgentLimit = DEFAULT_SESSION_SYNC_OPTIONS.perAgentLimit,
  overallTimeoutMs = DEFAULT_SESSION_SYNC_OPTIONS.overallTimeoutMs,
  gatewayConcurrency = DEFAULT_SESSION_SYNC_OPTIONS.gatewayConcurrency,
}) {
  if (!userId || typeof gatewayRpc !== 'function') {
    return { changed: 0, scanned: 0, agents: 0 }
  }

  const run = async () => {
    const agentIds = getAgentIdsForUser(userId, role)
    if (agentIds.length === 0) {
      console.info(`[SessionSync] user ${userId} skipped: no owned agents`)
      return { changed: 0, scanned: 0, agents: 0 }
    }

    console.info(`[SessionSync] user ${userId} started: agents=${agentIds.length}, perAgentLimit=${perAgentLimit}, pagination=disabled`)

    const allowedAgentIds = new Set(agentIds)
    let changed = 0
    let inserted = 0
    let updated = 0
    let scanned = 0

    await mapWithConcurrency(agentIds, gatewayConcurrency, async (agentId) => {
      let rawSessions = []
      try {
        rawSessions = await listGatewaySessionsForAgent({ agentId, gatewayRpc, perAgentLimit })
        console.info(`[SessionSync] user ${userId} scoped agent ${agentId} listed: sessions=${rawSessions.length}, limit=${perAgentLimit}`)
      } catch (err) {
        console.warn(`[SessionSync] agent ${agentId} skipped: ${err.message}`)
        return
      }

      for (const raw of rawSessions) {
        scanned += 1
        const session = normalizeGatewaySessionForSync(raw, agentId)
        if (!session) continue
        if (!allowedAgentIds.has(session.agentId)) continue
        if (recentlyDeletedSessionKeys.has(session.sessionKey)) continue

        const result = upsertSyncedUserSession({ userId, ...session })
        if (result.changed) {
          changed += 1
          if (result.action === 'inserted') inserted += 1
          if (result.action === 'updated') updated += 1
        }
      }
    })

    console.info(`[SessionSync] user ${userId} completed: agents=${agentIds.length}, scanned=${scanned}, inserted=${inserted}, updated=${updated}, changed=${changed}`)
    return { changed, inserted, updated, scanned, agents: agentIds.length }
  }

  return withTimeout(run(), overallTimeoutMs)
}

export function scheduleUserSessionSync({
  userId,
  role,
  gatewayRpc,
  cooldownMs = DEFAULT_SESSION_SYNC_OPTIONS.cooldownMs,
  ...options
}) {
  if (!userId) return Promise.resolve({ changed: 0, skipped: true })

  const now = Date.now()
  const lastSyncAt = lastSyncAtByUserId.get(userId) || 0
  if (now - lastSyncAt < cooldownMs) {
    console.info(`[SessionSync] user ${userId} skipped: cooldown`)
    return Promise.resolve({ changed: 0, skipped: true, reason: 'cooldown' })
  }

  const existing = inFlightByUserId.get(userId)
  if (existing) {
    console.info(`[SessionSync] user ${userId} skipped: already in flight`)
    return existing
  }

  const promise = syncUserSessionsFromGateway({ userId, role, gatewayRpc, ...options })
    .then((result) => {
      lastSyncAtByUserId.set(userId, Date.now())
      return result
    })
    .catch((err) => {
      console.error(`[SessionSync] user ${userId} failed: ${err.message}`)
      return { changed: 0, error: err.message }
    })
    .finally(() => {
      inFlightByUserId.delete(userId)
    })

  inFlightByUserId.set(userId, promise)
  return promise
}

export function resetSessionSyncStateForTests() {
  inFlightByUserId.clear()
  lastSyncAtByUserId.clear()
}
