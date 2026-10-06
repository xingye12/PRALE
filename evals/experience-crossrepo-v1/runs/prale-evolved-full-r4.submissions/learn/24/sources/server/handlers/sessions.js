// Session routes and ownership helpers
import { authMiddleware } from '../core/auth.js'
import {
  getUserSessions, createUserSession, deleteUserSession,
  getUserOwnedSessionKeys, getUserOwnedAgentIds,
  trackSessionForUser,
} from '../user-manager.js'
import { deleteSessionMessages, readEarliestEffectiveUserMessages } from '../message-store.js'
import { scheduleUserSessionSync } from '../core/session-sync.js'
import { fetchHistoryFromGateway } from '../core/gateway-client.js'
import { batchUpdateMatchedGatewayUsage } from '../core/session-usage-cache.js'
import { repairSessionLastMessageAtFromStore } from '../services/session-activity-service.js'
import {
  backfillExternalSessionTitles,
  isKnownExternalSession,
  parseExternalSessionKey,
} from '../services/external-session-projection.js'
import {
  normalizeDisplayTitleCandidate,
  resolveSessionDisplayTitle,
  shouldBackfillDisplayTitle,
  summarizeMessage,
} from '../services/session-title-service.js'
import { generateSafeTitle } from '../utils/index.js'
import { listCronSessionBindings } from '../cron-manager.js'

export const recentlyDeletedSessions = new Set()
const SESSION_USAGE_REFRESH_COOLDOWN_MS = 15_000
const sessionUsageRefreshState = new Map()

function requestedSessionKeys(query) {
  const values = Array.isArray(query.sessionKey) ? query.sessionKey : [query.sessionKey]
  return [...new Set(values
    .flatMap(value => typeof value === 'string' ? value.split(',') : [])
    .map(value => value.trim())
    .filter(Boolean))]
    .slice(0, 20)
}

async function refreshSessionUsage(sessionKeys, gatewayRpc) {
  await Promise.allSettled(sessionKeys.map(async (sessionKey) => {
    const current = sessionUsageRefreshState.get(sessionKey)
    if (current?.promise) return current.promise
    if (current && Date.now() - current.updatedAt < SESSION_USAGE_REFRESH_COOLDOWN_MS) return

    const state = current || { updatedAt: 0, promise: null }
    const promise = (async () => {
      const result = await gatewayRpc('sessions.usage', { key: sessionKey, limit: 1 })
      if (!result?.ok) throw new Error(result?.error || 'sessions.usage failed')
      batchUpdateMatchedGatewayUsage(result.payload)
      state.updatedAt = Date.now()
    })().catch(error => {
      console.warn(`[Sessions] usage refresh failed for ${sessionKey}:`, error.message)
    }).finally(() => {
      state.promise = null
    })

    state.promise = promise
    sessionUsageRefreshState.set(sessionKey, state)
    return promise
  }))
}

export function isSessionOwned(sessionKey, userId) {
  if (!sessionKey) return false
  if (recentlyDeletedSessions.has(sessionKey)) return false
  const keysSet = new Set(getUserOwnedSessionKeys(userId))
  if (keysSet.has(sessionKey)) return true
  const agentId = sessionKey.match(/^agent:([^:]+):/)?.[1]
  if (agentId) {
    const agentIds = getUserOwnedAgentIds(userId)
    if (agentIds.includes(agentId)) {
      trackSessionForUser(userId, sessionKey, agentId)
      keysSet.add(sessionKey)
      return true
    }
  }
  return false
}

export function filterOwnedSessions(list, userId) {
  if (!Array.isArray(list)) return list
  return list.filter(s => {
    const key = s.key || s.sessionKey || ''
    return key && isSessionOwned(key, userId)
  })
}

export function getLocalSessionTitles(userId) {
  const rows = db.prepare(`
    SELECT session_key, COALESCE(display_title, label) AS title
    FROM user_sessions
    WHERE user_id = ? AND COALESCE(display_title, label) IS NOT NULL
  `).all(userId)
  return new Map(
    rows
      .map(r => [r.session_key, normalizeDisplayTitleCandidate(r.title)])
      .filter(([, title]) => !!title)
  )
}

export function getAllSessionTitles() {
  const rows = db.prepare(`
    SELECT session_key, COALESCE(display_title, label) AS title
    FROM user_sessions
    WHERE COALESCE(display_title, label) IS NOT NULL
  `).all()
  return new Map(
    rows
      .map(r => [r.session_key, normalizeDisplayTitleCandidate(r.title)])
      .filter(([, title]) => !!title)
  )
}

function shouldBackfillSessionTitle(row) {
  return shouldBackfillDisplayTitle(row?.display_title, row?.peer_id) ||
    shouldBackfillDisplayTitle(row?.label, row?.peer_id) ||
    String(row?.display_title || row?.label || '').trim().startsWith('[Bootstrap')
}

function extractText(value) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        if (typeof item.text === 'string') return item.text
        if (typeof item.content === 'string') return item.content
        if (typeof item.question === 'string') return item.question
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (!value || typeof value !== 'object') return ''
  for (const key of ['question', 'prompt', 'input', 'text', 'content', 'message']) {
    const text = extractText(value[key])
    if (text) return text
  }
  return ''
}

function extractUserContent(message) {
  const role = String(message?.role || message?.rawContent?.role || '').trim().toLowerCase()
  if (role && role !== 'user') return ''
  const rawContent = extractText(message?.rawContent?.content) ||
    extractText(message?.rawContent)
  return rawContent || extractText(message?.content)
}

function firstUserContentFromMessages(messages) {
  if (!Array.isArray(messages)) return ''
  for (const message of messages) {
    const content = extractUserContent(message)
    if (normalizeDisplayTitleCandidate(content)) return content
  }
  return ''
}

function titleFromUserContent(row, content) {
  const parsed = parseExternalSessionKey(row.session_key)
  if (parsed && isKnownExternalSession(row.session_key)) {
    return normalizeDisplayTitleCandidate(resolveSessionDisplayTitle({
      channel: row.channel || parsed.channel,
      peerProfile: null,
      firstUserMessage: content,
      isGroup: parsed.kind === 'group',
    }))
  }
  return generateSafeTitle(summarizeMessage(content))
}

async function backfillSessionTitlesFromHistory(sessionRows) {
  const candidates = (Array.isArray(sessionRows) ? sessionRows : []).filter(shouldBackfillSessionTitle)
  if (candidates.length === 0) {
    return { checked: 0, repaired: 0, skipped: 0 }
  }

  const messages = await readEarliestEffectiveUserMessages(candidates.map((row) => row.session_key))
  const bySessionKey = new Map(messages.map((row) => [row.session_key, row]))
  const update = db.prepare(`
    UPDATE user_sessions
    SET label = ?, display_title = ?, updated_at = ?
    WHERE id = ?
  `)

  let repaired = 0
  let skipped = 0
  const now = Date.now()
  for (const row of candidates) {
    const message = bySessionKey.get(row.session_key)
    let content = String(message?.content || '').trim()
    if (!content) {
      const gatewayMessages = await fetchHistoryFromGateway(row.session_key, 50).catch((err) => {
        console.warn('[Sessions] gateway title backfill skipped:', row.session_key, err.message)
        return []
      })
      content = firstUserContentFromMessages(gatewayMessages)
    }
    if (!content) {
      skipped += 1
      continue
    }

    const title = titleFromUserContent(row, content)
    if (!title) {
      skipped += 1
      continue
    }

    if ((row.label || '') === title && (row.display_title || '') === title) {
      continue
    }

    update.run(title, title, now, row.id)
    repaired += 1
  }

  return { checked: candidates.length, repaired, skipped }
}

function toIsoTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  const millis = numeric > 1e12 ? numeric : numeric * 1000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function applyMessageActivityRepair(localSessions, timestamps = []) {
  if (!timestamps.length) return localSessions
  const repaired = new Map()
  for (const item of timestamps) {
    const iso = toIsoTimestamp(item.last_message_at)
    const millis = iso ? new Date(iso).getTime() : null
    if (millis != null && Number.isFinite(millis)) {
      repaired.set(item.session_key, millis)
    }
  }
  if (repaired.size === 0) return localSessions
  return localSessions.map((session) => {
    const lastMessageAt = repaired.get(session.session_key)
    return lastMessageAt == null
      ? session
      : { ...session, last_message_at: lastMessageAt }
  })
}

function normalizeLocalSession(local, localTitles, cronBinding) {
  const key = local.session_key
  const agentId = key.match(/^agent:([^:]+):/)?.[1] || local.agent_id || 'main'
  const channel = key.match(/^agent:[^:]+:([^:]+):/)?.[1] || local.channel || 'main'
  const peer = local.peer_id || key.match(/^agent:[^:]+:[^:]+:[^:]+:(.+)$/)?.[1] || 'user'
  const lastMessageAt = toIsoTimestamp(local.last_message_at)
  const messageCount = Math.max(0, Number(local.msg_total) || 0)
  const totalInput = Math.max(0, Number(local.token_input) || 0)
  const totalOutput = Math.max(0, Number(local.token_output) || 0)
  const cacheRead = Math.max(0, Number(local.token_cache_read) || 0)
  const cacheWrite = Math.max(0, Number(local.token_cache_write) || 0)
  const hasTokenUsage = totalInput > 0 || totalOutput > 0 || cacheRead > 0 || cacheWrite > 0
  const displayTitle = normalizeDisplayTitleCandidate(cronBinding?.display_name) ||
    normalizeDisplayTitleCandidate(local.display_title) ||
    localTitles.get(key) ||
    normalizeDisplayTitleCandidate(local.label) ||
    ''

  return {
    key,
    agentId,
    channel,
    peer,
    peerId: local.peer_id || peer,
    messageCount,
    lastActivity: lastMessageAt || '',
    lastMessageAt: lastMessageAt || undefined,
    model: undefined,
    label: displayTitle,
    displayTitle,
    tokenUsage: hasTokenUsage
      ? {
          totalInput,
          totalOutput,
          cacheRead,
          cacheWrite,
        }
      : undefined,
    sessionKind: cronBinding ? 'cron' : undefined,
    cronJobId: cronBinding?.job_id || undefined,
    cronJobName: cronBinding?.display_name || undefined,
  }
}

export function createSessionRoutes(app, { gatewayRpc } = {}) {
  app.get('/api/user/sessions', authMiddleware, (req, res) => {
    const sessions = getUserSessions(req.currentUser.id)
    res.json({ ok: true, sessions })
  })

  app.post('/api/user/sessions', authMiddleware, (req, res) => {
    const session = createUserSession(req.currentUser.id, req.body)
    res.json({ ok: true, session })
  })

  app.delete('/api/user/sessions/:sessionKey', authMiddleware, async (req, res) => {
    deleteUserSession(req.currentUser.id, req.params.sessionKey)
    await deleteSessionMessages(req.params.sessionKey).catch(err =>
      console.error('[MessageStore] user session delete cleanup error:', err.message)
    )
    res.json({ ok: true })
  })

  app.get('/api/sessions', authMiddleware, async (req, res) => {
    try {
      const userId = req.currentUser.id
      const isAdmin = req.currentUser.role === 'admin'
      const shouldRefreshUsage = req.query.refreshUsage === '1' || req.query.refreshUsage === 'true'
      if (shouldRefreshUsage && typeof gatewayRpc === 'function') {
        const sessionKeys = requestedSessionKeys(req.query)
          .filter(sessionKey => isAdmin || isSessionOwned(sessionKey, userId))
        if (sessionKeys.length > 0) {
          await refreshSessionUsage(sessionKeys, gatewayRpc)
        }
      }

      const hasExternalTitleCandidates = db.prepare(`
        SELECT 1
        FROM user_sessions
        WHERE session_key LIKE 'agent:%'
          AND (
            LOWER(COALESCE(display_title, '')) IN ('', 'openclaw web backend', 'main', 'new chat', 'new conversation', 'new session')
            OR COALESCE(display_title, '') IN ('新对话', '新会话', '新對話', '新會話')
            OR LOWER(COALESCE(label, '')) IN ('', 'openclaw web backend', 'main', 'new chat', 'new conversation', 'new session')
            OR COALESCE(label, '') IN ('新对话', '新会话', '新對話', '新會話')
            OR display_title = peer_id
            OR label = peer_id
          )
        LIMIT 1
      `).get()
      if (hasExternalTitleCandidates) {
        await backfillExternalSessionTitles().catch(err =>
          console.warn('[Sessions] external title backfill skipped:', err.message)
        )
      }

      // Always read from local SQLite — no more Gateway polling
      let localSessions = isAdmin
        ? db.prepare('SELECT * FROM user_sessions ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC').all()
        : getUserSessions(userId)

      const titleRepairResult = await backfillSessionTitlesFromHistory(localSessions)
      if (titleRepairResult.repaired > 0) {
        localSessions = isAdmin
          ? db.prepare('SELECT * FROM user_sessions ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC').all()
          : getUserSessions(userId)
      }

      const repairResult = await repairSessionLastMessageAtFromStore(localSessions.map(local => local.session_key))
      localSessions = applyMessageActivityRepair(localSessions, repairResult.timestamps || [])
        .sort((a, b) => {
          const aTime = Number(a.last_message_at || 0)
          const bTime = Number(b.last_message_at || 0)
          return bTime - aTime
        })

      const localTitles = isAdmin ? getAllSessionTitles() : getLocalSessionTitles(userId)
      const cronBindings = listCronSessionBindings({ isAdmin, userId })
      const cronBindingsBySession = new Map(cronBindings.map(binding => [binding.session_key, binding]))

      const sessions = localSessions.map(local => normalizeLocalSession(
        local,
        localTitles,
        cronBindingsBySession.get(local.session_key),
      ))

      res.json({
        ok: true,
        payload: {
          sessions,
          total: sessions.length,
          page: 1,
          limit: sessions.length,
          hasMore: false,
        }
      })

      if (typeof gatewayRpc === 'function') {
        console.info(`[SessionSync] user ${userId} scheduled from /api/sessions`)
        setImmediate(() => {
          void scheduleUserSessionSync({
            userId,
            role: req.currentUser.role,
            gatewayRpc,
            recentlyDeletedSessionKeys: recentlyDeletedSessions,
          })
        })
      }
      return
    } catch (err) {
      console.error('[Sessions] list error:', err.message)
      return res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })
}

import db from '../database.js'
