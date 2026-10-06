// server/core/message-sync.js
import { saveMessage, isReady as isMessageStoreReady, mergeSessionMessages } from '../message-store.js'
import { fetchHistoryFromGateway } from './gateway-client.js'
import { getUserIdsByAgentId, upsertSyncedUserSession } from '../user-manager.js'
import { mapWithConcurrency, extractAgentIdFromSessionKey } from './session-sync.js'
import { advanceSessionLastMessageAt } from '../services/session-activity-service.js'
import { extractOccurredAt } from '../services/message-normalizer.js'
import { externalSessionProjection, isKnownExternalSession } from '../services/external-session-projection.js'
import { callGatewayForTenant } from './multi-tenant-gateway.js'

const LOG_PREFIX = '[MessageSync]'
const CATCHUP_CONCURRENCY = 3
const CATCHUP_TIMEOUT_MS = 10_000
const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

// ── Helpers ──

/**
 * 判断是否为外部渠道会话（飞书/企微/钉钉等）。
 * 返回 true → 是外部渠道，message-sync 应处理（PG 写入、SSE 广播）。
 * 返回 false → 是 WattClaw 内部会话（main/workspace 等），应跳过。
 */
export function isExternalChannelSession(sessionKey) {
  return isKnownExternalSession(sessionKey)
}

/**
 * 从 message.content 提取纯文本
 * content 可能是 string 或 content blocks 数组
 */
function extractContentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (block.type === 'text') return block.text || ''
        return `[${block.type}]`
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 从 session.message 事件提取 PG 写入所需字段
 */
export function extractMessageFields(message, messageSeq, messageId) {
  if (!message || !message.role) return null

  const seq = message.__openclaw?.seq ?? messageSeq
  const msgId = message.__openclaw?.id ?? messageId ?? null
  const role = message.role
  const content = extractContentText(message.content)
  const timestamp = extractOccurredAt(message)

  return { seq, msgId, role, content, rawContent: message, timestamp }
}

function normalizePayloadSessionKey(payload) {
  const sessionKey = payload?.sessionKey || payload?.session_key || payload?.key || ''
  return typeof sessionKey === 'string' ? sessionKey : ''
}

/**
 * 处理 session.message 事件 → 写入 PG
 * 所有会话（内部 + 外部）都写入 PG，SSE 广播在 index.js 单独控制
 */
export async function handleSessionMessage(payload) {
  const sessionKey = normalizePayloadSessionKey(payload)
  if (!sessionKey || !payload?.message) return

  const { message, messageSeq, messageId } = payload

  if (!sessionKey.startsWith('agent:')) return

  const fields = extractMessageFields(message, messageSeq, messageId)
  if (!fields || fields.seq == null) {
    console.warn(`${LOG_PREFIX} seq 缺失，跳过:`, { sessionKey, messageSeq, messageId })
    return
  }

  console.log(`${LOG_PREFIX} 收到推送:`, { sessionKey, seq: fields.seq, role: fields.role, msgId: fields.msgId })

  // 内部会话用户消息：已由 chat.js /workspace/send 在发送时保存，跳过避免重复
  // （Gateway messageId = randomUUID ≠ chat.js idempotencyKey，ON CONFLICT msg_id 无法去重）
  if (fields.role === 'user' && !isExternalChannelSession(sessionKey)) {
    console.log(`${LOG_PREFIX} 跳过内部用户消息（已由 chat.js 保存）:`, { sessionKey, seq: fields.seq })
    return
  }

  try {
    await saveMessage({
      sessionKey,
      seq: fields.seq,
      msgId: fields.msgId,
      role: fields.role,
      content: fields.content,
      rawContent: fields.rawContent,
      status: 'confirmed',
      msgTimestamp: fields.timestamp,
    })
    advanceSessionLastMessageAt(sessionKey, fields.timestamp)
  } catch (err) {
    console.error(`${LOG_PREFIX} 写入失败:`, { sessionKey, seq: fields.seq, error: err.message })
    return
  }

  if (fields.role === 'user' && isExternalChannelSession(sessionKey)) {
    try {
      await externalSessionProjection.projectExternalUserMessage({
        sessionKey,
        message,
        content: fields.content,
        occurredAt: fields.timestamp,
      })
    } catch (err) {
      console.error(`${LOG_PREFIX} 外部会话投影失败:`, { sessionKey, seq: fields.seq, error: err.message })
    }
  }
}

/**
 * 处理 sessions.changed 事件 → 注册会话归属到 SQLite
 */
export function handleSessionsChanged(payload) {
  if (!payload?.sessionKey) return

  const { sessionKey, reason } = payload
  const agentId = extractAgentIdFromSessionKey(sessionKey)
  if (!agentId) {
    console.warn(`${LOG_PREFIX} sessions.changed: 无法解析 agentId:`, { sessionKey })
    return
  }

  const userIds = getUserIdsByAgentId(agentId)
  if (userIds.length === 0) {
    console.log(`${LOG_PREFIX} sessions.changed: agent 无归属用户:`, { sessionKey, agentId })
    return
  }

  for (const userId of userIds) {
    upsertSyncedUserSession({
      userId,
      sessionKey,
      agentId,
      channel: payload.channel || null,
      peer: null,
      label: payload.label || payload.derivedTitle || null,
      lastActivity: null,
    })
  }
  console.log(`${LOG_PREFIX} 会话归属注册:`, { sessionKey, agentId, userIds: userIds.length, reason })
}

/**
 * 断线追赶：
 * 1. 从 Gateway sessions.list 发现所有外部渠道会话（包括断线期间新建的）
 * 2. 与本地 user_sessions 合并去重
 * 3. 对所有外部会话执行 refreshSessionFromGateway 全量替换
 */
export async function catchUpMissedMessages(db, gateway) {
  console.log(`${LOG_PREFIX} 开始断线追赶`)

  // ── 阶段1：收集需要追赶的会话 ──
  const localKeys = new Set()
  try {
    const rows = db.prepare(
      `SELECT DISTINCT session_key FROM user_sessions
       WHERE COALESCE(last_message_at, updated_at) > ?
         AND session_key LIKE 'agent:%'
       ORDER BY COALESCE(last_message_at, updated_at) DESC`
    ).all(Date.now() - CATCHUP_WINDOW_MS)
    rows.forEach(r => localKeys.add(r.session_key))
  } catch (err) {
    console.error(`${LOG_PREFIX} 本地会话查询失败:`, err.message)
  }

  // 从 Gateway sessions.list 发现断线期间新建的外部渠道会话
  const gatewayKeys = new Set()
  try {
    const result = await gateway.call('sessions.list', {})
    const items = Array.isArray(result?.rows) ? result.rows : Array.isArray(result) ? result : []
    for (const item of items) {
      const sk = item.sessionKey || item.key || item.session_key || ''
      if (sk && sk.startsWith('agent:') && isExternalChannelSession(sk)) {
        gatewayKeys.add(sk)
      }
    }
    console.log(`${LOG_PREFIX} Gateway 返回 ${items.length} 个会话，其中 ${gatewayKeys.size} 个外部渠道`)
  } catch (err) {
    console.warn(`${LOG_PREFIX} sessions.list 失败，仅用本地会话:`, err.message)
  }

  // 合并去重，只保留外部渠道会话
  const allKeys = new Set(
    [...localKeys, ...gatewayKeys].filter(k => isExternalChannelSession(k))
  )
  if (allKeys.size === 0) {
    console.log(`${LOG_PREFIX} 无活跃外部会话，跳过追赶`)
    return
  }

  const discovered = gatewayKeys.size - localKeys.size
  console.log(`${LOG_PREFIX} 需要追赶: ${allKeys.size} 个会话 (本地 ${localKeys.size} + Gateway 新发现 ${Math.max(0, discovered)})`)

  // ── 阶段2：执行追赶 ──
  const sessions = [...allKeys].map(k => ({ session_key: k }))
  let successCount = 0
  let failCount = 0

  let timer
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(resolve, CATCHUP_TIMEOUT_MS)
  })
  const workPromise = mapWithConcurrency(sessions, CATCHUP_CONCURRENCY, async (session) => {
    if (!isMessageStoreReady()) {
      console.warn(`${LOG_PREFIX} PG 未就绪，跳过追赶:`, { sessionKey: session.session_key })
      failCount++
      return
    }
    // Defensive: only external sessions should reach catch-up
    if (!isExternalChannelSession(session.session_key)) {
      console.warn(`${LOG_PREFIX} 跳过非外部会话追赶:`, { sessionKey: session.session_key })
      return
    }
    try {
      const messages = await fetchHistoryFromGateway(session.session_key, 1000)
      console.log(`${LOG_PREFIX} 追赶拉取:`, { sessionKey: session.session_key, fetched: messages.length })
      if (messages.length > 0) {
        const result = await mergeSessionMessages(session.session_key, messages)
        console.log(`${LOG_PREFIX} 追赶合并:`, { sessionKey: session.session_key, ...result })
      }
      successCount++
    } catch (err) {
      failCount++
      console.warn(`${LOG_PREFIX} 追赶失败:`, { sessionKey: session.session_key, error: err.message })
    }
  })

  const raceResult = await Promise.race([
    workPromise.then(() => 'done'),
    timeoutPromise.then(() => 'timeout')
  ]).finally(() => clearTimeout(timer))

  if (raceResult === 'timeout') {
    console.warn(`${LOG_PREFIX} 断线追赶超时 (${CATCHUP_TIMEOUT_MS}ms)，部分会话仍在后台追赶`)
  }
  console.log(`${LOG_PREFIX} 断线追赶完成:`, { total: sessions.length, success: successCount, failed: failCount })
}

/**
 * 主入口：挂载 message-sync 到 gateway 实例
 * 注册 session.message / sessions.changed / connected 事件处理器
 * 在初始连接和重连时都需要调用
 */
export function attachMessageSync(gateway, db) {
  // 处理 session.message → PG 消息入库
  gateway.on('event', (event, payload) => {
    if (event === 'session.message') {
      handleSessionMessage(payload)
    }
  })

  // 处理 sessions.changed → SQLite 会话归属注册
  gateway.on('event', (event, payload) => {
    if (event === 'sessions.changed') {
      handleSessionsChanged(payload)
    }
  })

  // 连接成功 → sessions.subscribe + 断线追赶
  gateway.on('connected', async (payload) => {
    // 订阅会话事件。
    // 多租户下每个 tenant 的 gateway 各自 emit 'connected'（payload 带 tenantId）。
    // 必须按该 tenantId 精确订阅，否则 proxy.call 在无请求上下文时会退化到默认
    // tenant，导致非默认 tenant 永远收不到 sessions.subscribe → 其 session.message
    // 事件不推送 → 该 tenant 的会话消息（含飞书群同步）全部丢失。
    const tenantId = payload && typeof payload === 'object' ? payload.tenantId : null
    try {
      if (tenantId) {
        await callGatewayForTenant(tenantId, 'sessions.subscribe', {})
        console.log(`${LOG_PREFIX} sessions.subscribe 成功 (tenant=${tenantId})`)
      } else {
        await gateway.call('sessions.subscribe', {})
        console.log(`${LOG_PREFIX} sessions.subscribe 成功`)
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} sessions.subscribe 失败，外部消息将不同步:`, err.message)
    }

    // 断线追赶（异步，不阻塞）
    catchUpMissedMessages(db, gateway).catch(err =>
      console.error(`${LOG_PREFIX} 断线追赶异常:`, err.message)
    )
  })

  console.log(`${LOG_PREFIX} 消息同步模块已挂载`)
}
