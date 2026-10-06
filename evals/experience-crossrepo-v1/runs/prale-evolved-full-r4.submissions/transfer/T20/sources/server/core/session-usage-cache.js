// Session Usage Cache — SQLite-backed usage store
// All reads go directly to SQLite (indexed, <1ms)
// Eliminates high-frequency WebSocket RPC calls to Gateway

import db from '../database.js'

// ---------------------------------------------------------------------------
// Row → entry helper
// ---------------------------------------------------------------------------

function _rowToEntry(row) {
  return {
    sessionKey: row.session_key,
    agentId: row.agent_id,
    userId: row.user_id,
    model: row.model || null,
    modelProvider: row.model_provider || null,
    tokenInput: row.token_input || 0,
    tokenOutput: row.token_output || 0,
    tokenCacheRead: row.token_cache_read || 0,
    tokenCacheWrite: row.token_cache_write || 0,
    tokenTotal: row.token_total || 0,
    costTotal: row.cost_total || 0,
    msgTotal: row.msg_total || 0,
    msgUser: row.msg_user || 0,
    msgAssistant: row.msg_assistant || 0,
    msgToolCalls: row.msg_tool_calls || 0,
    msgToolResults: row.msg_tool_results || 0,
    msgErrors: row.msg_errors || 0,
    toolUsage: _safeParseJson(row.tool_usage_json),
    usageSyncedAt: row.usage_synced_at,
  }
}

function _safeParseJson(json) {
  if (!json || json === '{}') return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Single-session queries
// ---------------------------------------------------------------------------

export function getSessionUsage(sessionKey, userId = null) {
  const sql = userId
    ? `SELECT * FROM user_sessions WHERE session_key = ? AND user_id = ? AND usage_synced_at IS NOT NULL`
    : `SELECT * FROM user_sessions WHERE session_key = ? AND usage_synced_at IS NOT NULL`
  const row = db.prepare(sql).get(...(userId ? [sessionKey, userId] : [sessionKey]))
  if (!row) return null
  return _rowToEntry(row)
}

// ---------------------------------------------------------------------------
// Multi-session queries (by user / agent)
// ---------------------------------------------------------------------------

export function getAgentUsage(agentId) {
  const rows = db.prepare(`
    SELECT * FROM user_sessions
    WHERE agent_id = ? AND usage_synced_at IS NOT NULL
  `).all(agentId)
  return rows.map(_rowToEntry)
}

// ---------------------------------------------------------------------------
// Model normalization — ensures consistent model_provider at write time
// If modelProvider is empty but model contains '/', extract provider prefix.
// ---------------------------------------------------------------------------

function _normalizeModelFields(model, modelProvider) {
  if (!model) return { model: null, modelProvider: null }
  const slashIdx = model.indexOf('/')
  if (slashIdx > 0) {
    // "openai/gpt-4o" → model="gpt-4o", modelProvider="openai"
    return { model: model.substring(slashIdx + 1), modelProvider: modelProvider || model.substring(0, slashIdx) }
  }
  return { model, modelProvider: modelProvider || null }
}

// ---------------------------------------------------------------------------
// Write — requires userId (ownership guard)
// ---------------------------------------------------------------------------

export function updateSessionUsageForUser(userId, sessionKey, usageData) {
  const { model, modelProvider } = _normalizeModelFields(usageData.model, usageData.modelProvider)
  const entry = {
    sessionKey,
    agentId: usageData.agentId || null,
    userId,
    model,
    modelProvider,
    tokenInput: usageData.tokenInput || 0,
    tokenOutput: usageData.tokenOutput || 0,
    tokenCacheRead: usageData.tokenCacheRead || 0,
    tokenCacheWrite: usageData.tokenCacheWrite || 0,
    tokenTotal: usageData.tokenTotal || 0,
    costTotal: usageData.costTotal || 0,
    msgTotal: usageData.msgTotal || 0,
    msgUser: usageData.msgUser || 0,
    msgAssistant: usageData.msgAssistant || 0,
    msgToolCalls: usageData.msgToolCalls || 0,
    msgToolResults: usageData.msgToolResults || 0,
    msgErrors: usageData.msgErrors || 0,
    toolUsage: usageData.toolUsage || [],
    usageSyncedAt: Date.now(),
  }
  const updated = _persistOwnerScopedUpdate(entry)
  if (!updated) {
    console.warn(`[UsageCache] owner-scoped usage update skipped: userId=${userId}, sessionKey=${sessionKey}`)
  }
  return { ...entry, updated }
}

// Owner-scoped write — UPDATE only where user_id + session_key match
// ---------------------------------------------------------------------------

function _persistOwnerScopedUpdate(entry) {
  const result = db.prepare(`
    UPDATE user_sessions SET
      agent_id = ?,
      model = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE user_sessions.model END,
      model_provider = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE user_sessions.model_provider END,
      token_input = ?, token_output = ?,
      token_cache_read = ?, token_cache_write = ?,
      token_total = ?, cost_total = ?,
      msg_total = ?, msg_user = ?, msg_assistant = ?,
      msg_tool_calls = ?, msg_tool_results = ?, msg_errors = ?,
      tool_usage_json = ?,
      usage_synced_at = ?,
      updated_at = ?
    WHERE user_id = ? AND session_key = ?
  `).run(
    entry.agentId,
    entry.model, entry.model, entry.model,
    entry.modelProvider, entry.modelProvider, entry.modelProvider,
    entry.tokenInput, entry.tokenOutput,
    entry.tokenCacheRead, entry.tokenCacheWrite,
    entry.tokenTotal, entry.costTotal,
    entry.msgTotal, entry.msgUser, entry.msgAssistant,
    entry.msgToolCalls, entry.msgToolResults, entry.msgErrors,
    JSON.stringify(entry.toolUsage),
    entry.usageSyncedAt,
    Date.now(),
    entry.userId, entry.sessionKey
  )
  return result?.changes === 1
}

// ---------------------------------------------------------------------------
// Batch update from Gateway — ownership-matched, skips conflicts
// ---------------------------------------------------------------------------

export function batchUpdateMatchedGatewayUsage(gatewayResult, userId = null) {
  const t0 = Date.now()
  const report = { scanned: 0, updated: 0, skippedUnmatched: 0, skippedConflict: 0, failed: 0 }

  if (!gatewayResult || !Array.isArray(gatewayResult.sessions)) return report

  const ownershipStmt = userId
    ? db.prepare(`SELECT user_id, session_key FROM user_sessions WHERE user_id = ? AND session_key = ?`)
    : db.prepare(`SELECT user_id, session_key FROM user_sessions WHERE session_key = ?`)

  for (const session of gatewayResult.sessions) {
    report.scanned++
    const key = session.key || session.sessionKey || session.id
    if (!key) { report.skippedUnmatched++; continue }

    const owners = userId ? ownershipStmt.all(userId, key) : ownershipStmt.all(key)
    if (owners.length === 0) { report.skippedUnmatched++; continue }
    if (owners.length > 1) { report.skippedConflict++; continue }

    const owner = owners[0]
    const usage = session.usage || {}
    const msgCounts = usage.messageCounts || usage.message_counts || {}
    const toolUsage = usage.toolUsage || usage.tool_usage || {}
    const { model, modelProvider } = _normalizeModelFields(
      session.model || null,
      session.modelProvider || session.provider || null
    )

    try {
      const updated = _persistOwnerScopedUpdate({
        sessionKey: key,
        userId: owner.user_id,
        agentId: session.agentId || session.agent || null,
        model,
        modelProvider,
        tokenInput: usage.input || 0,
        tokenOutput: usage.output || 0,
        tokenCacheRead: usage.cacheRead || 0,
        tokenCacheWrite: usage.cacheWrite || 0,
        tokenTotal: usage.totalTokens || usage.tokens || usage.total || 0,
        costTotal: usage.totalCost || usage.cost || 0,
        msgTotal: msgCounts.total || 0,
        msgUser: msgCounts.user || 0,
        msgAssistant: msgCounts.assistant || 0,
        msgToolCalls: msgCounts.toolCalls || 0,
        msgToolResults: msgCounts.toolResults || 0,
        msgErrors: msgCounts.errors || 0,
        toolUsage: toolUsage.tools || [],
        usageSyncedAt: Date.now(),
      })
      if (updated) {
        report.updated++
      } else {
        report.failed++
        console.warn(`[UsageCache] owner-scoped usage update skipped: userId=${owner.user_id}, sessionKey=${key}`)
      }
    } catch (error) {
      report.failed++
      console.warn(`[UsageCache] failed to update usage: userId=${owner.user_id}, sessionKey=${key}, error=${error?.message || error}`)
    }
  }

  report.durationMs = Date.now() - t0
  if (report.updated > 0) {
    console.log(`[UsageCache] batch matched ${report.updated}/${report.scanned} sessions from Gateway (${report.durationMs}ms)`)
  }
  return report
}

// ---------------------------------------------------------------------------
// Single-session owner lookup
// ---------------------------------------------------------------------------

export function getSessionOwner(sessionKey) {
  const row = db.prepare('SELECT user_id FROM user_sessions WHERE session_key = ?').get(sessionKey)
  return row?.user_id || null
}

// ---------------------------------------------------------------------------
// Aggregation queries — SQLite is the single source of truth
// All dashboard data comes from these queries, never from Gateway parsing.
// ---------------------------------------------------------------------------

const ZERO_TOTALS = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  totalTokens: 0, totalCost: 0, inputCost: 0, outputCost: 0,
  cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 0,
}

// Pre-compiled prepared statements for hot-path queries

const stmtUserTotals = db.prepare(`
  SELECT
    COALESCE(SUM(token_input), 0) as input,
    COALESCE(SUM(token_output), 0) as output,
    COALESCE(SUM(token_cache_read), 0) as cacheRead,
    COALESCE(SUM(token_cache_write), 0) as cacheWrite,
    COALESCE(SUM(token_total), 0) as totalTokens,
    COALESCE(SUM(cost_total), 0) as totalCost
  FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL
`)

const stmtAdminTotals = db.prepare(`
  SELECT
    COALESCE(SUM(token_input), 0) as input,
    COALESCE(SUM(token_output), 0) as output,
    COALESCE(SUM(token_cache_read), 0) as cacheRead,
    COALESCE(SUM(token_cache_write), 0) as cacheWrite,
    COALESCE(SUM(token_total), 0) as totalTokens,
    COALESCE(SUM(cost_total), 0) as totalCost
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL
`)

const stmtAdminTotalsByTenant = db.prepare(`
  SELECT
    COALESCE(SUM(token_input), 0) as input,
    COALESCE(SUM(token_output), 0) as output,
    COALESCE(SUM(token_cache_read), 0) as cacheRead,
    COALESCE(SUM(token_cache_write), 0) as cacheWrite,
    COALESCE(SUM(token_total), 0) as totalTokens,
    COALESCE(SUM(cost_total), 0) as totalCost,
    COUNT(*) as sessions
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL AND tenant_id = ?
`)

const stmtUserByAgent = db.prepare(`
  SELECT
    agent_id as agentId,
    COALESCE(SUM(token_input), 0) as input,
    COALESCE(SUM(token_output), 0) as output,
    COALESCE(SUM(token_total), 0) as totalTokens,
    COALESCE(SUM(cost_total), 0) as totalCost
  FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL
  GROUP BY agent_id
`)

const stmtAdminByAgent = db.prepare(`
  SELECT
    agent_id as agentId,
    COALESCE(SUM(token_input), 0) as input,
    COALESCE(SUM(token_output), 0) as output,
    COALESCE(SUM(token_total), 0) as totalTokens,
    COALESCE(SUM(cost_total), 0) as totalCost
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL
  GROUP BY agent_id
`)

const stmtUserDaily = db.prepare(`
  SELECT
    date(updated_at / 1000, 'unixepoch') as date,
    COALESCE(SUM(token_total), 0) as tokens,
    COALESCE(SUM(cost_total), 0) as cost,
    COALESCE(SUM(msg_total), 0) as messages,
    COALESCE(SUM(msg_tool_calls), 0) as toolCalls,
    COALESCE(SUM(msg_errors), 0) as errors
  FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL
  GROUP BY date
  ORDER BY date ASC
`)

const stmtAdminDaily = db.prepare(`
  SELECT
    date(updated_at / 1000, 'unixepoch') as date,
    COALESCE(SUM(token_total), 0) as tokens,
    COALESCE(SUM(cost_total), 0) as cost,
    COALESCE(SUM(msg_total), 0) as messages,
    COALESCE(SUM(msg_tool_calls), 0) as toolCalls,
    COALESCE(SUM(msg_errors), 0) as errors
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL
  GROUP BY date
  ORDER BY date ASC
`)

const stmtUserMessages = db.prepare(`
  SELECT
    COALESCE(SUM(msg_total), 0) as total,
    COALESCE(SUM(msg_user), 0) as user,
    COALESCE(SUM(msg_assistant), 0) as assistant,
    COALESCE(SUM(msg_tool_calls), 0) as toolCalls,
    COALESCE(SUM(msg_tool_results), 0) as toolResults,
    COALESCE(SUM(msg_errors), 0) as errors
  FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL
`)

const stmtAdminMessages = db.prepare(`
  SELECT
    COALESCE(SUM(msg_total), 0) as total,
    COALESCE(SUM(msg_user), 0) as user,
    COALESCE(SUM(msg_assistant), 0) as assistant,
    COALESCE(SUM(msg_tool_calls), 0) as toolCalls,
    COALESCE(SUM(msg_tool_results), 0) as toolResults,
    COALESCE(SUM(msg_errors), 0) as errors
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL
`)

const stmtUserTools = db.prepare(`
  SELECT tool_usage_json FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL AND tool_usage_json IS NOT NULL AND tool_usage_json != '{}'
`)

const stmtAdminTools = db.prepare(`
  SELECT tool_usage_json FROM user_sessions
  WHERE usage_synced_at IS NOT NULL AND tool_usage_json IS NOT NULL AND tool_usage_json != '{}'
`)

// --- byModel / byProvider aggregation (with model column) ---

const stmtUserByModel = db.prepare(`
  SELECT
    COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END) AS provider,
    CASE WHEN model LIKE '%/%' THEN substr(model, instr(model, '/') + 1) ELSE model END AS model,
    COUNT(*) AS count,
    COALESCE(SUM(token_input), 0) AS input,
    COALESCE(SUM(token_output), 0) AS output,
    COALESCE(SUM(token_total), 0) AS totalTokens,
    COALESCE(SUM(cost_total), 0) AS totalCost
  FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL
    AND model IS NOT NULL AND model != ''
  GROUP BY COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END),
    CASE WHEN model LIKE '%/%' THEN substr(model, instr(model, '/') + 1) ELSE model END
`)

const stmtAdminByModel = db.prepare(`
  SELECT
    COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END) AS provider,
    CASE WHEN model LIKE '%/%' THEN substr(model, instr(model, '/') + 1) ELSE model END AS model,
    COUNT(*) AS count,
    COALESCE(SUM(token_input), 0) AS input,
    COALESCE(SUM(token_output), 0) AS output,
    COALESCE(SUM(token_total), 0) AS totalTokens,
    COALESCE(SUM(cost_total), 0) AS totalCost
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL
    AND model IS NOT NULL AND model != ''
  GROUP BY COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END),
    CASE WHEN model LIKE '%/%' THEN substr(model, instr(model, '/') + 1) ELSE model END
`)

const stmtUserByProvider = db.prepare(`
  SELECT
    COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END) AS provider,
    COUNT(*) AS count,
    COALESCE(SUM(token_input), 0) AS input,
    COALESCE(SUM(token_output), 0) AS output,
    COALESCE(SUM(token_total), 0) AS totalTokens,
    COALESCE(SUM(cost_total), 0) AS totalCost
  FROM user_sessions
  WHERE user_id = ? AND usage_synced_at IS NOT NULL
    AND model IS NOT NULL AND model != ''
  GROUP BY COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END)
`)

const stmtAdminByProvider = db.prepare(`
  SELECT
    COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END) AS provider,
    COUNT(*) AS count,
    COALESCE(SUM(token_input), 0) AS input,
    COALESCE(SUM(token_output), 0) AS output,
    COALESCE(SUM(token_total), 0) AS totalTokens,
    COALESCE(SUM(cost_total), 0) AS totalCost
  FROM user_sessions
  WHERE usage_synced_at IS NOT NULL
    AND model IS NOT NULL AND model != ''
  GROUP BY COALESCE(model_provider, CASE WHEN model LIKE '%/%' THEN substr(model, 1, instr(model, '/') - 1) ELSE 'unknown' END)
`)

/**
 * Build complete dashboard aggregates from SQLite.
 * This is the single source of truth — no Gateway response parsing needed.
 *
 * @param {string|null} userId — null for admin (all users)
 * @param {{ startDate?: string|null, endDate?: string|null }} [dateRange] — frontend date range for daily gap fill
 * @returns {{ totals, sessions:[], aggregates: { daily, byAgent, byModel, byProvider, messages, tools } }}
 */
export function getUserAggregates(userId = null, dateRange = {}, tenantId = null) {
  const isAdmin = !userId

  // --- Totals ---
  // tenantId 限定:admin 视图按租户作用域(向后兼容:不传 = 全局)
  let totalsRow
  if (isAdmin && tenantId) {
    totalsRow = stmtAdminTotalsByTenant.get(tenantId)
  } else if (isAdmin) {
    totalsRow = stmtAdminTotals.get()
  } else {
    totalsRow = stmtUserTotals.get(userId)
  }
  const totals = { ...ZERO_TOTALS, ...totalsRow }

  // --- Daily breakdown ---
  const dailyRows = isAdmin ? stmtAdminDaily.all() : stmtUserDaily.all(userId)
  const daily = _fillDailyGaps(dailyRows.filter(r => r.date), dateRange)

  // --- By agent ---
  const agentRows = isAdmin ? stmtAdminByAgent.all() : stmtUserByAgent.all(userId)
  const byAgent = agentRows.map(a => ({
    agentId: a.agentId || 'unknown',
    totals: {
      input: a.input,
      output: a.output,
      totalTokens: a.totalTokens,
      totalCost: a.totalCost,
    },
  }))

  // --- Messages ---
  const msgRow = isAdmin ? stmtAdminMessages.get() : stmtUserMessages.get(userId)
  const messages = {
    total: msgRow.total,
    user: msgRow.user,
    assistant: msgRow.assistant,
    toolCalls: msgRow.toolCalls,
    toolResults: msgRow.toolResults,
    errors: msgRow.errors,
  }

  // --- Tool usage (aggregate from JSON) ---
  const tools = _aggregateToolUsage(
    isAdmin ? stmtAdminTools.all() : stmtUserTools.all(userId)
  )

  // --- byModel / byProvider (from model column) ---
  const ZERO_T = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 }

  const modelRows = isAdmin ? stmtAdminByModel.all() : stmtUserByModel.all(userId)
  const byModel = modelRows.map(r => ({
    provider: r.provider || 'unknown',
    model: r.model || 'unknown',
    count: r.count,
    totals: {
      ...ZERO_T,
      input: r.input,
      output: r.output,
      totalTokens: r.totalTokens,
      totalCost: r.totalCost,
    },
  }))

  const providerRows = isAdmin ? stmtAdminByProvider.all() : stmtUserByProvider.all(userId)
  const byProvider = providerRows.map(r => ({
    provider: r.provider || 'unknown',
    count: r.count,
    totals: {
      ...ZERO_T,
      input: r.input,
      output: r.output,
      totalTokens: r.totalTokens,
      totalCost: r.totalCost,
    },
  }))

  return {
    sessions: [],
    totals,
    aggregates: {
      daily,
      byAgent,
      byModel,
      byProvider,
      messages,
      tools,
    },
  }
}

/**
 * Fill missing dates with zero values across the given date range.
 * If dateRange provides startDate/endDate (YYYY-MM-DD), use that range.
 * Otherwise fall back to last 14 days.
 */
function _fillDailyGaps(rows, dateRange = {}) {
  const dataMap = new Map(rows.map(r => [r.date, r]))
  const result = []
  let start = dateRange.startDate ? new Date(dateRange.startDate + 'T00:00:00') : null
  let end = dateRange.endDate ? new Date(dateRange.endDate + 'T00:00:00') : null

  // Fallback: last 14 days
  if (!start || !end) {
    end = new Date()
    start = new Date()
    start.setDate(start.getDate() - 13)
  }

  // Clamp to today — no future dates
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (end > today) end = today
  if (start > today) start = today

  const cursor = new Date(start)
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10)
    result.push(dataMap.get(key) || {
      date: key,
      tokens: 0,
      cost: 0,
      messages: 0,
      toolCalls: 0,
      errors: 0,
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return result
}

function _aggregateToolUsage(toolJsonRows) {
  const toolMap = {}
  for (const row of toolJsonRows) {
    const tools = _safeParseJson(row.tool_usage_json)
    for (const tool of tools) {
      const name = tool.name || 'unknown'
      toolMap[name] = (toolMap[name] || 0) + (tool.count || 1)
    }
  }
  const tools = Object.entries(toolMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return {
    totalCalls: tools.reduce((s, t) => s + t.count, 0),
    uniqueTools: tools.length,
    tools,
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Admin user usage aggregates — JOIN users for username/displayName
// ---------------------------------------------------------------------------

export function getAdminUserUsageAggregates(tenantId = null) {
  // tenantId 限定:按租户作用域过滤(向后兼容:不传 = 全局)
  if (tenantId) {
    return db.prepare(`
      SELECT
        u.id as userId,
        u.username,
        u.display_name as displayName,
        COUNT(s.id) as sessionCount,
        COALESCE(SUM(s.token_total), 0) as totalTokens,
        COALESCE(SUM(s.cost_total), 0) as totalCost,
        COALESCE(SUM(s.token_input), 0) as inputTokens,
        COALESCE(SUM(s.token_output), 0) as outputTokens
      FROM users u
      LEFT JOIN user_sessions s ON u.id = s.user_id AND s.usage_synced_at IS NOT NULL AND s.tenant_id = ?
      WHERE u.status = 'active'
      GROUP BY u.id
      ORDER BY totalTokens DESC
    `).all(tenantId)
  }
  return db.prepare(`
    SELECT
      u.id as userId,
      u.username,
      u.display_name as displayName,
      COUNT(s.id) as sessionCount,
      COALESCE(SUM(s.token_total), 0) as totalTokens,
      COALESCE(SUM(s.cost_total), 0) as totalCost,
      COALESCE(SUM(s.token_input), 0) as inputTokens,
      COALESCE(SUM(s.token_output), 0) as outputTokens
    FROM users u
    LEFT JOIN user_sessions s ON u.id = s.user_id AND s.usage_synced_at IS NOT NULL
    WHERE u.status = 'active'
    GROUP BY u.id
    ORDER BY totalTokens DESC
  `).all()
}

// ---------------------------------------------------------------------------
// hasUsageSyncRows — check if any usage rows exist (admin or user-scoped)
// ---------------------------------------------------------------------------

export function hasUsageSyncRows(userId) {
  if (userId) {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM user_sessions WHERE user_id = ? AND usage_synced_at IS NOT NULL`
    ).get(userId)
    return row.count > 0
  }
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM user_sessions WHERE usage_synced_at IS NOT NULL`
  ).get()
  return row.count > 0
}
