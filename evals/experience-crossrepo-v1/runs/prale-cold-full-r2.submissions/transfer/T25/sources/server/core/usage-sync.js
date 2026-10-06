import { callGatewayUsage, callGatewayUsageForTarget } from './gateway-client.js'
import { getGatewayHttpTargetsForAllTenants } from './multi-tenant-gateway.js'
import {
  batchUpdateMatchedGatewayUsage,
  getSessionOwner,
  updateSessionUsageForUser,
} from './session-usage-cache.js'
import { broadcastSSE } from './sse.js'

const DEFAULT_USAGE_SYNC_DELAY_MS = 1000
const DEFAULT_USAGE_SYNC_LIMIT = 1000

const pendingSessionTimers = new Map()
const inFlightSessionSyncs = new Map()
let setTimeoutFn = setTimeout
let clearTimeoutFn = clearTimeout

function _emptyReport() {
  return {
    scanned: 0,
    updated: 0,
    skippedUnmatched: 0,
    skippedConflict: 0,
    failed: 0,
    durationMs: 0,
  }
}

function resolveMessageCount(session) {
  const usage = session?.usage && typeof session.usage === 'object' ? session.usage : {}
  const messageCounts = usage.messageCounts || usage.message_counts
  const candidates = [
    messageCounts?.total,
    messageCounts?.count,
    usage.messageCount,
    usage.message_count,
    session?.messageCount,
    session?.message_count,
  ]
  for (const value of candidates) {
    const count = Number(value)
    if (Number.isFinite(count) && count >= 0) return Math.floor(count)
  }
  return undefined
}

function broadcastSessionUsageUpdate(sessionKey, session, report) {
  if (!sessionKey || report?.updated <= 0) return
  const messageCount = resolveMessageCount(session)
  if (messageCount === undefined) return
  const payload = {
    sessionKey,
    messageCount,
    usageSyncedAt: Date.now(),
    ...(session?.tenantId ? { tenantId: session.tenantId } : {}),
  }
  broadcastSSE({ type: 'event', event: 'session.usage.updated', payload }, payload)
}

export async function syncUsageFromGatewayOnStartup() {
  const startedAt = Date.now()
  try {
    const targets = await getGatewayHttpTargetsForAllTenants()
    // 单实例 targets === null → 退回单 gateway(A 原行为,零退化)
    if (!targets) {
      const gatewayResult = await callGatewayUsage({ limit: DEFAULT_USAGE_SYNC_LIMIT })
      const report = batchUpdateMatchedGatewayUsage(gatewayResult)
      console.log('[UsageSync] startup report:', report)
      return report
    }
    // 多实例 fan-out:遍历所有租户 target,合并 sessions
    const results = await Promise.allSettled(
      targets.map(target => callGatewayUsageForTarget(target, { limit: DEFAULT_USAGE_SYNC_LIMIT })),
    )
    const merged = { sessions: [] }
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value?.sessions)) {
        merged.sessions.push(...r.value.sessions)
      }
    }
    const report = batchUpdateMatchedGatewayUsage(merged)
    console.log('[UsageSync] startup report (multi-tenant):', report)
    return report
  } catch (error) {
    const report = { ..._emptyReport(), failed: 1, durationMs: Date.now() - startedAt }
    console.warn('[UsageSync] startup failed:', error?.message || error)
    return report
  }
}

export function scheduleSessionUsageSync(sessionKey, options = {}) {
  if (!sessionKey) return null
  const delayMs = Number.isFinite(options.delayMs)
    ? Math.max(0, options.delayMs)
    : DEFAULT_USAGE_SYNC_DELAY_MS

  const pending = pendingSessionTimers.get(sessionKey)
  if (pending) clearTimeoutFn(pending)

  const timer = setTimeoutFn(() => {
    pendingSessionTimers.delete(sessionKey)
    syncSessionUsageNow(sessionKey).catch(error => {
      console.warn(`[UsageSync] session sync failed for ${sessionKey}:`, error?.message || error)
    })
  }, delayMs)

  pendingSessionTimers.set(sessionKey, timer)
  return timer
}

export async function syncSessionUsageNow(sessionKey) {
  if (!sessionKey) return _emptyReport()
  const existing = inFlightSessionSyncs.get(sessionKey)
  if (existing) return existing

  const promise = (async () => {
    const startedAt = Date.now()
    try {
      // 多租户前置分流:遍历所有租户 target,命中即返回(单实例 targets===null 走原路径)
      const tenantTargets = await getGatewayHttpTargetsForAllTenants()
      if (tenantTargets) {
        for (const target of tenantTargets) {
          try {
            const gatewayResult = await callGatewayUsageForTarget(target, { key: sessionKey, limit: 1 })
            const sessions = Array.isArray(gatewayResult?.sessions) ? gatewayResult.sessions : []
            if (sessions.length > 0) {
              const report = batchUpdateMatchedGatewayUsage({ sessions })
              const match = sessions.find((session) =>
                (session?.key || session?.sessionKey || session?.id) === sessionKey
              )
              broadcastSessionUsageUpdate(sessionKey, match, report)
              console.log(`[UsageSync] session ${sessionKey} (tenant-scoped):`, report)
              return report
            }
          } catch (e) { /* 该租户无此 session,继续下一个 */ }
        }
        return batchUpdateMatchedGatewayUsage({ sessions: [] })
      }

      const gatewayResult = await callGatewayUsage({ key: sessionKey, limit: 1 })

      // Path A: Gateway returned sessions array — find matching session and write directly
      if (Array.isArray(gatewayResult?.sessions) && gatewayResult.sessions.length > 0) {
        const match = gatewayResult.sessions.find(s =>
          (s.key || s.sessionKey || s.id) === sessionKey
        )
        if (match?.usage) {
          const ownerId = getSessionOwner(sessionKey)
          if (ownerId) {
            const u = match.usage
            const mc = u.messageCounts || u.message_counts || {}
            const tu = u.toolUsage || u.tool_usage || {}
            const result = updateSessionUsageForUser(ownerId, sessionKey, {
              agentId: match.agentId || match.agent || null,
              model: match.model || null,
              modelProvider: match.modelProvider || match.provider || null,
              tokenInput: u.input ?? u.inputTokens ?? 0,
              tokenOutput: u.output ?? u.outputTokens ?? 0,
              tokenCacheRead: u.cacheRead ?? 0,
              tokenCacheWrite: u.cacheWrite ?? 0,
              tokenTotal: u.totalTokens ?? u.total ?? 0,
              costTotal: u.totalCost ?? u.cost ?? 0,
              msgTotal: mc.total || 0,
              msgUser: mc.user || 0,
              msgAssistant: mc.assistant || 0,
              msgToolCalls: mc.toolCalls || 0,
              msgToolResults: mc.toolResults || 0,
              msgErrors: mc.errors || 0,
              toolUsage: tu.tools || [],
            })
            const report = { ..._emptyReport(), scanned: 1, updated: result.updated ? 1 : 0, failed: result.updated ? 0 : 1, durationMs: Date.now() - startedAt }
            broadcastSessionUsageUpdate(sessionKey, match, report)
            console.log(`[UsageSync] session ${sessionKey}:`, report)
            return report
          }
          // No owner found — fall through to batch path as fallback
        }
      }

      // Path B: Fallback — try batch update (handles precomputed or unusual formats)
      const sessions = Array.isArray(gatewayResult?.sessions)
        ? gatewayResult.sessions
        : []
      const report = batchUpdateMatchedGatewayUsage({ sessions })
      const match = sessions.find((session) =>
        (session?.key || session?.sessionKey || session?.id) === sessionKey
      )
      broadcastSessionUsageUpdate(sessionKey, match, report)
      console.log(`[UsageSync] session batch fallback ${sessionKey}:`, report)
      return report
    } catch (error) {
      const report = { ..._emptyReport(), failed: 1, durationMs: Date.now() - startedAt }
      console.warn(`[UsageSync] session failed ${sessionKey}:`, error?.message || error)
      return report
    } finally {
      inFlightSessionSyncs.delete(sessionKey)
    }
  })()

  inFlightSessionSyncs.set(sessionKey, promise)
  return promise
}

export function __resetUsageSyncForTests() {
  for (const timer of pendingSessionTimers.values()) clearTimeoutFn(timer)
  pendingSessionTimers.clear()
  inFlightSessionSyncs.clear()
}

export function __setUsageSyncTimersForTests({ setTimeoutFn: nextSetTimeout, clearTimeoutFn: nextClearTimeout }) {
  setTimeoutFn = nextSetTimeout || setTimeout
  clearTimeoutFn = nextClearTimeout || clearTimeout
}
