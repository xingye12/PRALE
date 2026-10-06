// In-memory stand-in for server/user-manager.js, mounted onto the real
// server/core/session-sync.js only for the duplicate-event fixture.
//
// Mirrors the observable contract of the real upsertSyncedUserSession
// (server/user-manager.js:614-689): an identical replay of a session update
// returns { changed: false, action: 'unchanged' } and performs no write, so a
// replayed event can neither bump the sync counters nor re-apply usage.

const rows = new Map()
const writeLog = []
const usage = new Map()

let ownedAgentIds = []

export function __reset() {
  rows.clear()
  writeLog.length = 0
  usage.clear()
  ownedAgentIds = []
}

export function __setOwnedAgentIds(ids) {
  ownedAgentIds = [...ids]
}

export function __writeCount() {
  return writeLog.length
}

export function __writeLog() {
  return writeLog.map(entry => ({ ...entry }))
}

export function __usageFor(sessionKey) {
  return usage.get(sessionKey) || null
}

export function getAllGatewayAgentIds() {
  return [...ownedAgentIds]
}

export function getUserOwnedAgentIds() {
  return [...ownedAgentIds]
}

// Absolute-set usage, matching session-usage-cache.js _persistOwnerScopedUpdate
// (UPDATE ... SET token_total = ?) rather than a read-modify-write increment.
function applyUsage(sessionKey, msgTotal) {
  usage.set(sessionKey, { sessionKey, msgTotal: Number(msgTotal) || 0, applied: (usage.get(sessionKey)?.applied || 0) + 1 })
}

export function upsertSyncedUserSession({ userId, sessionKey, agentId, channel, peer, label, lastActivity }) {
  if (!userId || !sessionKey) return { changed: false, action: 'skipped' }

  const lastMessageAt = normalizeSessionUpdatedAt(lastActivity, null)
  const existing = rows.get(sessionKey) || null

  if (!existing) {
    rows.set(sessionKey, {
      userId,
      sessionKey,
      agentId: agentId || null,
      channel: channel || null,
      peer: peer || null,
      label: label || null,
      lastMessageAt,
    })
    writeLog.push({ action: 'inserted', sessionKey, at: Date.now() })
    applyUsage(sessionKey, lastMessageAt ? 1 : 0)
    return { changed: true, action: 'inserted' }
  }

  const nextAgentId = agentId || existing.agentId || null
  const nextChannel = channel || existing.channel || null
  const nextPeerId = peer || existing.peer || null
  const nextLabel = existing.label || label || null
  const nextLastMessageAt = lastMessageAt == null
    ? existing.lastMessageAt || null
    : Math.max(Number(existing.lastMessageAt) || 0, lastMessageAt)

  const changed =
    nextAgentId !== (existing.agentId || null) ||
    nextChannel !== (existing.channel || null) ||
    nextPeerId !== (existing.peer || null) ||
    nextLabel !== (existing.label || null) ||
    nextLastMessageAt !== (existing.lastMessageAt || null)

  // Negative control: DUPLICATE_FIXTURE_DISABLE_DEDUP=1 simulates a regression
  // where a replayed update is reapplied, so the fixture must fail.
  if (!changed && process.env.DUPLICATE_FIXTURE_DISABLE_DEDUP !== '1') {
    return { changed: false, action: 'unchanged' }
  }

  rows.set(sessionKey, { ...existing, agentId: nextAgentId, channel: nextChannel, peer: nextPeerId, label: nextLabel, lastMessageAt: nextLastMessageAt })
  writeLog.push({ action: 'updated', sessionKey, at: Date.now() })
  applyUsage(sessionKey, 1)
  return { changed: true, action: 'updated' }
}

function normalizeSessionUpdatedAt(value, fallback) {
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
