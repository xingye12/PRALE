import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../user-manager.js', () => ({
  getAllGatewayAgentIds: vi.fn(),
  getUserOwnedAgentIds: vi.fn(),
  upsertSyncedUserSession: vi.fn(),
}))

const userManager = await import('../user-manager.js')
const syncModule = await import('./session-sync.js')

const {
  DEFAULT_SESSION_SYNC_OPTIONS,
  normalizeGatewaySessionForSync,
  syncUserSessionsFromGateway,
  scheduleUserSessionSync,
  resetSessionSyncStateForTests,
} = syncModule

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionSyncStateForTests()
  })

  it('normalizes stable and legacy Gateway session fields', () => {
    const item = {
      sessionKey: 'agent:agent-a:feishu-peer-1',
      agentId: 'agent-a',
      channel: 'feishu',
      peer: 'ou_xxx',
      label: 'Feishu chat',
      lastActivity: '2026-06-05T12:00:00.000Z',
    }

    expect(normalizeGatewaySessionForSync(item, 'fallback')).toEqual({
      sessionKey: 'agent:agent-a:feishu-peer-1',
      agentId: 'agent-a',
      channel: 'feishu',
      peer: 'ou_xxx',
      label: 'Feishu chat',
      lastActivity: '2026-06-05T12:00:00.000Z',
    })
  })

  it('uses Gateway updatedAt as activity when lastMessageAt is absent', () => {
    const item = {
      key: 'agent:agent-a:feishu:dm:ou_xxx',
      agentId: 'agent-a',
      updatedAt: 1783507200000,
    }

    expect(normalizeGatewaySessionForSync(item, 'fallback')).toMatchObject({
      sessionKey: 'agent:agent-a:feishu:dm:ou_xxx',
      lastActivity: 1783507200000,
    })
  })

  it('queries only user-owned agents with explicit agentId and bounded limit', async () => {
    userManager.getUserOwnedAgentIds.mockReturnValue(['agent-a', 'agent-b'])
    userManager.upsertSyncedUserSession.mockReturnValue({ changed: true, action: 'inserted' })
    const gatewayRpc = vi.fn(async (_method, params) => ({
      ok: true,
      payload: { sessions: [{ key: `agent:${params.agentId}:s1`, agentId: params.agentId }] },
    }))

    const result = await syncUserSessionsFromGateway({
      userId: 'user-1',
      role: 'user',
      gatewayRpc,
    })

    expect(result.changed).toBe(2)
    expect(gatewayRpc).toHaveBeenCalledTimes(2)
    expect(gatewayRpc).toHaveBeenNthCalledWith(1, 'sessions.list', { agentId: 'agent-a', limit: DEFAULT_SESSION_SYNC_OPTIONS.perAgentLimit })
    expect(gatewayRpc).toHaveBeenNthCalledWith(2, 'sessions.list', { agentId: 'agent-b', limit: DEFAULT_SESSION_SYNC_OPTIONS.perAgentLimit })
    expect(gatewayRpc).not.toHaveBeenCalledWith('sessions.list', {})
    for (const [method, params] of gatewayRpc.mock.calls) {
      expect(method).toBe('sessions.list')
      expect(params).toMatchObject({ limit: DEFAULT_SESSION_SYNC_OPTIONS.perAgentLimit })
      expect(typeof params.agentId).toBe('string')
      expect(params.agentId.length).toBeGreaterThan(0)
    }
  })

  it('drops sessions for agents outside the user ownership set', async () => {
    userManager.getUserOwnedAgentIds.mockReturnValue(['agent-a'])
    const gatewayRpc = vi.fn(async () => ({
      ok: true,
      payload: { sessions: [{ key: 'agent:agent-b:s1', agentId: 'agent-b' }] },
    }))

    const result = await syncUserSessionsFromGateway({
      userId: 'user-1',
      role: 'user',
      gatewayRpc,
    })

    expect(result.changed).toBe(0)
    expect(userManager.upsertSyncedUserSession).not.toHaveBeenCalled()
  })

  it('does not reinsert recently deleted sessions', async () => {
    userManager.getUserOwnedAgentIds.mockReturnValue(['agent-a'])
    const recentlyDeletedSessionKeys = new Set(['agent:agent-a:deleted'])
    const gatewayRpc = vi.fn(async () => ({
      ok: true,
      payload: { sessions: [{ key: 'agent:agent-a:deleted', agentId: 'agent-a' }] },
    }))

    const result = await syncUserSessionsFromGateway({
      userId: 'user-1',
      role: 'user',
      gatewayRpc,
      recentlyDeletedSessionKeys,
    })

    expect(result.changed).toBe(0)
    expect(userManager.upsertSyncedUserSession).not.toHaveBeenCalled()
  })

  it('coalesces scheduled syncs for the same user', async () => {
    userManager.getUserOwnedAgentIds.mockReturnValue(['agent-a'])
    userManager.upsertSyncedUserSession.mockReturnValue({ changed: true, action: 'inserted' })
    let calls = 0
    const gatewayRpc = vi.fn(async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { ok: true, payload: { sessions: [{ key: 'agent:agent-a:s1', agentId: 'agent-a' }] } }
    })

    await Promise.all([
      scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 0 }),
      scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, cooldownMs: 0 }),
    ])

    expect(calls).toBe(1)
  })

  it('does not call Gateway history or detail methods during metadata sync', async () => {
    userManager.getUserOwnedAgentIds.mockReturnValue(['agent-a'])
    userManager.upsertSyncedUserSession.mockReturnValue({ changed: true, action: 'inserted' })
    const gatewayRpc = vi.fn(async () => ({
      ok: true,
      payload: { sessions: [{ key: 'agent:agent-a:s1', agentId: 'agent-a' }] },
    }))

    await syncUserSessionsFromGateway({
      userId: 'user-1',
      role: 'user',
      gatewayRpc,
    })

    const methods = gatewayRpc.mock.calls.map(([method]) => method)
    expect(methods).toEqual(['sessions.list'])
    expect(methods).not.toContain('sessions.history')
    expect(methods).not.toContain('chat.history')
    expect(methods).not.toContain('sessions.get')
  })

  it('does not emit refresh events in V1', async () => {
    userManager.getUserOwnedAgentIds.mockReturnValue(['agent-a'])
    userManager.upsertSyncedUserSession.mockReturnValue({ changed: true, action: 'inserted' })
    const onChanged = vi.fn()
    const gatewayRpc = vi.fn(async () => ({
      ok: true,
      payload: { sessions: [{ key: 'agent:agent-a:s1', agentId: 'agent-a' }] },
    }))

    await scheduleUserSessionSync({ userId: 'user-1', role: 'user', gatewayRpc, onChanged, cooldownMs: 0 })

    expect(onChanged).not.toHaveBeenCalled()
  })
})
