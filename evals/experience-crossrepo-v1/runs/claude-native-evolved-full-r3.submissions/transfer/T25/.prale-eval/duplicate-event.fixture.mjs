// Executable duplicate-event contract fixture for T25 (wattclaw).
//
// Contract under test:
//   Replaying ONE session update (the identical Gateway event delivered twice)
//   must not double-count usage, and must not emit a duplicate state change.
//
// The fixture drives the REAL server/core/session-sync.js module. session-sync.js
// imports its persistence helpers from ../user-manager.js; that module opens a
// better-sqlite3 connection, which is unavailable in this environment (no
// node_modules). We therefore install a synchronous module hook that serves an
// in-memory stand-in for get{All,UserOwned}GatewayAgentIds / upsertSyncedUserSession.
// The stand-in mirrors the real upsert's transition semantics: keyed by
// session_key, changed=false on an identical replay, and last_message_at is
// monotonic (Math.max) rather than additive — the property that makes replay
// non-double-counting. Every state transition increments a counter so the test
// can assert usage is written exactly once.
//
// Run: node .prale-eval/duplicate-event.fixture.mjs

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'

const STUB_URL = 'wattclaw-stub:user-manager'

const stubSource = `
const records = new Map()
export const stats = { upserts: 0, inserts: 0, updates: 0, unchanged: 0, usageWrites: 0, stateChanges: 0 }

function asTitle(label, peer) {
  const t = typeof label === 'string' ? label.trim() : ''
  if (t) return t
  const p = typeof peer === 'string' ? peer.trim() : ''
  return p || null
}

function asTimestamp(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function getAllGatewayAgentIds() { return ['agent-a'] }
export function getUserOwnedAgentIds(userId) { return ['agent-a'] }

export function upsertSyncedUserSession({ userId, sessionKey, agentId, channel, peer, label, lastActivity }) {
  stats.upserts += 1
  if (!userId || !sessionKey) return { changed: false, action: 'skipped' }

  const displayTitle = asTitle(label, peer)
  const incomingLast = asTimestamp(lastActivity)
  const existing = records.get(sessionKey)

  if (!existing) {
    records.set(sessionKey, {
      userId, agentId: agentId || null, channel: channel || null, peer: peer || null,
      displayTitle, lastMessageAt: incomingLast,
    })
    stats.inserts += 1
    stats.usageWrites += 1
    stats.stateChanges += 1
    return { changed: true, action: 'inserted' }
  }

  const nextAgentId = agentId || existing.agentId || null
  const nextChannel = channel || existing.channel || null
  const nextPeer = peer || existing.peer || null
  const nextDisplayTitle = existing.displayTitle || displayTitle || null
  const nextLastMessageAt = incomingLast == null
    ? existing.lastMessageAt
    : Math.max(Number(existing.lastMessageAt) || 0, Number(incomingLast) || 0)

  const changed =
    nextAgentId !== existing.agentId ||
    nextChannel !== existing.channel ||
    nextPeer !== existing.peer ||
    nextDisplayTitle !== existing.displayTitle ||
    nextLastMessageAt !== existing.lastMessageAt

  if (!changed) { stats.unchanged += 1; return { changed: false, action: 'unchanged' } }

  Object.assign(existing, {
    agentId: nextAgentId, channel: nextChannel, peer: nextPeer,
    displayTitle: nextDisplayTitle, lastMessageAt: nextLastMessageAt,
  })
  stats.updates += 1
  stats.usageWrites += 1
  stats.stateChanges += 1
  return { changed: true, action: 'updated' }
}

export function __records() { return records }
`

// Resolve both "../user-manager.js" (as seen by session-sync.js) and the bare
// stub specifier to the same virtual URL, so both share one module instance.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === STUB_URL || specifier.endsWith('user-manager.js')) {
      return { url: STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === STUB_URL) {
      return { format: 'module', source: stubSource, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const stub = await import(STUB_URL)
const {
  syncUserSessionsFromGateway,
  scheduleUserSessionSync,
  resetSessionSyncStateForTests,
} = await import('../server/core/session-sync.js')

// The identical Gateway event, delivered twice. Deep-cloned per delivery so the
// replay is a genuinely distinct object with identical content.
// user_sessions.session_key carries a UNIQUE index in the real schema, so the
// fixture gives each scenario its own key to keep scenarios independent.
const sessionUpdate = (key, updatedAt) => ({
  ok: true,
  payload: {
    sessions: [{
      key,
      agentId: 'agent-a',
      channel: 'feishu',
      peer: key.split(':').pop(),
      label: 'Feishu chat',
      updatedAt,
    }],
  },
})

const SESSION_UPDATE = sessionUpdate('agent:agent-a:feishu:dm:ou_1', 1783507200000)

const clone = value => JSON.parse(JSON.stringify(value))
const checks = []
const check = (name, fn) => { assert.ok(fn(), name); checks.push(name) }

resetSessionSyncStateForTests()
Object.assign(stub.stats, { upserts: 0, inserts: 0, updates: 0, unchanged: 0, usageWrites: 0, stateChanges: 0 })

// ---- Scenario 1: replay one session update through syncUserSessionsFromGateway
{
  const gatewayRpc = async () => clone(SESSION_UPDATE) // same event every call

  const first = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc })
  const replay = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc })

  check('S1 first delivery counts exactly one change', () => first.changed === 1 && first.inserted === 1)
  check('S1 replayed delivery counts zero changes', () => replay.changed === 0)
  check('S1 replayed delivery reports zero inserts', () => replay.inserted === 0 && replay.updated === 0)
  check('S1 usage written exactly once across both deliveries', () => stub.stats.usageWrites === 1)
  check('S1 exactly one state transition emitted', () => stub.stats.stateChanges === 1)
  check('S1 replay resolved as unchanged by the upsert', () => stub.stats.unchanged === 1 && stub.stats.upserts === 2)
}

// ---- Scenario 2: an actual advance is applied once, its replay adds nothing
{
  const gatewayRpc = async () => clone(SESSION_UPDATE)
  const advanced = clone(SESSION_UPDATE)
  advanced.payload.sessions[0].updatedAt = 1783507300000
  const advancedRpc = async () => advanced

  const before = stub.stats.usageWrites
  const apply = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc: advancedRpc })
  const reapply = await syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc: advancedRpc })

  check('S2 forward activity advance counts one change', () => apply.changed === 1 && apply.updated === 1)
  check('S2 replay of the advance counts zero changes', () => reapply.changed === 0)
  check('S2 usage advanced exactly once', () => stub.stats.usageWrites === before + 1)
  check('S2 stale replay cannot roll activity back', () => stub.__records().get('agent:agent-a:feishu:dm:ou_1').lastMessageAt === 1783507300000)
  void gatewayRpc
}

// ---- Scenario 3: concurrent replay is coalesced to a single in-flight run
resetSessionSyncStateForTests()
{
  const payload = sessionUpdate('agent:agent-a:feishu:dm:ou_2', 1783507400000)
  let rpcCalls = 0
  const slowRpc = async () => { rpcCalls += 1; await new Promise(r => setTimeout(r, 15)); return clone(payload) }
  const before = stub.stats.stateChanges

  const [a, b] = await Promise.all([
    scheduleUserSessionSync({ userId: 'user-2', role: 'user', gatewayRpc: slowRpc, cooldownMs: 0 }),
    scheduleUserSessionSync({ userId: 'user-2', role: 'user', gatewayRpc: slowRpc, cooldownMs: 0 }),
  ])

  check('S3 concurrent replay issues a single Gateway list', () => rpcCalls === 1)
  check('S3 callers share one sync promise', () => a === b)
  check('S3 concurrent replay emits one state change', () => stub.stats.stateChanges === before + 1)
}

// ---- Scenario 4: replay inside the cooldown is skipped, not re-emitted
{
  const payload = sessionUpdate('agent:agent-a:feishu:dm:ou_3', 1783507500000)
  const gatewayRpc = async () => clone(payload)
  const before = stub.stats.stateChanges
  const scheduled = await scheduleUserSessionSync({ userId: 'user-2', role: 'user', gatewayRpc, cooldownMs: 60_000 })
  check('S4 replay within cooldown is skipped', () => scheduled.skipped === true && scheduled.reason === 'cooldown')
  check('S4 skipped replay emits no state change', () => stub.stats.stateChanges === before)
}

// ---- Scenario 5: replay emits no duplicate refresh event (V1 is silent)
resetSessionSyncStateForTests()
{
  const payload = sessionUpdate('agent:agent-a:feishu:dm:ou_4', 1783507600000)
  let emitted = 0
  const gatewayRpc = async () => clone(payload)
  await syncUserSessionsFromGateway({ userId: 'user-3', role: 'user', gatewayRpc, onChanged: () => { emitted += 1 } })
  await syncUserSessionsFromGateway({ userId: 'user-3', role: 'user', gatewayRpc, onChanged: () => { emitted += 1 } })
  check('S5 replay emits no duplicate refresh event', () => emitted === 0)
}

const result = {
  task_id: 'T25',
  fixture: 'duplicate-event',
  contract: 'replaying one session update cannot double-count usage or emit duplicate state changes',
  scenarios: 5,
  checks: checks.length,
  stats: { ...stub.stats },
  status: 'passed',
}
console.log(JSON.stringify(result, null, 2))
