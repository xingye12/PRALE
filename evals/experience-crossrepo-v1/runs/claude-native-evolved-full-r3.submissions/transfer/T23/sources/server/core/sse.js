// SSE broadcasting and client management
// Depends on shared state from core/index.js

import { sseClients, streamIdMap } from './index.js'
import { getUserOwnedSessionKeys } from '../user-manager.js'

export function broadcastSSE(data, rawPayload) {
  const sk = rawPayload?.sessionKey || rawPayload?.session_key || rawPayload?.key
  let enriched = data
  if (sk) {
    for (const [id, entry] of streamIdMap) {
      if (entry.sessionKey === sk) {
        enriched = { ...data, streamId: id }
        break
      }
    }
  }
  const message = `data: ${JSON.stringify(enriched)}\n\n`
  for (const [id, client] of sseClients) {
    try {
      // 多租户租户隔离:payload 带 tenantId 且 client 有 tenantId 且不匹配 → 跳过;
      // admin 收 tenantState 类型放行(管理员需看全租户状态)。
      if (rawPayload?.tenantId && client.tenantId && rawPayload.tenantId !== client.tenantId && !client.isAdmin) {
        continue
      }
      if (data.type === 'event' && rawPayload && client.userId) {
        const sk2 = rawPayload.sessionKey || rawPayload.session_key || rawPayload.key || ''
        if (!sk2) {
          continue
        }
        const ownedKeys = client.isAdmin ? null : getUserOwnedSessionKeys(client.userId)
        if (ownedKeys && !ownedKeys.includes(sk2)) {
          continue
        }
        client.res.write(message)
        continue
      }
      client.res.write(message)
    } catch (e) {
      sseClients.delete(id)
    }
  }
}

export function sendSSEToClient(clientId, data) {
  const client = sseClients.get(clientId)
  if (!client) return
  try {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`)
  } catch (e) {
    sseClients.delete(clientId)
  }
}

/**
 * 全局广播 — 无所有权过滤，发送给所有已认证 SSE 客户端。
 * 用于平台级告警（如模型并发拥挤通知）。
 */
export function broadcastGlobalSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  for (const [id, client] of sseClients) {
    if (!client.userId) continue
    // 多租户模式:平台告警只发 admin,避免跨租户泄露(单实例 client.tenantId=null 短路,保持原行为)
    if (client.tenantId && !client.isAdmin) continue
    try {
      client.res.write(message)
    } catch (e) {
      sseClients.delete(id)
    }
  }
}
