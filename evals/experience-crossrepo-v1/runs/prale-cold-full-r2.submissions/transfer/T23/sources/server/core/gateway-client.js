// Gateway HTTP communication layer and stateful helpers
// Depends only on envConfig (passed in) and pure utils.
import { getGatewayHttpTargetForCurrentRequest } from './multi-tenant-gateway.js'
import { extractMessagesFromHistoryPayload } from '../utils/index.js'

let gatewayInstance = null
let envConfig = null

export function initGatewayClient(_gateway, _envConfig) {
  gatewayInstance = _gateway
  envConfig = _envConfig
}

async function _buildGatewayHttpOptions() {
  const tenantTarget = await getGatewayHttpTargetForCurrentRequest()
  if (tenantTarget) {
    console.log(`[GatewayTrace] HTTP target tenant=${tenantTarget.tenant?.id || 'unknown'} baseUrl=${tenantTarget.baseUrl}`)
    return tenantTarget
  }

  const wsUrl = new URL(envConfig.OPENCLAW_WS_URL || 'ws://localhost:18789')
  const protocol = wsUrl.protocol === 'wss:' ? 'https' : 'http'
  console.log(`[GatewayTrace] HTTP target default baseUrl=${protocol}://${wsUrl.host}`)
  return {
    baseUrl: `${protocol}://${wsUrl.host}`,
    headers: {
      Authorization: `Bearer ${envConfig.OPENCLAW_AUTH_TOKEN || ''}`,
    },
  }
}

function _sanitizeLogParams(params, _depth = 0) {
  if (!params || typeof params !== 'object') return '{}'
  if (_depth > 4) return '{...}'
  try {
    const SENSITIVE = ['apiKey', 'secret', 'password', 'token', 'credentials', 'appSecret', 'authToken', 'accessToken', 'privateKey', 'authorization']
    const result = Array.isArray(params) ? [] : {}
    for (const key of Object.keys(params)) {
      const val = params[key]
      if (SENSITIVE.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
        result[key] = '***'
      } else if (val && typeof val === 'object') {
        result[key] = JSON.parse(_sanitizeLogParams(val, _depth + 1))
      } else {
        result[key] = val
      }
    }
    const s = JSON.stringify(result)
    return _depth > 0 ? s : (s.length > 200 ? s.slice(0, 200) + '...' : s)
  } catch {
    return '{...}'
  }
}

export async function gatewayAdminRpc(method, params = {}, timeoutMs = 15_000) {
  const { baseUrl, headers } = await _buildGatewayHttpOptions()
  return gatewayAdminRpcForTarget({ baseUrl, headers }, method, params, timeoutMs)
}

export async function gatewayAdminRpcForTarget(target, method, params = {}, timeoutMs = 15_000) {
  const _start = performance.now()
  const _safeParams = _sanitizeLogParams(params)
  const url = new URL('/api/v1/admin/rpc', target.baseUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { ...target.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method,
        params,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      let errorText = ''
      try {
        const data = await res.json()
        errorText = data?.error?.message || data?.message || ''
      } catch {
        errorText = await res.text().catch(() => '')
      }
      const _ms = (performance.now() - _start).toFixed(1)
      const suffix = errorText ? ` - ${errorText}` : ''
      console.log(`[Gateway] HTTP POST 调用: /api/v1/admin/rpc (${method}), 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 失败 - HTTP ${res.status}${suffix}`)
      if (res.status === 404) {
        try {
          const payload = await gatewayInstance.call(method, params)
          const _fallbackMs = (performance.now() - _start).toFixed(1)
          console.log(`[Gateway] WS RPC fallback: ${method}, params: ${_safeParams}, duration: ${_fallbackMs}ms, result: success`)
          return { ok: true, payload }
        } catch (err) {
          const _fallbackMs = (performance.now() - _start).toFixed(1)
          console.log(`[Gateway] WS RPC fallback: ${method}, params: ${_safeParams}, duration: ${_fallbackMs}ms, result: failed - ${err.message}`)
          return { ok: false, error: err.message || errorText || `Gateway admin RPC HTTP ${res.status}` }
        }
      }
      return { ok: false, error: errorText || `Gateway admin RPC HTTP ${res.status}` }
    }

    const data = await res.json()
    if (data.ok) {
      const _ms = (performance.now() - _start).toFixed(1)
      console.log(`[Gateway] HTTP POST 调用: /api/v1/admin/rpc (${method}), 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 成功`)
      return { ok: true, payload: data.payload ?? data.result }
    }
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP POST 调用: /api/v1/admin/rpc (${method}), 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 失败 - ${data.error?.message || data.message || '未知错误'}`)
    return { ok: false, error: data.error?.message || data.message || 'Gateway admin RPC error' }
  } catch (err) {
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP POST 调用: /api/v1/admin/rpc (${method}), 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 失败 - ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function gatewayHttpGet(path, params = {}, timeoutMs = 30_000) {
  const _start = performance.now()
  const _safeParams = _sanitizeLogParams(params)

  const { baseUrl, headers } = await _buildGatewayHttpOptions()
  const url = new URL(path, baseUrl)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      headers,
      signal: controller.signal,
    })
    if (!res.ok) {
      const _ms = (performance.now() - _start).toFixed(1)
      console.log(`[Gateway] HTTP GET 调用: ${path}, 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 失败 - HTTP ${res.status}`)
      return { ok: false, error: `Gateway HTTP ${res.status}` }
    }
    const data = await res.json()
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP GET 调用: ${path}, 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 成功`)
    return { ok: true, data }
  } catch (err) {
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP GET 调用: ${path}, 参数: ${_safeParams}, 耗时: ${_ms}ms, 结果: 失败 - ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function gatewayHttpPost(path, body = {}, timeoutMs = 30_000) {
  const _start = performance.now()
  const _safeBody = _sanitizeLogParams(body)

  const { baseUrl, headers } = await _buildGatewayHttpOptions()
  const url = new URL(path, baseUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const _ms = (performance.now() - _start).toFixed(1)
      console.log(`[Gateway] HTTP POST 调用: ${path}, 参数: ${_safeBody}, 耗时: ${_ms}ms, 结果: 失败 - HTTP ${res.status}`)
      return { ok: false, error: `Gateway HTTP ${res.status}` }
    }
    const data = await res.json()
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP POST 调用: ${path}, 参数: ${_safeBody}, 耗时: ${_ms}ms, 结果: 成功`)
    return { ok: true, data }
  } catch (err) {
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP POST 调用: ${path}, 参数: ${_safeBody}, 耗时: ${_ms}ms, 结果: 失败 - ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function gatewayHttpPostForTarget(target, path, body = {}, timeoutMs = 30_000) {
  const _start = performance.now()
  const _safeBody = _sanitizeLogParams(body)
  const url = new URL(path, target.baseUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { ...target.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      let errorText = ''
      try {
        const data = await res.json()
        errorText = data?.error?.message || data?.message || ''
      } catch {
        errorText = await res.text().catch(() => '')
      }
      const _ms = (performance.now() - _start).toFixed(1)
      const suffix = errorText ? ` - ${errorText}` : ''
      console.log(`[Gateway] HTTP POST 调用: ${path}, 参数: ${_safeBody}, 耗时: ${_ms}ms, 结果: 失败 - HTTP ${res.status}${suffix}`)
      return { ok: false, error: errorText || `Gateway HTTP ${res.status}` }
    }
    const data = await res.json()
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP POST 调用: ${path}, 参数: ${_safeBody}, 耗时: ${_ms}ms, 结果: 成功`)
    return { ok: true, data }
  } catch (err) {
    const _ms = (performance.now() - _start).toFixed(1)
    console.log(`[Gateway] HTTP POST 调用: ${path}, 参数: ${_safeBody}, 耗时: ${_ms}ms, 结果: 失败 - ${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchHistoryFromGateway(sessionKey, limit = 50) {
  const result = await gatewayHttpGet(
    `/sessions/${encodeURIComponent(sessionKey)}/history`,
    { limit }
  )
  if (!result.ok) return []

  const messages = extractMessagesFromHistoryPayload(result.data)
  return messages.map((m, i) => {
    let msgTimestamp = null
    if (m.timestamp || m.createdAt || m.created_at || m.ts || m.time) {
      try { msgTimestamp = new Date(m.timestamp || m.createdAt || m.created_at || m.ts || m.time).toISOString() } catch {}
    }
    return {
      seq: i + 1,
      msgId: m.id || m.msg_id || null,
      role: m.role || 'unknown',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      rawContent: m,
      model: m.model || null,
      status: 'confirmed',
      msgTimestamp,
    }
  })
}

export const HTTP_RPC_METHODS = new Set([
  'config.get', 'cron.list', 'agents.list',
  'config.patch', 'config.set', 'config.apply',
  'health', 'status',
  'agents.create', 'agents.update', 'agents.delete',
  'channels.status', 'channels.start', 'channels.stop', 'channels.logout',
  'config.schema', 'config.schema.lookup',
  'cron.status', 'cron.get', 'cron.add', 'cron.update', 'cron.remove', 'cron.run', 'cron.runs',
  'models.authStatus',
  'exec.approvals.get', 'exec.approvals.set',
  'exec.approvals.node.get', 'exec.approvals.node.set',
  'node.list', 'node.describe', 'node.pair.list', 'node.pair.approve', 'node.pair.reject', 'node.pair.remove', 'node.rename',
  'tasks.list', 'tasks.get', 'tasks.cancel',
  'usage.status', 'usage.cost',
  'logs.tail', 'gateway.restart.request',
  'device.pair.list', 'device.pair.approve', 'device.pair.reject', 'device.pair.remove',
  'doctor.memory.status', 'update.status',
])

export function callGatewayUsage(params) {
  return gatewayInstance.call('sessions.usage', { ...params, limit: params?.limit || 1000 })
}

export async function callGatewayUsageForTarget(target, params) {
  const result = await gatewayAdminRpcForTarget(target, 'sessions.usage', { ...params, limit: params?.limit || 1000 })
  if (!result.ok) throw new Error(result.error || 'sessions.usage failed')
  return result.payload
}

export function getGateway() {
  return gatewayInstance
}
