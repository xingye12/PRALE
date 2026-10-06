// Duplicate-event fixture for the session-sync contract.
//
// Executes the REAL server/core/session-sync.js (with only its single
// ../user-manager.js dependency swapped for the in-memory stub) and replays
// one identical Gateway session update. Contract under test:
//   replaying one session update must not double-count usage and must not emit
//   a duplicate state change.
//
// Run: node .prale-eval/fixtures/duplicate-event/run.mjs

import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)

const stub = await import(new URL('./user-manager.stub.mjs', import.meta.url).href)
const { syncUserSessionsFromGateway, scheduleUserSessionSync, resetSessionSyncStateForTests } =
  await import('../../../server/core/session-sync.js')

const SESSION_KEY = 'agent:agent-a:feishu:dm:ou_dup_event_1'
// The one incoming update, replayed verbatim.
const DUPLICATE_EVENT = Object.freeze({
  key: SESSION_KEY,
  agentId: 'agent-a',
  channel: 'feishu',
  peer: 'ou_dup_event_1',
  displayTitle: 'Duplicate event fixture',
  lastMessageAt: '2026-06-05T12:00:00.000Z',
})

const results = {}
function check(name, fn) {
  fn()
  results[name] = 'pass'
}

// ---- Fixture setup -------------------------------------------------------
stub.__reset()
stub.__setOwnedAgentIds(['agent-a'])
resetSessionSyncStateForTests()

let gatewayCalls = 0
const gatewayRpc = async (method, params) => {
  gatewayCalls += 1
  assert.equal(method, 'sessions.list')
  assert.equal(params.agentId, 'agent-a')
  return { ok: true, payload: { sessions: [DUPLICATE_EVENT] } }
}

const syncOnce = () => syncUserSessionsFromGateway({ userId: 'user-1', role: 'user', gatewayRpc })

const first = await syncOnce()
const writesAfterFirst = stub.__writeCount()
const usageAfterFirst = { ...stub.__usageFor(SESSION_KEY) }

check('first delivery inserts exactly one row and counts it once', () => {
  assert.deepEqual(
    { changed: first.changed, inserted: first.inserted, updated: first.updated, scanned: first.scanned },
    { changed: 1, inserted: 1, updated: 0, scanned: 1 },
  )
  assert.equal(writesAfterFirst, 1)
  assert.equal(usageAfterFirst.msgTotal, 1)
})

// ---- Replay the identical event -----------------------------------------
const second = await syncOnce()
const writesAfterReplay = stub.__writeCount()
const usageAfterReplay = { ...stub.__usageFor(SESSION_KEY) }

check('replayed update emits no duplicate state change', () => {
  assert.equal(second.changed, 0)
  assert.equal(second.inserted, 0)
  assert.equal(second.updated, 0)
  assert.equal(second.scanned, 1, 'the event is still scanned, it is just not applied')
  assert.equal(writesAfterReplay, writesAfterFirst, 'no extra write on replay')
})

check('replayed update does not double-count usage', () => {
  assert.equal(usageAfterReplay.msgTotal, usageAfterFirst.msgTotal, 'usage total is absolute, not re-accumulated')
  assert.equal(usageAfterReplay.applied, usageAfterFirst.applied, 'usage applied once per real change')
})

// ---- Third replay, via the scheduler path -------------------------------
const before = gatewayCalls
const scheduled = await Promise.all([
  scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 0 }),
  scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 0 }),
])
check('concurrent replays coalesce to a single in-flight sync', () => {
  assert.equal(gatewayCalls - before, 1, 'second scheduled replay reused the in-flight promise')
  assert.equal(scheduled[0], scheduled[1])
  assert.equal(scheduled[0].changed, 0)
  assert.equal(stub.__writeCount(), writesAfterFirst)
  assert.equal(stub.__usageFor(SESSION_KEY).msgTotal, 1)
})

// ---- Distinct event still applies (guards against over-suppression) -----
const distinct = await syncUserSessionsFromGateway({
  userId: 'user-1',
  role: 'user',
  gatewayRpc: async () => ({
    ok: true,
    payload: {
      sessions: [{ ...DUPLICATE_EVENT, lastMessageAt: '2026-06-05T13:00:00.000Z' }],
    },
  }),
})
check('a genuinely new update is still applied exactly once', () => {
  assert.equal(distinct.changed, 1)
  assert.equal(distinct.updated, 1)
  assert.equal(stub.__writeCount(), writesAfterFirst + 1)
})

const report = {
  fixture: 'duplicate-event',
  sessionKey: SESSION_KEY,
  firstRun: { changed: first.changed, inserted: first.inserted },
  replayedRun: { changed: second.changed, inserted: second.inserted, updated: second.updated },
  usage: { afterFirst: usageAfterFirst.msgTotal, afterReplay: usageAfterReplay.msgTotal },
  stateWrites: { afterFirst: writesAfterFirst, afterReplay: writesAfterReplay },
  checks: results,
}
console.log(JSON.stringify(report, null, 2))
console.log('duplicate-event contract: PASS')
