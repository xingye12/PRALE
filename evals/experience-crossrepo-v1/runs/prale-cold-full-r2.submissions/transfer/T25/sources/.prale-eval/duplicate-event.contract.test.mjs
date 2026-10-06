// Duplicate-event contract test (executable demo for T25 / wattclaw).
//
// Contract under test:
//   Replaying ONE session update (at-least-once delivery / gateway replay) must not
//   double-count usage and must not emit a duplicate state change.
//
// The demo runs the REAL repository code paths against an in-memory node:sqlite
// database that is injected in place of server/database.js (better-sqlite3 is not
// installable in this environment). Nothing else in the chain is re-implemented:
//   * server/core/session-sync.js       (real)  -> schedule/cooldown + changed counters
//   * server/user-manager.js            (real)  -> upsertSyncedUserSession idempotency
//   * server/core/usage-sync.js         (real)  -> in-flight coalescing + broadcast
//   * server/core/session-usage-cache.js(real)  -> absolute (non-additive) usage writes
// Only the external edges (gateway RPC, SSE transport, multi-tenant lookup) are stubbed.
//
// Run: node --experimental-test-module-mocks --test .prale-eval/duplicate-event.contract.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { after, before, beforeEach, describe, mock, test } from 'node:test'

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/duplicate-session-event.json', import.meta.url), 'utf8'),
)
const EXPECTED = FIXTURE.expectedAfterSingleLogicalDelivery
const FORBIDDEN = FIXTURE.forbiddenDoubleCount

// ---------------------------------------------------------------------------
// Fixture database (same DDL subset as server/database.js for the tables touched)
// ---------------------------------------------------------------------------

const fixtureDb = new DatabaseSync(':memory:')
fixtureDb.exec(`
  CREATE TABLE user_agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    gateway_agent_id TEXT,
    workspace TEXT,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT DEFAULT '{}',
    system_prompt TEXT,
    model TEXT,
    category TEXT,
    template_id TEXT,
    avatar TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );
  CREATE TABLE user_tenant_assignments (
    user_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    assignment_mode TEXT NOT NULL DEFAULT 'auto',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );
  CREATE TABLE user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    agent_id TEXT,
    label TEXT,
    channel TEXT,
    peer_id TEXT,
    display_title TEXT,
    last_message_at INTEGER,
    model TEXT,
    model_provider TEXT,
    token_input INTEGER DEFAULT 0,
    token_output INTEGER DEFAULT 0,
    token_cache_read INTEGER DEFAULT 0,
    token_cache_write INTEGER DEFAULT 0,
    token_total INTEGER DEFAULT 0,
    cost_total REAL DEFAULT 0,
    msg_total INTEGER DEFAULT 0,
    msg_user INTEGER DEFAULT 0,
    msg_assistant INTEGER DEFAULT 0,
    msg_tool_calls INTEGER DEFAULT 0,
    msg_tool_results INTEGER DEFAULT 0,
    msg_errors INTEGER DEFAULT 0,
    tool_usage_json TEXT DEFAULT '{}',
    usage_synced_at INTEGER,
    tenant_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );
  CREATE INDEX idx_user_sessions_session_key ON user_sessions(session_key);
`)

// better-sqlite3-compatible surface (prepare/exec/transaction) on top of node:sqlite.
const fixtureDbHandle = {
  prepare: (sql) => fixtureDb.prepare(sql),
  exec: (sql) => fixtureDb.exec(sql),
  pragma: () => {},
  transaction: (fn) => (...args) => {
    fixtureDb.exec('BEGIN')
    try {
      const result = fn(...args)
      fixtureDb.exec('COMMIT')
      return result
    } catch (error) {
      fixtureDb.exec('ROLLBACK')
      throw error
    }
  },
  close: () => fixtureDb.close(),
}

// ---------------------------------------------------------------------------
// External-edge stubs + module injection (must happen before importing the code
// under test, which would otherwise pull in better-sqlite3)
// ---------------------------------------------------------------------------

const broadcasts = []
const gatewayUsageCalls = []

mock.module(new URL('../server/database.js', import.meta.url).href, {
  defaultExport: fixtureDbHandle,
  namedExports: {
    ensureDefaultAdmin: () => {},
    initDatabase: () => fixtureDbHandle,
  },
})
mock.module(new URL('../server/openclaw-config-sync.js', import.meta.url).href, {
  namedExports: { syncAllTenantOpenClawConfigsFromDB: () => [] },
})
mock.module(new URL('../server/core/multi-tenant-gateway.js', import.meta.url).href, {
  namedExports: {
    getGatewayHttpTargetsForAllTenants: async () => null, // single-gateway mode
    getGatewayHttpTargetForCurrentRequest: async () => null,
  },
})
mock.module(new URL('../server/core/gateway-client.js', import.meta.url).href, {
  namedExports: {
    callGatewayUsage: async (params) => {
      gatewayUsageCalls.push(params)
      return { sessions: [structuredClone(FIXTURE.usageSnapshot)] }
    },
    callGatewayUsageForTarget: async () => {
      throw new Error('unexpected tenant target: fixture is single-gateway')
    },
  },
})
mock.module(new URL('../server/core/sse.js', import.meta.url).href, {
  namedExports: {
    broadcastSSE: (data, payload) => {
      broadcasts.push({ data, payload })
    },
  },
})

const sessionSync = await import('../server/core/session-sync.js')
const usageCache = await import('../server/core/session-usage-cache.js')
const usageSync = await import('../server/core/usage-sync.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedOwnership() {
  fixtureDb.exec('DELETE FROM user_agents; DELETE FROM user_tenant_assignments;')
  fixtureDb
    .prepare(`INSERT INTO user_agents (id, user_id, gateway_agent_id, name, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'active', 1, 1)`)
    .run('ua-duplicate-fixture', FIXTURE.userId, FIXTURE.agentId, 'Duplicate Event Agent')
  fixtureDb
    .prepare(`INSERT INTO user_tenant_assignments (user_id, tenant_id, assignment_mode, created_at, updated_at)
              VALUES (?, ?, 'auto', 1, 1)`)
    .run(FIXTURE.userId, FIXTURE.tenantId)
}

function clearSessions() {
  fixtureDb.exec('DELETE FROM user_sessions')
}

function seedSessionRow() {
  clearSessions()
  fixtureDb
    .prepare(`INSERT INTO user_sessions
              (id, user_id, session_key, agent_id, channel, peer_id, label, display_title, last_message_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`)
    .run(
      'us-duplicate-fixture',
      FIXTURE.userId,
      FIXTURE.sessionKey,
      FIXTURE.agentId,
      FIXTURE.sessionUpdate.channel,
      FIXTURE.sessionUpdate.peer,
      FIXTURE.sessionUpdate.displayTitle,
      FIXTURE.sessionUpdate.displayTitle,
      FIXTURE.sessionUpdate.lastMessageAt,
    )
}

function sessionRows() {
  return fixtureDb.prepare('SELECT * FROM user_sessions WHERE session_key = ?').all(FIXTURE.sessionKey)
}

function sessionRow() {
  return fixtureDb.prepare('SELECT * FROM user_sessions WHERE session_key = ?').get(FIXTURE.sessionKey)
}

// The duplicate delivery: the SAME update reaches the sync twice, in one batch
// and again as a replayed event.
function duplicatedSessionPayload() {
  return { sessions: [structuredClone(FIXTURE.sessionUpdate), structuredClone(FIXTURE.sessionUpdate)] }
}

function assertNoDoubleCount(row, label) {
  assert.equal(row.token_total, EXPECTED.tokenTotal, `${label}: token_total must equal the delivered snapshot`)
  assert.equal(row.msg_total, EXPECTED.msgTotal, `${label}: msg_total must equal the delivered snapshot`)
  assert.equal(row.msg_tool_calls, EXPECTED.msgToolCalls, `${label}: msg_tool_calls must equal the delivered snapshot`)
  assert.notEqual(row.token_total, FORBIDDEN.tokenTotal, `${label}: tokens were summed twice`)
  assert.notEqual(row.msg_total, FORBIDDEN.msgTotal, `${label}: messages were counted twice`)
  assert.notEqual(row.msg_tool_calls, FORBIDDEN.msgToolCalls, `${label}: tool calls were counted twice`)
  assert.equal(sessionRows().length, 1, `${label}: exactly one session row may exist`)
}

before(() => {
  seedOwnership()
})

beforeEach(() => {
  sessionSync.resetSessionSyncStateForTests()
  usageSync.__resetUsageSyncForTests()
  broadcasts.length = 0
  gatewayUsageCalls.length = 0
})

after(() => {
  fixtureDb.close()
})

// ---------------------------------------------------------------------------
// Suite 1 — session metadata sync (server/core/session-sync.js)
// ---------------------------------------------------------------------------

describe('duplicate-event contract: session metadata sync', () => {
  test('fixture is distinct from the repository test fixtures', () => {
    const existingSuites = [
      readFileSync(new URL('../server/core/session-sync.test.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../server/core/usage-sync.test.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../server/core/session-usage-cache.test.js', import.meta.url), 'utf8'),
    ].join('\n')
    assert.equal(FIXTURE.distinct, true)
    assert.ok(
      FIXTURE.sessionKey.includes(FIXTURE.distinctMarker),
      'fixture session key carries its own distinct marker',
    )
    assert.ok(
      !existingSuites.includes(FIXTURE.sessionKey),
      'fixture session key must not collide with an existing suite fixture',
    )
    assert.ok(
      !existingSuites.includes(FIXTURE.userId),
      'fixture user id must not collide with an existing suite fixture',
    )
  })

  test('fixture is sensitive: an additive writer would land on the forbidden double-count values', () => {
    assert.equal(FIXTURE.usageSnapshot.usage.totalTokens * FIXTURE.deliveries, FORBIDDEN.tokenTotal)
    assert.equal(FIXTURE.usageSnapshot.usage.messageCounts.total * FIXTURE.deliveries, FORBIDDEN.msgTotal)
    assert.equal(FIXTURE.usageSnapshot.usage.messageCounts.toolCalls * FIXTURE.deliveries, FORBIDDEN.msgToolCalls)
    assert.equal(EXPECTED.stateChangeRows + 1, FORBIDDEN.stateChangeRows)
    assert.notEqual(FIXTURE.usageSnapshot.usage.totalTokens, FORBIDDEN.tokenTotal)
  })

  test('a duplicated session update produces exactly one state change and replays as unchanged', async () => {
    seedOwnership()
    clearSessions()
    let rpcCalls = 0
    const gatewayRpc = async (method) => {
      rpcCalls += 1
      assert.equal(method, 'sessions.list')
      return { ok: true, payload: duplicatedSessionPayload() }
    }

    const first = await sessionSync.syncUserSessionsFromGateway({
      userId: FIXTURE.userId,
      role: 'user',
      gatewayRpc,
    })

    assert.equal(first.scanned, FIXTURE.deliveries, 'both deliveries are scanned')
    assert.equal(first.changed, EXPECTED.changed, 'the duplicated update yields ONE state change')
    assert.equal(first.inserted, EXPECTED.inserted)
    assert.equal(first.updated, EXPECTED.updated)
    assert.equal(sessionRows().length, EXPECTED.stateChangeRows, 'exactly one row is materialized')

    const afterFirst = sessionRow()
    assert.equal(afterFirst.user_id, FIXTURE.userId)
    assert.equal(afterFirst.agent_id, FIXTURE.agentId)
    assert.equal(afterFirst.tenant_id, FIXTURE.tenantId)
    assert.equal(afterFirst.last_message_at, FIXTURE.sessionUpdate.lastMessageAt)

    // Replay of the same event after it was already applied.
    const replay = await sessionSync.syncUserSessionsFromGateway({
      userId: FIXTURE.userId,
      role: 'user',
      gatewayRpc,
    })

    assert.equal(replay.scanned, FIXTURE.deliveries)
    assert.equal(replay.changed, 0, 'a replayed update is not a new state change')
    assert.equal(replay.inserted, 0)
    assert.equal(replay.updated, 0)

    const afterReplay = sessionRow()
    assert.equal(sessionRows().length, EXPECTED.stateChangeRows)
    assert.equal(afterReplay.updated_at, afterFirst.updated_at, 'replay must not rewrite the row')
    assert.equal(afterReplay.last_message_at, afterFirst.last_message_at)
    assert.equal(rpcCalls, 2)
  })

  test('a replayed event inside the cooldown window is skipped instead of re-emitted', async () => {
    seedOwnership()
    clearSessions()
    let rpcCalls = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const gatewayRpc = async () => {
      rpcCalls += 1
      await gate
      return { ok: true, payload: { sessions: [structuredClone(FIXTURE.sessionUpdate)] } }
    }

    const first = sessionSync.scheduleUserSessionSync({
      userId: FIXTURE.userId,
      role: 'user',
      gatewayRpc,
      cooldownMs: 60_000,
    })
    const duplicateWhileInFlight = sessionSync.scheduleUserSessionSync({
      userId: FIXTURE.userId,
      role: 'user',
      gatewayRpc,
      cooldownMs: 60_000,
    })

    assert.equal(rpcCalls, 1, 'the duplicate in-flight event is coalesced, not re-issued')
    release()

    const [a, b] = await Promise.all([first, duplicateWhileInFlight])
    assert.equal(a.changed, EXPECTED.changed)
    assert.equal(a, b, 'the duplicate event resolves to the same in-flight result')
    assert.equal(sessionRows().length, EXPECTED.stateChangeRows)
    const afterFirst = sessionRow()

    const replayAfterCompletion = await sessionSync.scheduleUserSessionSync({
      userId: FIXTURE.userId,
      role: 'user',
      gatewayRpc,
      cooldownMs: 60_000,
    })

    assert.deepEqual(replayAfterCompletion, { changed: 0, skipped: true, reason: 'cooldown' })
    assert.equal(rpcCalls, 1, 'no extra gateway round-trip for the replayed event')
    assert.equal(sessionRow().updated_at, afterFirst.updated_at, 'replay emits no state change')
    assert.equal(sessionRows().length, EXPECTED.stateChangeRows)
  })
})

// ---------------------------------------------------------------------------
// Suite 2 — usage sync (server/core/usage-sync.js + session-usage-cache.js)
// ---------------------------------------------------------------------------

describe('duplicate-event contract: session usage sync', () => {
  test('replaying one usage event keeps the absolute totals (no double count)', async () => {
    seedOwnership()
    seedSessionRow()

    const first = await usageSync.syncSessionUsageNow(FIXTURE.sessionKey)
    assert.equal(first.scanned, 1)
    assert.equal(first.updated, 1)
    assert.deepEqual(gatewayUsageCalls, [{ key: FIXTURE.sessionKey, limit: 1 }])

    const afterFirst = sessionRow()
    assertNoDoubleCount(afterFirst, 'after first delivery')
    const entryAfterFirst = usageCache.getSessionUsage(FIXTURE.sessionKey, FIXTURE.userId)
    assert.equal(entryAfterFirst.tokenTotal, EXPECTED.tokenTotal)
    assert.equal(entryAfterFirst.msgTotal, EXPECTED.msgTotal)
    assert.equal(entryAfterFirst.model, 'gpt-4o')
    assert.equal(entryAfterFirst.modelProvider, 'openai')
    assert.deepEqual(entryAfterFirst.toolUsage, FIXTURE.usageSnapshot.usage.toolUsage.tools)

    // Replay of the very same event.
    const replay = await usageSync.syncSessionUsageNow(FIXTURE.sessionKey)
    assert.equal(replay.updated, 1, 'the replayed event still matches exactly one owned session row')

    const afterReplay = sessionRow()
    assertNoDoubleCount(afterReplay, 'after replay')
    assert.equal(afterReplay.msg_total, afterFirst.msg_total)
    assert.equal(afterReplay.token_total, afterFirst.token_total)
    assert.ok(
      afterReplay.usage_synced_at >= afterFirst.usage_synced_at,
      'replay refreshes the sync marker only',
    )

    assert.equal(broadcasts.length, 2)
    for (const broadcast of broadcasts) {
      assert.equal(broadcast.data.event, 'session.usage.updated')
      assert.equal(
        broadcast.payload.messageCount,
        EXPECTED.messageCount,
        'every emission carries the authoritative absolute count, never an accumulated delta',
      )
      assert.notEqual(broadcast.payload.messageCount, FORBIDDEN.messageCount)
    }
  })

  test('concurrent duplicate deliveries collapse to one gateway fetch, one write, one emission', async () => {
    seedOwnership()
    seedSessionRow()

    const results = await Promise.all(
      Array.from({ length: FIXTURE.deliveries + 1 }, () => usageSync.syncSessionUsageNow(FIXTURE.sessionKey)),
    )

    assert.equal(gatewayUsageCalls.length, 1, 'duplicate in-flight events share one gateway fetch')
    assert.deepEqual(gatewayUsageCalls[0], { key: FIXTURE.sessionKey, limit: 1 })
    assert.equal(broadcasts.length, 1, 'duplicate in-flight events emit ONE state change')
    assert.equal(broadcasts[0].payload.messageCount, EXPECTED.messageCount)
    assert.equal(results[0], results[FIXTURE.deliveries], 'all deliveries resolve to the same report object')
    assert.equal(results[0].updated, 1)

    assertNoDoubleCount(sessionRow(), 'after concurrent duplicate deliveries')
  })
})
