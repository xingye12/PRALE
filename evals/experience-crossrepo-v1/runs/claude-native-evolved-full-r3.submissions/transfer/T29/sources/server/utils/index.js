// Pure utility functions extracted from server/index.js
// No external state dependencies — only pure functions and constants.

export const MAX_TITLE_LENGTH = 32

export function generateSafeTitle(content) {
  if (!content) return ''
  const cleaned = content
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned
  return cleaned.slice(0, MAX_TITLE_LENGTH - 3) + '...'
}

export function buildMergePatchFromPatches(patches) {
  const payload = {}
  for (const patch of patches) {
    const path = typeof patch.path === 'string' ? patch.path.trim() : ''
    if (!path) continue
    const segments = path.split('/').filter(Boolean)
    let target = payload
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i]
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {}
      }
      target = target[key]
    }
    const lastKey = segments[segments.length - 1]
    target[lastKey] = patch.value
  }
  return payload
}

export function extractSessionsFromResult(result) {
  let sessions = []
  if (Array.isArray(result)) {
    sessions = result
  } else if (result && typeof result === 'object') {
    for (const k of ['sessions', 'items', 'list', 'data', 'recent']) {
      if (Array.isArray(result[k])) {
        sessions = sessions.concat(result[k])
      }
    }
  }
  return sessions
}

export function resolveCountNumber(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const parsed = parseInt(v, 10)
    if (!isNaN(parsed)) return parsed
  }
  return undefined
}

export function normalizeTokenUsage(src) {
  if (!src || typeof src !== 'object') return undefined
  return {
    totalInput: Math.max(0, Math.floor(src.input || src.totalInput || 0)),
    totalOutput: Math.max(0, Math.floor(src.output || src.totalOutput || 0)),
  }
}

export function extractMessagesFromHistoryPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const candidateKeys = ['messages', 'history', 'transcript', 'items', 'list', 'data', 'events', 'turns']
  const queue = [payload]
  const visited = new Set()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (visited.has(current)) continue
    visited.add(current)
    if (Array.isArray(current)) return current
    for (const key of candidateKeys) {
      if (Array.isArray(current[key])) return current[key]
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return []
}

export function normalizeSessionItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const row = raw
  const key = row.key || row.sessionKey || row.id || ''
  const agentIdMatch = key.match(/^agent:([^:]+):/)
  const agentId = row.agentId || row.agent || (agentIdMatch ? agentIdMatch[1] : 'main')
  const channel = row.channel || row.lastChannel || (key.match(/^agent:[^:]+:([^:]+):/)?.[1] || 'main')
  const peer = row.peer || row.user || row.recipient || row.subject || ''

  let messageCount = resolveCountNumber(row.messageCount)
  if (messageCount === undefined) messageCount = resolveCountNumber(row.message_count)
  if (messageCount === undefined) messageCount = resolveCountNumber(row.turns)
  if (messageCount === undefined) messageCount = resolveCountNumber(row.count)
  if (messageCount === undefined && Array.isArray(row.messages)) messageCount = row.messages.length
  if (messageCount === undefined && Array.isArray(row.transcript)) messageCount = row.transcript.length
  if (messageCount === undefined) messageCount = 0

  const lastActivity = row.lastActivity || row.updatedAt || row.lastSeen || ''
  const model = row.model || row.modelName || undefined
  const label = row.label || row.displayName || undefined
  const tokenUsage = normalizeTokenUsage(row.tokenUsage) || normalizeTokenUsage(row.usage) || normalizeTokenUsage(row.tokens)

  return { key, agentId, channel, peer, messageCount, lastActivity, model, label, tokenUsage }
}

export function fmtDate(d) { return d.toISOString().slice(0, 10) }

export function dedupSessions(sessions) {
  const seen = new Set()
  return sessions.filter(s => {
    const key = s.key || s.sessionKey || s.id
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function parseEnvFile(content) {
  const result = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

export function stringifyEnvFile(data) {
  const lines = []
  for (const [key, value] of Object.entries(data)) {
    const escaped = value.includes('\n') || value.includes('"') || value.includes("'")
      ? `"${value.replace(/"/g, '\\"')}"`
      : value
    lines.push(`${key}=${escaped}`)
  }
  return lines.join('\n') + '\n'
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export function expandHomePath(path) {
  if (!path) return path
  if (path.startsWith('~')) {
    return join(os.homedir(), path.slice(1))
  }
  return path
}

import { join, resolve, sep, relative } from 'path'
import os from 'os'

export function safePath(userPath, workspaceBase) {
  if (!workspaceBase) return null
  const expandedBase = resolve(expandHomePath(workspaceBase))
  const rawUserPath = String(userPath || '')
  const sanitizedUserPath = rawUserPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const targetPath = resolve(expandedBase, sanitizedUserPath)
  const rel = relative(expandedBase, targetPath)
  const escaped = rel.startsWith('..') || rel.includes(`..${sep}`) || rel === '..'
  if (escaped) {
    console.log('[Files] Path escape detected:', { base: expandedBase, target: targetPath, userPath: rawUserPath, sanitizedUserPath, relativePath: rel })
    return null
  }
  return targetPath
}

// Share / bootstrap helpers
export const BOOTSTRAP_INSTRUCTION_PREFIXES = [
  '[Bootstrap pending]',
  'Please read BOOTSTRAP.md',
  'If this run can complete',
  'If it cannot',
  'Do not pretend',
  'Do not use a generic',
  'Your first user-visible',
  'Bootstrap is still pending',
  'Typical next steps include',
]

export const TIMESTAMP_PREFIX_RE = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/

export function extractUserMessageFromBootstrap(content) {
  const lines = content.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (!trimmed) continue
    if (trimmed.startsWith('System:')) continue
    if (BOOTSTRAP_INSTRUCTION_PREFIXES.some(p => trimmed.startsWith(p))) continue
    start = i
    break
  }
  if (start >= 0) {
    const extracted = lines.slice(start).join('\n').trim()
    return extracted.replace(TIMESTAMP_PREFIX_RE, '')
  }
  return content
}

export function normalizeContent(content) {
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n')
  }
  return content || ''
}

export function filterBootstrapMessages(msgs) {
  let inBootstrap = false
  return msgs.map((m) => {
    if (m.role === 'system') return null
    const rawContent = normalizeContent(m.content)
    let content = rawContent.trimStart()
    if (content.startsWith('[Bootstrap')) {
      const userMsg = extractUserMessageFromBootstrap(content)
      if (userMsg) {
        inBootstrap = true
        return { ...m, role: 'user', content: userMsg }
      }
      return null
    }
    if (inBootstrap) {
      if (m.role === 'tool') return null
      if (m.role === 'assistant') {
        if (m.stopReason === 'toolUse') return null
        const bootstrapFileRe = /BOOTSTRAP\.md|USER\.md|SOUL\.md|AGENTS\.md/i
        if (bootstrapFileRe.test(content)) return null
        const stripped = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim()
        if (!stripped) return null
        inBootstrap = false
        return { ...m, content: rawContent }
      }
      if (m.role === 'user') {
        inBootstrap = false
        return { ...m, content: rawContent }
      }
    }
    if (m.role === 'user') {
      content = content.replace(TIMESTAMP_PREFIX_RE, '')
    }
    return rawContent === content ? { ...m, content: rawContent } : { ...m, content }
  }).filter((m) => m !== null)
}

// File preview helpers
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
export const TEXT_EXTS = new Set(['txt', 'md', 'js', 'ts', 'py', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'sh', 'bash', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sql', 'log', 'csv', 'env', 'toml', 'ini', 'cfg', 'conf'])
export const DOCX_EXTS = new Set(['docx', 'doc'])
export const PDF_EXTS = new Set(['pdf'])

export function getFilePreviewType(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (DOCX_EXTS.has(ext)) return 'docx'
  if (PDF_EXTS.has(ext)) return 'pdf'
  return 'binary'
}

export function normalizeUploadedFilename(name) {
  if (!name || typeof name !== 'string') return 'unnamed-file'
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8')
    if (decoded && !decoded.includes('�') && decoded !== name) {
      return decoded
    }
  } catch { /* fallback to original */ }
  return name
}
