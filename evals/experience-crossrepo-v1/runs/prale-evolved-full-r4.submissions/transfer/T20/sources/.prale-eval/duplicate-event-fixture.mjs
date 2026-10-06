// Executable duplicate-event contract fixture (task T20, repository wattclaw).
//
//   node .prale-eval/duplicate-event-fixture.mjs
//
// Contract under test: replaying ONE session update (the same Gateway event,
// byte-for-byte) must not double-count usage and must not emit duplicate state
// changes. The fixture drives the real modules
//   server/core/session-usage-cache.js
//   server/core/usage-sync.js
//   server/core/session-sync.js
// with only their db/gateway/user-manager boundaries replaced by in-memory
// doubles (see .prale-eval/harness/loader.mjs and harness/mocks.mjs).
//
// Distinctness: the fixture uses its own fixture markers
// (`FIXTURE_ID`, session key `agent:agent-a:dup-fixture*`, owner `user-dup-owner`)
// and its own in-memory doubles, so it cannot collide with, disable, or be
// satisfied by any other fixture in the repository.

import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./harness/loader.mjs', import.meta.url))

const mocks = await import('./harness/mocks.mjs')
const usageCache = await import('../server/core/session-usage-cache.js')
const usageSync = await import('../server/core/usage-sync.js')
const sessionSync = await import('../server/core/session-sync.js')

const FIXTURE_ID = 'dup-event-fixture/T20'
const OWNER = 'user-dup-owner'
const AGENT = 'agent-a'
const KEY = 'agent:agent-a:dup-fixture'
const KEY_META = 'agent:agent-a:dup-fixture-meta'

// The single replayed event. Values are absolute totals reported by the
// Gateway, never deltas.
const REPLAYED_EVENT = {
  fixture: FIXTURE_ID,
  key: KEY,
  agentId: AGENT,
  model: 'anthropic/claude-sonnet-4-6',
  usage: {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    totalCost: 0.5,
    messageCounts: { total: 4, user: 2, assistant: 2, toolCalls: 1, toolResults: 1, errors: 0 },
  },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let checks = 0
function check(description, fn) {
  fn()
  checks += 1
  console.log(`  ok ${checks} - ${description}`)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

console.log(`duplicate-event fixture: ${FIXTURE_ID}`)

// ---------------------------------------------------------------------------
// Phase 0 — metadata sync creates the row; usage columns start unstamped.
// ---------------------------------------------------------------------------
console.log('\nphase 0: metadata row exists, usage not yet stamped')
mocks.setOwnedAgents(OWNER, [AGENT])
const inserted = mocks.upsertSyncedUserSession({
  userId: OWNER,
  sessionKey: KEY,
  agentId: AGENT,
  channel: 'feishu',
  peer: 'ou_dup',
  label: 'duplicate-event fixture',
  lastActivity: Date.parse('2026-06-05T12:00:00.000Z'),
})
check('metadata insert reports changed=inserted', () => {
  assert.equal(inserted.action, 'inserted')
  assert.equal(inserted.changed, true)
})
check('usage row is unstamped before the first usage sync (usage_synced_at IS NULL)', () => {
  const row = mocks.getUsageRow(OWNER, KEY)
  assert.ok(row)
  assert.equal(row.usage_synced_at, null)
})

// ---------------------------------------------------------------------------
// Phase 1 — batch/startup path: replay the identical event twice.
// ---------------------------------------------------------------------------
console.log('\nphase 1: batchUpdateMatchedGatewayUsage replayed twice with the same event')
const batch1 = usageCache.batchUpdateMatchedGatewayUsage({ sessions: [clone(REPLAYED_EVENT)] })
const afterFirst = clone(mocks.getUsageRow(OWNER, KEY))
const batch2 = usageCache.batchUpdateMatchedGatewayUsage({ sessions: [clone(REPLAYED_EVENT)] })
const afterReplay = clone(mocks.getUsageRow(OWNER, KEY))

check('both replays write to exactly one owner-matched row', () => {
  assert.equal(batch1.scanned, 1)
  assert.equal(batch1.updated, 1)
  assert.equal(batch1.skippedConflict, 0)
  assert.equal(batch2.scanned, 1)
  assert.equal(batch2.updated, 1)
})
check('replay does not double-count tokens (SET, not accumulate)', () => {
  assert.equal(afterFirst.token_input, 100)
  assert.equal(afterFirst.token_output, 50)
  assert.equal(afterFirst.token_total, 150)
  assert.equal(afterReplay.token_input, 100, 'token_input must stay 100, not 200')
  assert.equal(afterReplay.token_output, 50, 'token_output must stay 50, not 100')
  assert.equal(afterReplay.token_total, 150, 'token_total must stay 150, not 300')
})
check('replay does not double-count cost or messages', () => {
  assert.equal(afterReplay.cost_total, 0.5, 'cost_total must stay 0.5, not 1.0')
  assert.equal(afterReplay.msg_total, 4, 'msg_total must stay 4, not 8')
  assert.equal(afterReplay.msg_user, 2)
  assert.equal(afterReplay.msg_assistant, 2)
  assert.equal(afterReplay.msg_tool_calls, 1)
})
check('replay never inserts a second physical row for the composite key', () => {
  assert.equal(mocks.usageRowsForSession(KEY).length, 1)
})
check('the write statement is owner-scoped and additive-free', () => {
  const updates = mocks.updateStatements()
  assert.ok(updates.length >= 2)
  for (const stmt of updates) {
    assert.match(stmt.sql, /WHERE user_id = \? AND session_key = \?/)
    assert.doesNotMatch(stmt.sql, /[+-]=|SUM\(|token_total = token_total/)
  }
})

// ---------------------------------------------------------------------------
// Phase 2 — event-driven path: two concurrent replays of the same key.
// ---------------------------------------------------------------------------
console.log('\nphase 2: syncSessionUsageNow replayed concurrently for one session key')
usageSync.__resetUsageSyncForTests()
mocks.gatewayState.usageCalls.length = 0
mocks.sseBroadcasts.length = 0
mocks.gatewayState.usageResponse = { sessions: [clone(REPLAYED_EVENT)] }

const p1 = usageSync.syncSessionUsageNow(KEY)
const p2 = usageSync.syncSessionUsageNow(KEY)
const [r1, r2] = await Promise.all([p1, p2])
const afterConcurrent = clone(mocks.getUsageRow(OWNER, KEY))

check('the second in-flight replay is coalesced onto the in-flight sync', () => {
  // syncSessionUsageNow is `async`, so each caller gets its own wrapper promise;
  // coalescing means both resolve to the ONE report produced by the single run.
  assert.equal(r1, r2)
  assert.equal(mocks.gatewayState.usageCalls.length, 1)
})
check('exactly one state-change (SSE) event is emitted', () => {
  assert.equal(mocks.sseBroadcasts.length, 1)
  const [event] = mocks.sseBroadcasts[0]
  assert.equal(event.event, 'session.usage.updated')
  assert.equal(event.payload.sessionKey, KEY)
  assert.equal(event.payload.messageCount, 4)
})
check('concurrent replay still does not double-count usage', () => {
  assert.equal(afterConcurrent.token_total, 150)
  assert.equal(afterConcurrent.cost_total, 0.5)
  assert.equal(afterConcurrent.msg_total, 4)
})

// ---------------------------------------------------------------------------
// Phase 3 — debounced scheduling: two events collapse into one sync.
// ---------------------------------------------------------------------------
console.log('\nphase 3: scheduleSessionUsageSync debounces repeated events for one key')
usageSync.__resetUsageSyncForTests()
const callsBefore = mocks.gatewayState.usageCalls.length
const broadcastsBefore = mocks.sseBroadcasts.length
usageSync.scheduleSessionUsageSync(KEY, { delayMs: 1 })
usageSync.scheduleSessionUsageSync(KEY, { delayMs: 1 })
await sleep(30)
const afterDebounce = clone(mocks.getUsageRow(OWNER, KEY))

check('two scheduled events produce exactly one Gateway sync and one event', () => {
  assert.equal(mocks.gatewayState.usageCalls.length - callsBefore, 1)
  assert.equal(mocks.sseBroadcasts.length - broadcastsBefore, 1)
})
check('debounced replay leaves counters unchanged', () => {
  assert.equal(afterDebounce.token_total, 150)
  assert.equal(afterDebounce.msg_total, 4)
})

// ---------------------------------------------------------------------------
// Phase 4 — metadata sync: replaying one session update is a no-op.
// ---------------------------------------------------------------------------
console.log('\nphase 4: syncUserSessionsFromGateway replayed with the same listed session')
sessionSync.resetSessionSyncStateForTests()
const listCalls = []
const gatewayRpc = async (method, params) => {
  listCalls.push({ method, params })
  assert.equal(method, 'sessions.list')
  return {
    ok: true,
    payload: {
      sessions: [{ key: KEY_META, agentId: AGENT, channel: 'feishu', peer: 'ou_dup_meta', lastActivity: 1783507200000 }],
    },
  }
}

const firstSync = await sessionSync.syncUserSessionsFromGateway({ userId: OWNER, role: 'user', gatewayRpc })
const listCallsAfterFirst = listCalls.length
const secondSync = await sessionSync.syncUserSessionsFromGateway({ userId: OWNER, role: 'user', gatewayRpc })

check('first metadata sync inserts the session once via sessions.list only', () => {
  assert.deepEqual(firstSync, { changed: 1, inserted: 1, updated: 0, scanned: 1, agents: 1 })
  assert.deepEqual([...new Set(listCalls.map((c) => c.method))], ['sessions.list'])
})
check('replayed metadata update reports changed=0 (no duplicate state change)', () => {
  assert.equal(secondSync.changed, 0)
  assert.equal(secondSync.scanned, 1)
  assert.equal(listCalls.length, listCallsAfterFirst + 1)
})
check('replay did not create a duplicate row for the session key', () => {
  assert.equal(mocks.usageRowsForSession(KEY_META).length, 1)
})

// ---------------------------------------------------------------------------
// Phase 5 — scheduling level: concurrent replays coalesce per user.
// ---------------------------------------------------------------------------
console.log('\nphase 5: scheduleUserSessionSync coalesces concurrent replays for one user')
sessionSync.resetSessionSyncStateForTests()
const callsBeforeCoalesce = listCalls.length
await Promise.all([
  sessionSync.scheduleUserSessionSync({ userId: OWNER, role: 'user', gatewayRpc, cooldownMs: 0 }),
  sessionSync.scheduleUserSessionSync({ userId: OWNER, role: 'user', gatewayRpc, cooldownMs: 0 }),
])

check('concurrent scheduled syncs for the same user issue one Gateway list call', () => {
  assert.equal(listCalls.length - callsBeforeCoalesce, 1)
})

console.log(`\nCONTRACT OK: ${checks} checks passed for ${FIXTURE_ID}`)
console.log('replaying one session update neither double-counted usage nor duplicated state changes')
