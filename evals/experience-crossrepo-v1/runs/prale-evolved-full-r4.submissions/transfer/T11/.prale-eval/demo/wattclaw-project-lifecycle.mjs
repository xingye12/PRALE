#!/usr/bin/env node
/**
 * WattClaw project lifecycle demo (T11 / repository: wattclaw / mode: demo).
 *
 * Drives a *fresh local project fixture* through create -> activate -> stop and
 * asserts that only legal transitions happen and that only the events the
 * repository actually emits are produced.
 *
 * Everything is exercised through the repository's own public module surface:
 *
 *   server/services/wattclaw-project-runtime.js
 *     activateWattClawProjectRuntime  -> member reconcile / agent restore
 *     pruneWattClawProjectsForUser    -> retention stop (archive) policy
 *     ensureWattClawProjectRuntime    -> agent load gate
 *     extractWattClawProject(s)       -> gateway payload normalization
 *     getWattClawProjectAgentIds      -> membership projection
 *     userOwnsWattClawProject         -> per-user ownership gate
 *     nextWattClawRetentionRunAt      -> retention schedule
 *
 *   server/services/wattclaw-project-events.js
 *     createWattClawProjectEventService -> file-backed project event stream
 *
 * No npm dependency is required (the repo's node_modules is absent and must not
 * be installed): the demo is plain Node ESM + node:assert.
 *
 * Run:  node .prale-eval/demo/wattclaw-project-lifecycle.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  activateWattClawProjectRuntime,
  ensureWattClawProjectRuntime,
  extractWattClawProject,
  extractWattClawProjects,
  getWattClawProjectAgentIds,
  nextWattClawRetentionRunAt,
  pruneWattClawProjectsForUser,
  userOwnsWattClawProject,
} from '../../server/services/wattclaw-project-runtime.js'
import { createWattClawProjectEventService } from '../../server/services/wattclaw-project-events.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(HERE, '.fixture')
const TENANT_ID = 'tenant-demo'
const PROJECT_ID = 'p-demo-lifecycle'

// ── lifecycle contract ───────────────────────────────────────────────────────

/**
 * Statuses are the ones the repository actually uses for WattClaw projects
 * (`pending` from the gateway create flow, `in_progress`/`success`/`failed`
 * from the project status tool, `archived` from retention/archive, `restored`
 * as the derived post-activation state). Only the edges below are legal.
 */
const LEGAL_PROJECT_TRANSITIONS = Object.freeze({
  created: ['pending'],
  pending: ['in_progress'],
  in_progress: ['success', 'failed'],
  success: ['archived'],
  failed: ['archived'],
  archived: ['restored'],
  restored: ['archived'],
})

/** Events the repository is allowed to emit for a project lifecycle. */
const LEGAL_EVENT_NAMES = Object.freeze([
  'wattclaw.team.project.updated',
  'wattclaw.team.project.deleted',
  'wattclaw.team.tasks.updated',
  'wattclaw.team.projects.changed',
])

const RETENTION_RUN_AT_UTC = Date.parse('2026-08-20T10:00:00.000Z') // 18:00 Asia/Shanghai
const NOW = Date.parse('2026-08-20T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function isoAt(offsetMs) {
  return new Date(NOW + offsetMs).toISOString()
}

function assertLegalTransition(from, to) {
  const allowed = LEGAL_PROJECT_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new Error(`Illegal WattClaw project transition rejected: ${from} -> ${to}`)
  }
  return { from, to }
}

// ── demo harness ─────────────────────────────────────────────────────────────

const report = {
  task_id: 'T11',
  repository: 'wattclaw',
  mode: 'demo',
  fixture: {
    root: '.prale-eval/demo/.fixture',
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    project_dir: `.prale-eval/demo/.fixture/${TENANT_ID}/.wattclaw-team/projects/${PROJECT_ID}`,
  },
  operations: [],
  illegal_attempts: [],
  emitted_events: [],
  rpc_calls: [],
  checks: [],
}

let checkCount = 0

function check(label, fn) {
  const value = fn()
  checkCount += 1
  report.checks.push({ check: label, status: 'ok' })
  return value
}

async function checkAsync(label, fn) {
  const value = await fn()
  checkCount += 1
  report.checks.push({ check: label, status: 'ok' })
  return value
}

async function expectRejects(label, pattern, fn) {
  let thrown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a rejection`)
  assert.match(String(thrown.message), pattern)
  checkCount += 1
  report.checks.push({ check: label, status: 'ok' })
  report.illegal_attempts.push({ attempt: label, rejected_with: thrown.message })
  return thrown
}

function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for emitted event'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

// ── fixture ──────────────────────────────────────────────────────────────────

const fixture = {
  projectDir: join(FIXTURE_ROOT, TENANT_ID, '.wattclaw-team', 'projects', PROJECT_ID),
  rpcLog: [],
  archived: [],
  loadedAgents: new Set(['main', 'p-demo-lead']),
  worlds: new Map(),
}

function writeProject(record) {
  return writeFile(join(fixture.projectDir, 'config.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
}

function memberAgentIds(record) {
  return getWattClawProjectAgentIds(record)
}

/** Gateway stub: mirrors the RPC contract the runtime module consumes. */
async function gatewayRpc(method, params = {}) {
  const shallow = params && typeof params === 'object' ? JSON.parse(JSON.stringify(params)) : params
  fixture.rpcLog.push({ method, params: shallow, at: report.rpc_calls.length })

  switch (method) {
    case 'wattclaw.team.project.create': {
      const record = fixture.worlds.get(PROJECT_ID)
      return { ok: true, payload: { project: record } }
    }
    case 'agents.list':
      return { ok: true, payload: { agents: [...fixture.loadedAgents].map(id => ({ id })) } }
    case 'wattclaw.team.project.member.update':
      fixture.loadedAgents.add(params.agentId)
      return { ok: true, payload: { id: params.projectId, agentId: params.agentId } }
    case 'wattclaw.team.project.list':
      return { ok: true, payload: { projects: [...fixture.worlds.values()] } }
    case 'wattclaw.team.project.archive': {
      const record = fixture.worlds.get(params.id)
      fixture.archived.push(params.id)
      // Archiving unloads the project's agents from the gateway.
      for (const agentId of memberAgentIds(record)) fixture.loadedAgents.delete(agentId)
      if (record) {
        record.status = 'archived'
        fixture.worlds.set(record.id, record)
      }
      return { ok: true, payload: { id: params.id, status: 'archived' } }
    }
    default:
      throw new Error(`unexpected gateway method: ${method}`)
  }
}

function rpcCalls(method) {
  return fixture.rpcLog.filter(entry => entry.method === method)
}

// ── emitted-event ledger (server/index.js wiring) ────────────────────────────

const publishEvents = []
const loggerErrors = []

const projectEvents = createWattClawProjectEventService({
  publish(entry) {
    publishEvents.push({ event: entry.event, payload: entry.payload })
    report.emitted_events.push({
      event: entry.event,
      project_id: entry.payload?.projectId ?? null,
      status: entry.payload?.project?.status ?? null,
      reason: entry.payload?.reason ?? null,
    })
  },
  logger: { error: (...args) => loggerErrors.push(args) },
  debounceMs: 5,
})

/**
 * Mirrors runScheduledWattClawRetention() in server/index.js: the retention
 * result is what produces the `wattclaw.team.projects.changed` broadcast.
 */
async function stopProjects({ now, label }) {
  const result = await pruneWattClawProjectsForUser({
    gatewayRpc,
    ownedAgentIds,
    now,
    projectAccessStates: accessStates,
  })
  for (const projectId of result.archived) {
    publishEvents.push({ event: 'wattclaw.team.projects.changed', payload: { reason: 'retention', projectId } })
    report.emitted_events.push({
      event: 'wattclaw.team.projects.changed',
      project_id: projectId,
      status: null,
      reason: 'retention',
    })
  }
  report.operations.push({
    op: 'stop',
    label,
    now: new Date(now).toISOString(),
    scanned: result.scanned,
    archived: result.archived,
    kept: result.kept,
    failed: result.failed,
  })
  return result
}

/** Demo-level guard: only terminal/archived projects may be stopped. */
function assertStoppable(record) {
  const status = String(record?.status || '').toLowerCase()
  if (!['success', 'failed', 'archived', 'restored'].includes(status)) {
    throw new Error(`Illegal WattClaw project transition rejected: ${status} -> archived`)
  }
}

// ── ownership set ────────────────────────────────────────────────────────────

const ownedAgentIds = new Set([
  'p-demo-lead',
  'p-demo-worker',
  'p-run-lead',
  'p-fresh-lead',
  'p-restored-lead',
  'p-cold-lead',
])
const accessStates = new Map()

async function main() {
  await rm(FIXTURE_ROOT, { recursive: true, force: true })
  await mkdir(fixture.projectDir, { recursive: true })

  // ── STEP 1: create ─────────────────────────────────────────────────────────
  const created = {
    id: PROJECT_ID,
    tenantId: TENANT_ID,
    name: 'Demo lifecycle project',
    status: 'pending',
    createdAt: isoAt(-60_000),
    updatedAt: isoAt(-60_000),
    members: [
      { agentId: 'p-demo-lead', name: 'Lead', role: 'Lead', isLead: true },
      { agentId: 'p-demo-worker', name: 'Worker', role: 'Researcher', isLead: false },
    ],
  }
  fixture.worlds.set(created.id, created)

  assertLegalTransition('created', 'pending')
  await writeProject(created)
  await writeFile(join(fixture.projectDir, 'task-list.json'), '[]\n', 'utf-8')
  await gatewayRpc('wattclaw.team.project.create', { name: created.name, tenantId: TENANT_ID })

  projectEvents.subscribe({
    clientId: 'client-demo',
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    projectDir: fixture.projectDir,
  })

  await waitFor(() => publishEvents.some(entry =>
    entry.event === 'wattclaw.team.project.updated' && entry.payload.project?.status === 'pending'))
  await waitFor(() => publishEvents.some(entry => entry.event === 'wattclaw.team.tasks.updated'))

  report.operations.push({
    op: 'create',
    project_id: PROJECT_ID,
    from: null,
    to: 'pending',
    legal: true,
    emitted: ['wattclaw.team.project.updated', 'wattclaw.team.tasks.updated'],
  })

  check('create persists a pending project record on disk', () => {
    assert.equal(created.status, 'pending')
    assert.equal(projectEvents.getActiveProjectCount(), 1)
    return true
  })
  check('create emits project.updated(pending) + tasks.updated only', () => {
    const names = publishEvents.map(entry => entry.event)
    assert.deepEqual(names, ['wattclaw.team.project.updated', 'wattclaw.team.tasks.updated'])
    const statuses = publishEvents
      .filter(entry => entry.event === 'wattclaw.team.project.updated')
      .map(entry => entry.payload.project.status)
    assert.deepEqual(statuses, ['pending'])
    return true
  })
  check('gateway payload normalization extracts the created project', () => {
    const payload = { ok: true, payload: { project: created } }
    assert.equal(extractWattClawProject(payload)?.id, PROJECT_ID)
    assert.equal(extractWattClawProjects({ projects: [created] }).length, 1)
    assert.equal(extractWattClawProjects({ items: [{ data: { id: 'p-x', members: [] } }] }).length, 1)
    return true
  })
  check('membership projection returns deduplicated member agent ids', () => {
    assert.deepEqual(memberAgentIds(created), ['p-demo-lead', 'p-demo-worker'])
    assert.deepEqual(getWattClawProjectAgentIds({ members: [{ agentId: ' p-a ' }, { agentId: 'p-a' }] }), ['p-a'])
    assert.deepEqual(getWattClawProjectAgentIds({}), [])
    return true
  })
  check('ownership gate admits the owner and rejects a foreign user', () => {
    assert.equal(userOwnsWattClawProject(created, ownedAgentIds), true)
    assert.equal(userOwnsWattClawProject(created, new Set(['p-other'])), false)
    return true
  })
  check('retention is scheduled for 18:00 Asia/Shanghai', () => {
    assert.equal(new Date(nextWattClawRetentionRunAt(RETENTION_RUN_AT_UTC - 60_000)).toISOString(), '2026-08-20T10:00:00.000Z')
    assert.equal(new Date(nextWattClawRetentionRunAt(RETENTION_RUN_AT_UTC)).toISOString(), '2026-08-21T10:00:00.000Z')
    return true
  })

  // ── STEP 2: activate ───────────────────────────────────────────────────────
  const inProgress = { ...created, status: 'in_progress', updatedAt: isoAt(-30_000) }
  fixture.worlds.set(inProgress.id, inProgress)
  assertLegalTransition('pending', 'in_progress')
  await writeProject(inProgress)

  const activated = await activateWattClawProjectRuntime({ project: inProgress, gatewayRpc })
  await waitFor(() => publishEvents.some(entry =>
    entry.event === 'wattclaw.team.project.updated' && entry.payload.project?.status === 'in_progress'))

  report.operations.push({
    op: 'activate',
    project_id: PROJECT_ID,
    from: 'pending',
    to: 'in_progress',
    legal: true,
    restored: activated.restored,
    restored_agents: rpcCalls('wattclaw.team.project.member.update').map(entry => entry.params.agentId),
    emitted: ['wattclaw.team.project.updated(in_progress)'],
  })

  await checkAsync('activate reconciles only the missing member and keeps the loaded one', async () => {
    const calls = rpcCalls('wattclaw.team.project.member.update')
    assert.deepEqual(calls.map(entry => entry.params.agentId), ['p-demo-worker'])
    assert.deepEqual(calls[0].params, {
      projectId: PROJECT_ID,
      agentId: 'p-demo-worker',
      name: 'Worker',
      role: 'Researcher',
    })
    assert.deepEqual(fixture.rpcLog.map(entry => entry.method), [
      'wattclaw.team.project.create',
      'agents.list',
      'wattclaw.team.project.member.update',
      'agents.list',
    ])
    return true
  })
  await checkAsync('activate returns the full agent roster and restored=false for a non-archived project', async () => {
    assert.deepEqual(activated.agents.map(agent => agent.id).sort(), ['main', 'p-demo-lead', 'p-demo-worker'])
    assert.equal(activated.restored, false)
    assert.equal(activated.project.status, 'in_progress')
    return true
  })
  await checkAsync('activate emits exactly one project.updated(in_progress)', async () => {
    const statuses = publishEvents
      .filter(entry => entry.event === 'wattclaw.team.project.updated')
      .map(entry => entry.payload.project.status)
    assert.deepEqual(statuses, ['pending', 'in_progress'])
    return true
  })

  // Archived -> restored is the only legal way out of `archived`.
  const archivedForRestore = {
    id: 'p-demo-restore',
    tenantId: TENANT_ID,
    name: 'Demo restore project',
    status: 'archived',
    updatedAt: isoAt(-4 * DAY_MS),
    members: [{ agentId: 'p-restored-lead', name: 'Restored lead', role: 'Lead', isLead: true }],
  }
  fixture.worlds.set(archivedForRestore.id, archivedForRestore)
  const restored = await activateWattClawProjectRuntime({ project: archivedForRestore, gatewayRpc })
  check('activate restores an archived project (archived -> restored)', () => {
    assertLegalTransition('archived', 'restored')
    assert.equal(restored.restored, true)
    assert.deepEqual(restored.agents.map(agent => agent.id).sort(), ['main', 'p-demo-lead', 'p-demo-worker', 'p-restored-lead'])
    return true
  })
  accessStates.set('p-demo-restore', { restoredAt: NOW - 2 * DAY_MS, lastAccessedAt: NOW })
  report.operations.push({
    op: 'activate',
    project_id: 'p-demo-restore',
    from: 'archived',
    to: 'restored',
    legal: true,
    restored: true,
    emitted: [],
  })

  // ── STEP 3: rejected (illegal) lifecycle attempts ──────────────────────────
  check('in_progress -> archived is not a legal transition', () => {
    assert.throws(() => assertLegalTransition('in_progress', 'archived'), /Illegal WattClaw project transition/)
    assert.throws(() => assertLegalTransition('pending', 'success'), /Illegal WattClaw project transition/)
    assert.throws(() => assertLegalTransition('archived', 'in_progress'), /Illegal WattClaw project transition/)
    return true
  })

  const eventCountBeforeIllegal = publishEvents.length
  const rpcCountBeforeIllegal = fixture.rpcLog.length

  await expectRejects(
    'activate rejects when gateway agents cannot be restored',
    /WattClaw agents were not restored: p-demo-lead, p-demo-worker/,
    () => activateWattClawProjectRuntime({
      project: inProgress,
      gatewayRpc: async () => ({ ok: true, payload: { agents: [{ id: 'main' }] } }),
    }),
  )
  await expectRejects(
    'activate rejects a missing project / gateway RPC',
    /WattClaw project and gateway RPC are required/,
    () => activateWattClawProjectRuntime({ project: null, gatewayRpc }),
  )
  await expectRejects(
    'ensure rejects a project with no agents',
    /WattClaw project has no agents/,
    () => ensureWattClawProjectRuntime({
      project: { ...inProgress, members: [] },
      gatewayAdminRpc: gatewayRpc,
      timeoutMs: 20,
      pollIntervalMs: 1,
    }),
  )
  await expectRejects(
    'ensure times out when gateway never loads the agents',
    /WattClaw agents were not loaded: p-demo-lead, p-demo-worker/,
    () => ensureWattClawProjectRuntime({
      project: inProgress,
      gatewayAdminRpc: async (method) => {
        if (method === 'config.get') return { ok: true, payload: { raw: '{"agents":{}}', hash: 'h1' } }
        if (method === 'config.apply') return { ok: true, payload: {} }
        return { ok: true, payload: { agents: [{ id: 'main' }] } }
      },
      timeoutMs: 30,
      pollIntervalMs: 1,
    }),
  )
  check('rejected attempts emit no project events and archive nothing', () => {
    assert.equal(publishEvents.length, eventCountBeforeIllegal)
    assert.equal(fixture.rpcLog.length, rpcCountBeforeIllegal)
    assert.deepEqual(fixture.archived, [])
    assert.equal(rpcCalls('wattclaw.team.project.archive').length, 0)
    return true
  })

  // ── STEP 4: stop ───────────────────────────────────────────────────────────
  // 4a. stopping a still-running project must be refused (policy + guard).
  const running = {
    id: 'p-demo-running',
    tenantId: TENANT_ID,
    name: 'Demo running project',
    status: 'in_progress',
    updatedAt: isoAt(-10 * DAY_MS),
    members: [{ agentId: 'p-run-lead', name: 'Run lead', role: 'Lead', isLead: true }],
  }
  const freshSuccess = {
    id: 'p-demo-success-fresh',
    tenantId: TENANT_ID,
    name: 'Demo fresh success',
    status: 'success',
    updatedAt: isoAt(-1 * DAY_MS),
    members: [{ agentId: 'p-fresh-lead', name: 'Fresh lead', role: 'Lead', isLead: true }],
  }
  const foreign = {
    id: 'p-demo-foreign',
    tenantId: 'tenant-other',
    name: 'Foreign project',
    status: 'success',
    updatedAt: isoAt(-10 * DAY_MS),
    members: [{ agentId: 'p-foreign-lead', name: 'Foreign lead', role: 'Lead', isLead: true }],
  }
  const archivedCold = {
    id: 'p-demo-archived-cold',
    tenantId: TENANT_ID,
    name: 'Demo archived cold',
    status: 'archived',
    updatedAt: isoAt(-10 * DAY_MS),
    members: [{ agentId: 'p-cold-lead', name: 'Cold lead', role: 'Lead', isLead: true }],
  }
  for (const record of [running, freshSuccess, foreign, archivedCold]) {
    fixture.worlds.set(record.id, record)
  }
  fixture.loadedAgents.add('p-demo-lead')
  fixture.loadedAgents.add('p-demo-worker')

  const stopAttempt = await stopProjects({ now: NOW, label: 'illegal-stop-attempt (still in_progress)' })
  check('an in_progress project is never archived by retention', () => {
    assert.equal(stopAttempt.archived.length, 0)
    assert.ok(stopAttempt.kept.includes(PROJECT_ID))
    assert.ok(stopAttempt.kept.includes('p-demo-running'))
    assert.ok(stopAttempt.kept.includes('p-demo-success-fresh'))
    assert.ok(stopAttempt.kept.includes('p-demo-archived-cold'))
    assert.equal(rpcCalls('wattclaw.team.project.archive').length, 0)
    return true
  })
  check('the stop guard refuses a running project while allowing terminal ones', () => {
    assert.throws(() => assertStoppable(inProgress), /Illegal WattClaw project transition/)
    assertStoppable(freshSuccess)
    assertStoppable({ status: 'success' })
    assertStoppable({ status: 'archived' })
    report.illegal_attempts.push({
      attempt: 'stop(in_progress)',
      rejected_with: 'Illegal WattClaw project transition rejected: in_progress -> archived',
    })
    return true
  })

  // 4b. the legal stop: terminal status -> retention unloads/archives it.
  const completed = { ...inProgress, status: 'success', updatedAt: isoAt(-4 * DAY_MS) }
  fixture.worlds.set(completed.id, completed)
  assertLegalTransition('in_progress', 'success')
  await writeProject(completed)
  await waitFor(() => publishEvents.some(entry =>
    entry.event === 'wattclaw.team.project.updated' && entry.payload.project?.status === 'success'))

  const stopResult = await stopProjects({ now: NOW, label: 'legal-stop (success + retention expired)' })
  check('stop archives the expired terminal project and the expired restored project', () => {
    assert.deepEqual(stopResult.archived.sort(), [PROJECT_ID, 'p-demo-restore'].sort())
    assert.equal(stopResult.scanned, fixture.worlds.size - 1) // ownership filter drops the foreign project
    assert.ok(stopResult.kept.includes('p-demo-running'))
    assert.ok(stopResult.kept.includes('p-demo-success-fresh'))
    assert.ok(stopResult.kept.includes('p-demo-archived-cold'))
    return true
  })
  check('stop never touches a project the user does not own', () => {
    assert.equal(stopResult.archived.includes('p-demo-foreign'), false)
    assert.equal(stopResult.kept.includes('p-demo-foreign'), false)
    assert.equal(rpcCalls('wattclaw.team.project.archive').some(call => call.params.id === 'p-demo-foreign'), false)
    return true
  })
  check('stop emits projects.changed(retention) once per archived project and unloads agents', () => {
    const changed = report.emitted_events.filter(entry =>
      entry.event === 'wattclaw.team.projects.changed' && entry.reason === 'retention')
    assert.deepEqual(changed.map(entry => entry.project_id).sort(), [PROJECT_ID, 'p-demo-restore'].sort())
    assert.equal(fixture.loadedAgents.has('p-demo-lead'), false)
    assert.equal(fixture.loadedAgents.has('p-demo-worker'), false)
    return true
  })
  report.operations.push({
    op: 'stop',
    project_id: PROJECT_ID,
    from: 'success',
    to: 'archived',
    legal: true,
    emitted: ['wattclaw.team.projects.changed(retention)'],
  })

  // 4c. stop is idempotent: a second retention pass must not archive again.
  const archiveCallsAfterFirstStop = rpcCalls('wattclaw.team.project.archive').length
  const changedEventsAfterFirstStop = report.emitted_events.length
  const secondStop = await stopProjects({ now: NOW, label: 'idempotent-stop (already archived)' })
  check('a second stop pass archives nothing again (idempotent)', () => {
    assert.deepEqual(secondStop.archived, [])
    assert.equal(rpcCalls('wattclaw.team.project.archive').length, archiveCallsAfterFirstStop)
    assert.equal(report.emitted_events.length, changedEventsAfterFirstStop)
    assert.ok(secondStop.kept.includes(PROJECT_ID))
    return true
  })

  // ── STEP 5: event stream shutdown ──────────────────────────────────────────
  projectEvents.stop()
  const publishedBeforeStop = publishEvents.length
  await writeFile(join(fixture.projectDir, 'config.json'), `${JSON.stringify({ ...completed, status: 'failed' })}\n`, 'utf-8')
  await new Promise(resolve => setTimeout(resolve, 120))

  check('stopping the event service closes the watcher and emits nothing more', () => {
    assert.equal(projectEvents.getActiveProjectCount(), 0)
    assert.equal(publishEvents.length, publishedBeforeStop)
    return true
  })

  // ── STEP 6: global event legality ──────────────────────────────────────────
  check('every emitted event name is in the legal allowlist', () => {
    for (const entry of publishEvents) {
      assert.ok(LEGAL_EVENT_NAMES.includes(entry.event), `unexpected event: ${entry.event}`)
      assert.equal(entry.payload.projectId, PROJECT_ID)
    }
    assert.equal(publishEvents.some(entry => entry.event === 'wattclaw.team.project.deleted'), false)
    return true
  })
  check('observed project status walk follows only legal transitions', () => {
    const statuses = publishEvents
      .filter(entry => entry.event === 'wattclaw.team.project.updated')
      .map(entry => entry.payload.project.status)
    assert.deepEqual(statuses, ['pending', 'in_progress', 'success'])
    for (let i = 1; i < statuses.length; i += 1) assertLegalTransition(statuses[i - 1], statuses[i])
    return true
  })
  check('no watcher/logger errors were produced during the demo', () => {
    assert.deepEqual(loggerErrors, [])
    return true
  })
}

let failure = null

try {
  await main()
} catch (error) {
  failure = error
}

try {
  projectEvents.stop()
  await rm(FIXTURE_ROOT, { recursive: true, force: true })
} catch {
  // best-effort cleanup only
}

report.conclusion = failure
  ? `FAILED: ${failure.message}`
  : `PASS: create -> activate -> stop drove the fixture through only legal transitions; ${checkCount} checks passed and ${report.illegal_attempts.length} illegal attempts were rejected without emitting events.`
report.checks_passed = checkCount
report.checks_failed = failure ? 1 : 0

console.log(JSON.stringify(report, null, 2))

if (failure) {
  console.error(`\nDEMO FAILED: ${failure.message}`)
  process.exitCode = 1
} else {
  console.log(`\nDEMO PASSED: ${checkCount} checks`)
}
