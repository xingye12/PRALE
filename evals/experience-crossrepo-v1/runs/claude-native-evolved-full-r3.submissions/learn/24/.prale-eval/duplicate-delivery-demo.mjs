/**
 * Executable demo: duplicate delivery is harmless for session synchronization.
 *
 * Runs the REAL source of server/core/session-sync.js. The only substitution is
 * the `../user-manager.js` dependency, which is replaced with an in-memory store
 * whose `upsertSyncedUserSession` mirrors the idempotency contract of the real
 * implementation in server/user-manager.js (keyed on session_key; identical
 * projection => { changed: false, action: 'unchanged' }).
 *
 * That substitution is required only because node_modules (better-sqlite3) is
 * not installed in this environment. Every function under test is the verbatim
 * repository source, imported from a data: URL.
 *
 * Run: node .prale-eval/duplicate-delivery-demo.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// --- Load the real session-sync.js source, swapping only user-manager.js -----
const SRC_PATH = join(repoRoot, 'server/core/session-sync.js')
const IMPORT_BLOCK = `import {
  getAllGatewayAgentIds,
  getUserOwnedAgentIds,
  upsertSyncedUserSession,
} from '../user-manager.js'`

const source = readFileSync(SRC_PATH, 'utf8')
assert.ok(source.includes(IMPORT_BLOCK), 'expected user-manager import block in session-sync.js')

// In-memory stand-in for user-manager.js, honouring the real upsert contract.
const STUB = `
const store = new Map()
const ownedByUser = new Map()
export const __store = store
export function getAllGatewayAgentIds() {
  return [...new Set([...ownedByUser.values()].flat())]
}
export function getUserOwnedAgentIds(userId) {
  return ownedByUser.get(userId) || []
}
export function __setOwned(userId, ids) { ownedByUser.set(userId, ids) }
export function upsertSyncedUserSession({ userId, sessionKey, agentId, channel, peer, label, lastActivity }) {
  if (!userId || !sessionKey) return { changed: false, action: 'skipped' }
  const lastMessageAt = lastActivity == null ? null : (Number(lastActivity) || null)
  const existing = store.get(sessionKey)
  if (!existing) {
    store.set(sessionKey, {
      userId, agentId: agentId || null, channel: channel || null,
      peer: peer || null, label: label || null, lastMessageAt,
    })
    return { changed: true, action: 'inserted' }
  }
  const nextAgentId = agentId || existing.agentId || null
  const nextChannel = channel || existing.channel || null
  const nextPeer = peer || existing.peer || null
  const nextLabel = existing.label || label || null
  const current = Number(existing.lastMessageAt) || 0
  const nextLastMessageAt = lastMessageAt == null
    ? existing.lastMessageAt || null
    : Math.max(current, lastMessageAt)
  const changed =
    nextAgentId !== (existing.agentId || null) ||
    nextChannel !== (existing.channel || null) ||
    nextPeer !== (existing.peer || null) ||
    nextLabel !== (existing.label || null) ||
    nextLastMessageAt !== (existing.lastMessageAt || null)
  if (!changed) return { changed: false, action: 'unchanged' }
  store.set(sessionKey, {
    userId, agentId: nextAgentId, channel: nextChannel,
    peer: nextPeer, label: nextLabel, lastMessageAt: nextLastMessageAt,
  })
  return { changed: true, action: 'updated' }
}
`

const patched = source.replace(IMPORT_BLOCK, STUB)
const mod = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'))

const {
  syncUserSessionsFromGateway,
  scheduleUserSessionSync,
  resetSessionSyncStateForTests,
  __store,
} = mod

// user-manager stub setters are re-exported through the same module namespace.
const { __setOwned } = mod

const results = []
const record = (name, detail) => {
  results.push({ name, ...detail })
  console.log(`PASS  ${name}  ${JSON.stringify(detail)}`)
}

// --- Scenario A: the same Gateway delivery repeated is a no-op --------------
{
  resetSessionSyncStateForTests()
  __store.clear()
  __setOwned('user-1', ['agent-a'])

  const payload = {
    ok: true,
    payload: {
      sessions: [
        { key: 'agent:agent-a:s1', agentId: 'agent-a', peer: 'ou_1', updatedAt: 1000 },
        { key: 'agent:agent-a:s2', agentId: 'agent-a', peer: 'ou_2', updatedAt: 2000 },
      ],
    },
  }
  const gatewayRpc = async () => JSON.parse(JSON.stringify(payload))

  const first = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc })
  const second = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc })

  assert.equal(first.changed, 2, 'first delivery inserts both sessions')
  assert.equal(second.changed, 0, 'identical redelivery changes nothing')
  assert.equal(second.scanned, first.scanned, 'redelivery still scans the same rows')
  assert.equal(__store.size, 2, 'no duplicate rows created')
  record('A. identical redelivery is idempotent', {
    firstChanged: first.changed, secondChanged: second.changed, rows: __store.size,
  })
}

// --- Scenario B: a stale/duplicate replay cannot regress state --------------
{
  resetSessionSyncStateForTests()
  __store.clear()
  __setOwned('user-1', ['agent-a'])

  const fresh = { key: 'agent:agent-a:s1', agentId: 'agent-a', peer: 'ou_1', updatedAt: 5000 }
  const stale = { key: 'agent:agent-a:s1', agentId: 'agent-a', peer: 'ou_1', updatedAt: 1000 }
  const rpcFor = (row) => async () => ({ ok: true, payload: { sessions: [row] } })

  const first = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc: rpcFor(fresh) })
  const replay = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc: rpcFor(stale) })

  assert.equal(first.changed, 1)
  assert.equal(replay.changed, 0, 'older replay is absorbed, no regression')
  assert.equal(__store.get('agent:agent-a:s1').lastMessageAt, 5000, 'max() keeps newest activity')
  record('B. out-of-order duplicate cannot regress', { replayChanged: replay.changed, lastMessageAt: 5000 })
}

// --- Scenario C: concurrent duplicate scheduling coalesces ------------------
{
  resetSessionSyncStateForTests()
  __store.clear()
  __setOwned('user-1', ['agent-a'])

  let calls = 0
  const gatewayRpc = async () => {
    calls += 1
    await new Promise(r => setTimeout(r, 15))
    return { ok: true, payload: { sessions: [{ key: 'agent:agent-a:s1', agentId: 'agent-a' }] } }
  }

  const [a, b] = await Promise.all([
    scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 0 }),
    scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 0 }),
  ])

  assert.equal(calls, 1, 'second duplicate schedule reuses the in-flight sync')
  assert.equal(a, b, 'both callers observe the same promise result')
  record('C. concurrent duplicate schedules coalesce', { gatewayCalls: calls })
}

// --- Scenario D: cooldown absorbs a rapid duplicate -------------------------
{
  resetSessionSyncStateForTests()
  __store.clear()
  __setOwned('user-1', ['agent-a'])

  let calls = 0
  const gatewayRpc = async () => {
    calls += 1
    return { ok: true, payload: { sessions: [{ key: 'agent:agent-a:s1', agentId: 'agent-a' }] } }
  }

  const first = await scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 60_000 })
  const second = await scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 60_000 })

  assert.equal(first.changed, 1)
  assert.equal(second.skipped, true, 'rapid duplicate is absorbed by cooldown')
  assert.equal(second.reason, 'cooldown')
  assert.equal(calls, 1, 'only one Gateway call')
  record('D. cooldown absorbs rapid duplicate', { gatewayCalls: calls, reason: second.reason })
}

console.log('\nNORMALIZED OPERATION RESULT')
console.log(JSON.stringify({
  operation: 'duplicate-delivery-vs-session-sync',
  verdict: 'duplicate delivery is harmless (idempotent)',
  source: 'server/core/session-sync.js',
  scenarios: results,
}, null, 2))
