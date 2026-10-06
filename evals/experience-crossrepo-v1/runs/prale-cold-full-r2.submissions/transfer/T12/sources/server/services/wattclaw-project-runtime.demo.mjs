#!/usr/bin/env node
/*
 * Executable demo for the WattClaw project runtime lifecycle.
 *
 * It creates a fresh local project fixture on disk, then drives the production
 * helpers in ./wattclaw-project-runtime.js through
 *   create -> activate -> (work) -> stop -> activate (restore) -> stop
 * while asserting that
 *   1. only transitions listed in LEGAL_TRANSITIONS are ever accepted,
 *   2. every rejected attempt leaves the project state and the event log unchanged,
 *   3. the emitted event stream matches the expected lifecycle stream exactly,
 * including the fact that only legal stops reach `wattclaw.team.project.archive`.
 *
 * Run: node server/services/wattclaw-project-runtime.demo.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveWattClawProjectDirectory } from './wattclaw-project-events.js'
import {
  activateWattClawProjectRuntime,
  ensureWattClawProjectRuntime,
  extractWattClawProject,
  nextWattClawRetentionRunAt,
  pruneWattClawProjectsForUser,
  trackWattClawProjectOwnership,
} from './wattclaw-project-runtime.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DAY_MS = 24 * 60 * 60 * 1000

// Mirrors the retention constants in wattclaw-project-runtime.js (lines 80-82).
const FINAL_PROJECT_RETENTION_MS = 3 * DAY_MS
const RESTORED_PROJECT_RETENTION_MS = DAY_MS
const RETENTION_OFFSET_MS = 8 * 60 * 60 * 1000
const TERMINAL_STATUSES = new Set(['success', 'failed', 'fail'])
// A stop (archive) is only legal for terminal projects or already archived
// (restored) projects - the same set pruneWattClawProjectsForUser archives.
const STOPPABLE_STATUSES = new Set([...TERMINAL_STATUSES, 'archived'])

/** States of a local project fixture: absent -> created -> active/terminal -> stopped. */
export const LEGAL_TRANSITIONS = Object.freeze([
  { action: 'create', from: 'absent', to: 'created' },
  { action: 'activate', from: 'created', to: 'active' },
  { action: 'complete', from: 'active', to: 'terminal' },
  { action: 'stop', from: 'terminal', to: 'stopped' },
  { action: 'activate', from: 'stopped', to: 'active' }, // restore of an archived project
  { action: 'stop', from: 'active', to: 'stopped' }, // restored project whose 24h window expired
])

export function isLegalTransition(action, from, to) {
  return LEGAL_TRANSITIONS.some(entry => entry.action === action && entry.from === from && entry.to === to)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Minimal local stand-in for the WattClaw gateway RPC surface the runtime helper
 * talks to. It owns the on-disk project fixture (config.json), a fake agent
 * registry and the emitted event log.
 */
function createLocalProjectGateway({ tenantId, fixtureRoot, clock }) {
  const projects = new Map()
  const revisions = new Map()
  const loadedAgents = new Map()
  const refusedRestores = new Set()
  const events = []
  const archiveTransitions = []
  const calls = []
  const adminCalls = []

  function projectDirOf(projectId) {
    return join(fixtureRoot, tenantId, '.wattclaw-team', 'projects', projectId)
  }

  function configPathOf(projectId) {
    return join(projectDirOf(projectId), 'config.json')
  }

  function emit(event, payload) {
    events.push({ seq: events.length + 1, event, at: new Date(clock.now).toISOString(), ...payload })
  }

  function bumpRevision(projectId) {
    const next = (revisions.get(projectId) || 0) + 1
    revisions.set(projectId, next)
    return next
  }

  async function persist(project) {
    await writeFile(configPathOf(project.id), `${JSON.stringify(project, null, 2)}\n`, 'utf-8')
  }

  function loadAgentsFor(project) {
    for (const member of project.members) {
      loadedAgents.set(member.agentId, {
        id: member.agentId,
        name: member.name,
        workspace: join(projectDirOf(project.id), 'agents', member.agentId),
      })
    }
  }

  async function createProject(params) {
    if (projects.has(params.id)) throw new Error(`project already exists: ${params.id}`)
    const timestamp = new Date(clock.now).toISOString()
    const project = {
      id: params.id,
      name: params.name,
      tenantId,
      status: 'creating',
      members: params.members.map(member => ({ ...member })),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    projects.set(project.id, project)
    await mkdir(projectDirOf(project.id), { recursive: true })
    await persist(project)
    emit('wattclaw.team.project.created', {
      projectId: project.id,
      tenantId,
      status: project.status,
      revision: bumpRevision(project.id),
    })
    return { ok: true, payload: { project: clone(project) } }
  }

  async function setStatus(projectId, status, lifecycleEvent = null) {
    const project = projects.get(projectId)
    if (!project) throw new Error(`project not found: ${projectId}`)
    const next = { ...project, status, updatedAt: new Date(clock.now).toISOString() }
    projects.set(projectId, next)
    await persist(next)
    const revision = bumpRevision(projectId)
    emit('wattclaw.team.project.updated', { projectId, tenantId, status, revision })
    if (lifecycleEvent) emit(lifecycleEvent, { projectId, tenantId, status, revision })
    return clone(next)
  }

  async function rpc(method, params = {}) {
    calls.push({ method, params: clone(params) })
    switch (method) {
      case 'wattclaw.team.project.create':
        return createProject(params)

      case 'wattclaw.team.project.get': {
        const project = projects.get(params.id)
        return project
          ? { ok: true, payload: { project: clone(project) } }
          : { ok: false, error: `project not found: ${params.id}` }
      }

      case 'wattclaw.team.project.list':
        return { ok: true, payload: { projects: [...projects.values()].map(clone) } }

      case 'agents.list':
        return { ok: true, payload: { agents: [...loadedAgents.values()].map(clone) } }

      case 'wattclaw.team.project.member.update': {
        const project = projects.get(params.projectId)
        if (!project) throw new Error(`project not found: ${params.projectId}`)
        // A soft failure (ok:false) is what the runtime must detect itself.
        if (refusedRestores.has(params.agentId)) return { ok: false, error: `member restore refused: ${params.agentId}` }
        const member = project.members.find(item => item.agentId === params.agentId)
        if (!member) throw new Error(`member not found: ${params.agentId}`)
        loadedAgents.set(member.agentId, {
          id: member.agentId,
          name: params.name || member.name,
          workspace: join(projectDirOf(project.id), 'agents', member.agentId),
        })
        emit('wattclaw.team.project.member.restored', {
          projectId: project.id,
          tenantId,
          agentId: member.agentId,
          revision: bumpRevision(project.id),
        })
        return { ok: true, payload: { project: clone(project) } }
      }

      case 'wattclaw.team.project.archive': {
        const project = projects.get(params.id)
        if (!project) throw new Error(`project not found: ${params.id}`)
        if (!STOPPABLE_STATUSES.has(project.status)) {
          return { ok: false, error: `illegal transition: project ${project.id} is ${project.status}` }
        }
        const next = { ...project, status: 'archived', updatedAt: new Date(clock.now).toISOString() }
        projects.set(project.id, next)
        await persist(next)
        archiveTransitions.push({ id: project.id })
        emit('wattclaw.team.project.archived', {
          projectId: project.id,
          tenantId,
          status: 'archived',
          revision: bumpRevision(project.id),
        })
        return { ok: true, payload: { project: clone(next) } }
      }

      default:
        throw new Error(`unexpected gateway method: ${method}`)
    }
  }

  async function adminRpc(method, params = {}) {
    adminCalls.push({ method, params: clone(params) })
    switch (method) {
      case 'agents.list':
        return { ok: true, payload: { agents: [...loadedAgents.values()].map(clone) } }

      case 'config.get':
        return { ok: true, payload: { raw: JSON.stringify({ agents: { list: [] } }), hash: 'demo-hash-1' } }

      case 'config.apply':
        // Applying config reloads the gateway, which re-creates every member
        // agent of every project fixture (this is the restore path used after a
        // gateway restart, before activateWattClawProjectRuntime runs).
        for (const project of projects.values()) loadAgentsFor(project)
        emit('wattclaw.team.project.runtime.reloaded', { projectId: [...projects.keys()][0], tenantId })
        return { ok: true, payload: {} }

      default:
        throw new Error(`unexpected gateway admin method: ${method}`)
    }
  }

  return {
    rpc,
    adminRpc,
    events,
    calls,
    adminCalls,
    emit,
    setStatus,
    projectDirOf,
    configPathOf,
    hasProject: projectId => projects.has(projectId),
    snapshot: projectId => clone(projects.get(projectId)),
    loadedAgentIds: () => [...loadedAgents.keys()],
    dropAllAgents: () => loadedAgents.clear(),
    refuseRestore: agentId => refusedRestores.add(agentId),
    allowRestore: agentId => refusedRestores.delete(agentId),
    memberUpdateCalls: () => calls.filter(call => call.method === 'wattclaw.team.project.member.update'),
    archiveCalls: () => calls.filter(call => call.method === 'wattclaw.team.project.archive'),
    archiveTransitions: () => clone(archiveTransitions),
  }
}

function createRecorder() {
  const assertions = []
  return {
    assertions,
    check(name, condition, detail = '') {
      if (!condition) throw new Error(`demo assertion failed: ${name}${detail ? ` - ${detail}` : ''}`)
      assertions.push(name)
    },
    equal(name, actual, expected) {
      assert.deepEqual(actual, expected, `demo assertion failed: ${name}`)
      assertions.push(name)
    },
    async rejects(name, fn, pattern) {
      await assert.rejects(fn, pattern, `demo assertion failed: ${name}`)
      assertions.push(name)
    },
  }
}

function summarizeCalls(calls) {
  const counts = new Map()
  for (const call of calls) counts.set(call.method, (counts.get(call.method) || 0) + 1)
  return [...counts.entries()].map(([method, count]) => ({ method, count }))
}

/**
 * Drives the whole demo and returns the normalized operation result.
 */
export async function runWattClawProjectLifecycleDemo({ fixtureRoot } = {}) {
  const { assertions, check, equal, rejects } = createRecorder()
  const root = fixtureRoot || join(REPO_ROOT, '.prale-eval', 'demo-fixture')
  const tenantId = 'tenant-demo'
  const projectId = 'p-demo'
  const managerId = `${projectId}-manager`
  const workerId = `${projectId}-worker`
  const userId = 'user-demo'
  const clock = { now: Date.parse('2026-08-20T10:00:00.000Z') }
  const startedAt = clock.now
  const transitions = []
  const rejections = []
  const tracked = { agents: [], sessions: [] }

  // --- fresh local fixture -------------------------------------------------
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const gateway = createLocalProjectGateway({ tenantId, fixtureRoot: root, clock })

  function recordTransition(action, from, to, via) {
    const legal = isLegalTransition(action, from, to)
    transitions.push({ seq: transitions.length + 1, action, from, to, legal, via })
    check(`legal transition ${action}: ${from} -> ${to}`, legal, `via ${via}`)
  }

  function recordRejection({ action, from, to, reason, observed, eventsBefore }) {
    equal(`rejected ${action} ${from} -> ${to} emits no events`, eventsBefore, gateway.events.length)
    rejections.push({ seq: rejections.length + 1, action, from, to, legal: false, reason, observed })
  }

  // 1. create -----------------------------------------------------------------
  const created = extractWattClawProject(await gateway.rpc('wattclaw.team.project.create', {
    id: projectId,
    name: 'Fresh demo project',
    members: [
      { agentId: managerId, name: 'Demo Manager', role: 'Lead', isLead: true },
      { agentId: workerId, name: 'Demo Worker', role: 'Researcher', isLead: false },
    ],
  }))
  equal('create returns the normalized project', created?.id, projectId)
  equal('fresh project status', created.status, 'creating')
  const locatedDir = resolveWattClawProjectDirectory({
    envConfig: { OPENCLAW_CONTAINER_DATA_DIR: root },
    tenantId,
    projectId,
  })
  equal('fixture directory matches the runtime resolver', locatedDir, gateway.projectDirOf(projectId))
  const fixtureOnDisk = JSON.parse(await readFile(gateway.configPathOf(projectId), 'utf-8'))
  equal('fixture is persisted as config.json', fixtureOnDisk.status, 'creating')
  recordTransition('create', 'absent', 'created', 'wattclaw.team.project.create')

  // 2. illegal create (duplicate id) -----------------------------------------
  let eventsBefore = gateway.events.length
  await rejects(
    'duplicate create is refused',
    () => gateway.rpc('wattclaw.team.project.create', { id: projectId, name: 'Duplicate', members: [] }),
    /project already exists/,
  )
  recordRejection({
    action: 'create',
    from: 'created',
    to: 'created',
    reason: 'project id already exists',
    observed: 'gateway rpc threw "project already exists: p-demo"',
    eventsBefore,
  })

  // 3. illegal activate (nothing to activate) ---------------------------------
  eventsBefore = gateway.events.length
  await rejects(
    'activate without a project is refused',
    () => activateWattClawProjectRuntime({ project: null, gatewayRpc: gateway.rpc }),
    /WattClaw project and gateway RPC are required/,
  )
  recordRejection({
    action: 'activate',
    from: 'absent',
    to: 'active',
    reason: 'no project record to activate',
    observed: 'activateWattClawProjectRuntime threw "WattClaw project and gateway RPC are required"',
    eventsBefore,
  })

  eventsBefore = gateway.events.length
  await rejects(
    'activate without members is refused',
    () => ensureWattClawProjectRuntime({
      project: { id: 'p-demo-empty', name: 'Empty', status: 'creating', members: [] },
      gatewayAdminRpc: gateway.adminRpc,
      timeoutMs: 20,
      pollIntervalMs: 1,
    }),
    /WattClaw project has no agents/,
  )
  recordRejection({
    action: 'activate',
    from: 'created',
    to: 'active',
    reason: 'project has no member agents',
    observed: 'ensureWattClawProjectRuntime threw "WattClaw project has no agents"',
    eventsBefore,
  })

  // 4. activate (fresh) -------------------------------------------------------
  const activated = await activateWattClawProjectRuntime({
    project: gateway.snapshot(projectId),
    gatewayRpc: gateway.rpc,
  })
  equal('fresh activation is not a restore', activated.restored, false)
  equal('activation restores every member agent', activated.agents.map(agent => agent.id), [managerId, workerId])
  equal('member.update is only sent for missing agents', gateway.memberUpdateCalls().map(call => call.params), [
    { projectId, agentId: managerId, name: 'Demo Manager', role: 'Lead' },
    { projectId, agentId: workerId, name: 'Demo Worker', role: 'Researcher' },
  ])
  const ownership = trackWattClawProjectOwnership({
    project: activated.project,
    agents: activated.agents,
    userId,
    trackAgent: (...args) => {
      tracked.agents.push(args)
      gateway.emit('wattclaw.team.agent.tracked', { projectId, tenantId, agentId: args[1] })
    },
    trackSession: (...args) => {
      tracked.sessions.push(args)
      gateway.emit('wattclaw.team.session.tracked', { projectId, tenantId, sessionKey: args[1] })
    },
  })
  equal('ownership tracks one session per member', ownership.sessionKeys, [
    `agent:${managerId}:main`,
    `agent:${workerId}:main`,
  ])
  equal('ownership tracks agents and sessions', [tracked.agents.length, tracked.sessions.length], [2, 2])

  const adminCallsBefore = gateway.adminCalls.length
  const ensuredAgents = await ensureWattClawProjectRuntime({
    project: activated.project,
    gatewayAdminRpc: gateway.adminRpc,
    timeoutMs: 50,
    pollIntervalMs: 1,
  })
  equal('ensure returns the loaded agents', ensuredAgents.map(agent => agent.id), [managerId, workerId])
  equal(
    'ensure skips config.apply when agents are already loaded',
    gateway.adminCalls.slice(adminCallsBefore).map(call => call.method),
    ['agents.list'],
  )
  await gateway.setStatus(projectId, 'in_progress', 'wattclaw.team.project.activated')
  recordTransition('activate', 'created', 'active', 'activateWattClawProjectRuntime')

  const ownedAgentIds = [managerId, workerId]

  // 5. illegal stop while the project is still active -------------------------
  eventsBefore = gateway.events.length
  const activeStop = await pruneWattClawProjectsForUser({
    gatewayRpc: gateway.rpc,
    ownedAgentIds,
    now: clock.now,
  })
  equal('active project is kept by retention', activeStop.kept, [projectId])
  equal('active project is not archived', activeStop.archived, [])
  equal('prune issued no archive rpc for the active project', gateway.archiveCalls().length, 0)
  equal('no archive transition happened', gateway.archiveTransitions(), [])
  recordRejection({
    action: 'stop',
    from: 'active',
    to: 'stopped',
    reason: 'project is in_progress (not terminal, never restored)',
    observed: 'pruneWattClawProjectsForUser kept p-demo and issued no archive rpc',
    eventsBefore,
  })

  eventsBefore = gateway.events.length
  const bypassedStop = await gateway.rpc('wattclaw.team.project.archive', { id: projectId })
  equal('gateway guard rejects a bypassed stop', bypassedStop.ok, false)
  equal('gateway guard reports the illegal status', bypassedStop.error, 'illegal transition: project p-demo is in_progress')
  equal('project status is unchanged after the rejected stop', gateway.snapshot(projectId).status, 'in_progress')
  equal('the bypassed attempt is logged but not applied', [gateway.archiveCalls().length, gateway.archiveTransitions().length], [1, 0])
  recordRejection({
    action: 'stop',
    from: 'active',
    to: 'stopped',
    reason: 'archive rpc issued while status is in_progress',
    observed: 'gateway answered ok:false "illegal transition: project p-demo is in_progress" (rpc logged, transition not applied)',
    eventsBefore,
  })

  // 6. project reaches a terminal status --------------------------------------
  await gateway.setStatus(projectId, 'success', 'wattclaw.team.project.terminal')
  recordTransition('complete', 'active', 'terminal', 'wattclaw.team.project.status.update')
  const terminalAt = Date.parse(gateway.snapshot(projectId).updatedAt)
  const nextRetentionRunAt = nextWattClawRetentionRunAt(terminalAt)

  // 7. illegal stop inside the 3 day final retention window -------------------
  clock.now = terminalAt + FINAL_PROJECT_RETENTION_MS - 1
  const archiveAttemptsBeforeEarlyStop = gateway.archiveCalls().length
  eventsBefore = gateway.events.length
  const earlyStop = await pruneWattClawProjectsForUser({
    gatewayRpc: gateway.rpc,
    ownedAgentIds,
    now: clock.now,
    projectAccessStates: new Map(),
  })
  equal('1ms before the retention window closes the project is kept', earlyStop.kept, [projectId])
  equal('1ms before the retention window closes nothing is archived', earlyStop.archived, [])
  equal(
    '1ms before the window closes no new archive rpc is issued',
    gateway.archiveCalls().length,
    archiveAttemptsBeforeEarlyStop,
  )
  recordRejection({
    action: 'stop',
    from: 'terminal',
    to: 'stopped',
    reason: 'final retention window (3d) still open by 1ms',
    observed: 'pruneWattClawProjectsForUser kept p-demo and issued no archive rpc',
    eventsBefore,
  })

  // 8. legal stop #1 ----------------------------------------------------------
  const archiveAttemptsBefore = gateway.archiveCalls().length
  clock.now = terminalAt + FINAL_PROJECT_RETENTION_MS + 1
  const stop1 = await pruneWattClawProjectsForUser({
    gatewayRpc: gateway.rpc,
    ownedAgentIds,
    now: clock.now,
    projectAccessStates: new Map(),
  })
  equal('legal stop archives exactly the expired terminal project', stop1.archived, [projectId])
  equal('legal stop leaves no failures', stop1.failed, [])
  equal('legal stop scanned the owned project', stop1.scanned, 1)
  equal('legal stop applied exactly one archive transition', gateway.archiveTransitions(), [{ id: projectId }])
  equal(
    'legal stop is the only archive rpc added by prune',
    gateway.archiveCalls().slice(archiveAttemptsBefore).map(call => call.params),
    [{ id: projectId }],
  )
  equal('fixture status is archived after the stop', gateway.snapshot(projectId).status, 'archived')
  recordTransition('stop', 'terminal', 'stopped', 'pruneWattClawProjectsForUser -> wattclaw.team.project.archive')

  // 9. restore: gateway restart + activate a stopped project ------------------
  gateway.dropAllAgents()
  const restartAdminCallsBefore = gateway.adminCalls.length
  const restartedAgents = await ensureWattClawProjectRuntime({
    project: gateway.snapshot(projectId),
    gatewayAdminRpc: gateway.adminRpc,
    timeoutMs: 200,
    pollIntervalMs: 1,
  })
  equal('restart path applies config and reloads every agent', restartedAgents.map(agent => agent.id), [managerId, workerId])
  equal(
    'restart path used config.get + config.apply',
    gateway.adminCalls.slice(restartAdminCallsBefore).map(call => call.method),
    ['agents.list', 'config.get', 'config.apply', 'agents.list'],
  )
  const restoreAt = clock.now
  const restored = await activateWattClawProjectRuntime({
    project: gateway.snapshot(projectId),
    gatewayRpc: gateway.rpc,
  })
  equal('activating an archived project is reported as restored', restored.restored, true)
  equal('restore needs no member.update calls', gateway.memberUpdateCalls().length, 2)
  equal('archived status stays on disk after a restore', restored.project.status, 'archived')
  gateway.emit('wattclaw.team.project.restored', { projectId, tenantId, status: 'restored', restoredAt: restoreAt })
  const projectAccessStates = new Map([[projectId, { restoredAt: restoreAt, lastAccessedAt: restoreAt }]])
  recordTransition('activate', 'stopped', 'active', 'activateWattClawProjectRuntime(restored:true)')

  // 10. illegal stop inside the 24h restored window ---------------------------
  clock.now = restoreAt + RESTORED_PROJECT_RETENTION_MS - 1
  const archiveAttemptsBeforeRestop = gateway.archiveCalls().length
  eventsBefore = gateway.events.length
  const earlyRestop = await pruneWattClawProjectsForUser({
    gatewayRpc: gateway.rpc,
    ownedAgentIds,
    now: clock.now,
    projectAccessStates,
  })
  equal('restored project is kept while the 24h window is open', earlyRestop.kept, [projectId])
  equal('restored project is not archived while the window is open', earlyRestop.archived, [])
  equal('still only one legal archive transition happened', gateway.archiveTransitions().length, 1)
  equal('the kept restored project issued no archive rpc', gateway.archiveCalls().length, archiveAttemptsBeforeRestop)
  recordRejection({
    action: 'stop',
    from: 'active',
    to: 'stopped',
    reason: 'restored retention window (24h) still open by 1ms',
    observed: 'pruneWattClawProjectsForUser kept p-demo and issued no archive rpc',
    eventsBefore,
  })

  // 11. legal stop #2 ---------------------------------------------------------
  const archiveAttemptsBeforeStop2 = gateway.archiveCalls().length
  clock.now = restoreAt + RESTORED_PROJECT_RETENTION_MS + 1
  const stop2 = await pruneWattClawProjectsForUser({
    gatewayRpc: gateway.rpc,
    ownedAgentIds,
    now: clock.now,
    projectAccessStates,
  })
  equal('second legal stop archives the restored project', stop2.archived, [projectId])
  equal('second legal stop leaves no failures', stop2.failed, [])
  equal(
    'second legal stop added exactly one archive rpc',
    gateway.archiveCalls().slice(archiveAttemptsBeforeStop2).map(call => call.params),
    [{ id: projectId }],
  )
  equal('two archive transitions were applied in total', gateway.archiveTransitions().length, 2)
  recordTransition('stop', 'active', 'stopped', 'pruneWattClawProjectsForUser(restored expired)')

  const mainEventStream = gateway.events.map(entry => entry.event)

  // 12. degraded fixture: activation must fail loudly -------------------------
  const degradedId = 'p-demo-degraded'
  const degraded = extractWattClawProject(await gateway.rpc('wattclaw.team.project.create', {
    id: degradedId,
    name: 'Degraded demo project',
    members: [{ agentId: `${degradedId}-worker`, name: 'Unavailable Worker', role: 'Researcher', isLead: false }],
  }))
  gateway.refuseRestore(`${degradedId}-worker`)
  eventsBefore = gateway.events.length
  await rejects(
    'activate fails when a member agent cannot be restored',
    () => activateWattClawProjectRuntime({ project: degraded, gatewayRpc: gateway.rpc }),
    /WattClaw agents were not restored: p-demo-degraded-worker/,
  )
  equal('failed activation emits no lifecycle events', gateway.events.length, eventsBefore)
  equal('failed activation does not load the refused agent', gateway.loadedAgentIds().includes(`${degradedId}-worker`), false)
  equal('failed activation leaves the fixture untouched', gateway.snapshot(degradedId).status, 'creating')
  recordRejection({
    action: 'activate',
    from: 'created',
    to: 'active',
    reason: 'member agent could not be restored',
    observed: 'activateWattClawProjectRuntime threw "WattClaw agents were not restored: p-demo-degraded-worker"',
    eventsBefore,
  })
  gateway.allowRestore(`${degradedId}-worker`)

  // --- assertions over the whole run ----------------------------------------
  const expectedMainEvents = [
    'wattclaw.team.project.created',
    'wattclaw.team.project.member.restored',
    'wattclaw.team.project.member.restored',
    'wattclaw.team.agent.tracked',
    'wattclaw.team.session.tracked',
    'wattclaw.team.agent.tracked',
    'wattclaw.team.session.tracked',
    'wattclaw.team.project.updated',
    'wattclaw.team.project.activated',
    'wattclaw.team.project.updated',
    'wattclaw.team.project.terminal',
    'wattclaw.team.project.archived',
    'wattclaw.team.project.runtime.reloaded',
    'wattclaw.team.project.restored',
    'wattclaw.team.project.archived',
  ]
  equal('emitted lifecycle event stream', mainEventStream, expectedMainEvents)
  equal('degraded fixture only emitted its create event', gateway.events.slice(expectedMainEvents.length).map(entry => entry.event), [
    'wattclaw.team.project.created',
  ])
  equal('every observed transition is legal', transitions.filter(entry => entry.legal).length, transitions.length)
  equal('stop is only observed twice, both legal', transitions.filter(entry => entry.action === 'stop').length, 2)
  equal(
    'rejections cover create / activate / stop',
    [...new Set(rejections.map(entry => entry.action))].sort(),
    ['activate', 'create', 'stop'],
  )
  equal('retention scheduled for 18:00 Asia/Shanghai', new Date(nextRetentionRunAt).toISOString(), '2026-08-21T10:00:00.000Z')
  equal(
    'retention offset matches the runtime constant',
    new Date(nextRetentionRunAt + RETENTION_OFFSET_MS).toISOString(),
    '2026-08-21T18:00:00.000Z',
  )

  return {
    demo: 'wattclaw-project-runtime-lifecycle',
    projectId,
    degradedProjectId: degradedId,
    tenantId,
    clock: {
      startedAt: new Date(startedAt).toISOString(),
      finalAt: new Date(clock.now).toISOString(),
    },
    fixture: {
      root: relative(REPO_ROOT, root),
      projectDir: relative(REPO_ROOT, gateway.projectDirOf(projectId)),
      configFile: relative(REPO_ROOT, gateway.configPathOf(projectId)),
      resolver: 'wattclaw-project-events.resolveWattClawProjectDirectory',
    },
    contract: {
      legalTransitions: LEGAL_TRANSITIONS.map(entry => `${entry.action}: ${entry.from} -> ${entry.to}`),
      stopGuard: 'archive accepted only for success/failed/fail/archived projects',
      finalRetentionMs: FINAL_PROJECT_RETENTION_MS,
      restoredRetentionMs: RESTORED_PROJECT_RETENTION_MS,
    },
    transitions,
    rejections,
    events: gateway.events.map(entry => ({
      seq: entry.seq,
      event: entry.event,
      projectId: entry.projectId,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.revision ? { revision: entry.revision } : {}),
    })),
    gateway: {
      calls: summarizeCalls(gateway.calls),
      adminCalls: summarizeCalls(gateway.adminCalls),
    },
    retention: {
      nextRunAt: new Date(nextRetentionRunAt).toISOString(),
      terminalAt: new Date(terminalAt).toISOString(),
    },
    assertions,
    status: 'passed',
  }
}

const isDirectRun = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (isDirectRun) {
  const resultPath = join(REPO_ROOT, '.prale-eval', 'demo-run.json')
  const summary = await runWattClawProjectLifecycleDemo()
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\ndemo ${summary.status}: ${summary.transitions.length} legal transitions, ${summary.rejections.length} rejected attempts, ${summary.events.length} events`)
  console.log(`normalized result written to ${relative(REPO_ROOT, resultPath)}`)
}
