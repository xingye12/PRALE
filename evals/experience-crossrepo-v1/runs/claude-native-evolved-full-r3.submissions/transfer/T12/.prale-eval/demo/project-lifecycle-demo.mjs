#!/usr/bin/env node
// Executable demo: a fresh local WattClaw project fixture driven through
// create -> activate -> stop, asserting only legal lifecycle transitions and
// the events emitted along the way.
//
// It has zero external dependencies and imports the real repository modules
// under server/services, so the behaviour it asserts is the shipped behaviour
// (not a re-implementation):
//   * server/services/wattclaw-project-runtime.js  (activation + retention)
//   * server/services/wattclaw-project-events.js   (realtime project events)
//
// Run: node .prale-eval/demo/project-lifecycle-demo.mjs
// Exit code 0 = every contract assertion held; non-zero = first failure.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  activateWattClawProjectRuntime,
  getWattClawProjectAgentIds,
  pruneWattClawProjectsForUser,
} from '../../server/services/wattclaw-project-runtime.js'
import {
  createWattClawProjectEventService,
  resolveWattClawProjectDirectory,
} from '../../server/services/wattclaw-project-events.js'

// ── Asserted lifecycle contract ────────────────────────────────────────────
// The runtime persists a project status in config.json and the retention pass
// archives only terminal/restored projects, so the transitions that may be
// observed (and that pruning may perform) are exactly these.
const LEGAL_TRANSITIONS = {
  '(created)': ['pending'],
  pending: ['in_progress', 'archived'],
  in_progress: ['success', 'failed', 'archived'],
  success: ['archived'],
  failed: ['archived'],
  archived: ['restored', 'archived'],
  restored: ['in_progress', 'archived'],
}
const TERMINAL_STATUSES = new Set(['success', 'failed', 'fail'])

function assertLegalTransition(from, to, context = '') {
  const allowed = LEGAL_TRANSITIONS[from] || []
  assert.ok(
    allowed.includes(to),
    `illegal transition ${from} -> ${to}${context ? ` (${context})` : ''}`,
  )
  return { from, to }
}

// ── Small helpers ──────────────────────────────────────────────────────────
const project = {
  id: 'p-demo',
  name: 'Demo project',
  members: [
    { agentId: 'p-demo-manager', name: 'Manager', role: 'Lead', isLead: true },
    { agentId: 'p-demo-worker', name: 'Worker', role: 'Researcher', isLead: false },
  ],
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${description}`)
}

const observedTransitions = []
function recordTransition(from, to, context) {
  observedTransitions.push(assertLegalTransition(from, to, context))
}

// ── Demo ───────────────────────────────────────────────────────────────────
const results = []
const root = await mkdtemp(join(tmpdir(), 'wattclaw-project-demo-'))
let service = null

try {
  // ----- Phase 1: create a fresh local project fixture ----------------------
  const projectDir = join(root, 'tenant-demo', '.wattclaw-team', 'projects', project.id)
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'task-list.json'), '[]')

  const writeProject = (status, extra = {}) => writeFile(
    join(projectDir, 'config.json'),
    JSON.stringify({ ...project, status, ...extra }),
  )
  await writeProject('pending')

  // The real resolver must locate the fixture we just created on disk.
  const resolved = resolveWattClawProjectDirectory({
    envConfig: { OPENCLAW_CONTAINER_DATA_DIR: root, OPENCLAW_HOST_DATA_DIR: '' },
    tenantId: 'tenant-demo',
    projectId: project.id,
  })
  assert.equal(resolved, projectDir, 'resolver must locate the fresh fixture')
  recordTransition('(created)', 'pending', 'create')

  const events = []
  service = createWattClawProjectEventService({
    publish: entry => events.push(entry),
    debounceMs: 10,
    logger: { error: () => {} },
  })
  service.subscribe({
    clientId: 'demo-client',
    projectId: project.id,
    tenantId: 'tenant-demo',
    projectDir,
  })

  await waitFor(() => events.length >= 2, 'initial create events')
  const createdEvent = events.find(entry => entry.event === 'wattclaw.team.project.updated')
  const tasksEvent = events.find(entry => entry.event === 'wattclaw.team.tasks.updated')
  assert.ok(createdEvent, 'create must emit wattclaw.team.project.updated')
  assert.deepEqual(createdEvent.clientIds, ['demo-client'])
  assert.equal(createdEvent.payload.project.status, 'pending')
  assert.equal(createdEvent.payload.projectId, project.id)
  assert.ok(tasksEvent, 'create must emit wattclaw.team.tasks.updated')
  assert.deepEqual(tasksEvent.payload.tasks, [])
  results.push('create: fixture resolved on disk + project.updated(pending)/tasks.updated([]) emitted')

  // ----- Phase 2: activate (restore missing agents, go in_progress) --------
  const gatewayCalls = []
  let workerLoaded = false
  const gatewayRpc = async (method, params) => {
    gatewayCalls.push({ method, params })
    if (method === 'agents.list') {
      return {
        agents: [
          { id: 'p-demo-manager' },
          ...(workerLoaded ? [{ id: 'p-demo-worker' }] : []),
        ],
      }
    }
    if (method === 'wattclaw.team.project.member.update') {
      workerLoaded = true
      return { ok: true }
    }
    throw new Error(`unexpected gateway method: ${method}`)
  }

  const activated = await activateWattClawProjectRuntime({
    project: { ...project, status: 'pending' },
    gatewayRpc,
  })

  // Only the genuinely missing agent is restored — never the whole team.
  const memberUpdates = gatewayCalls.filter(
    call => call.method === 'wattclaw.team.project.member.update',
  )
  assert.equal(memberUpdates.length, 1, 'only the missing member is restored')
  assert.equal(memberUpdates[0].params.agentId, 'p-demo-worker')
  assert.equal(memberUpdates[0].params.projectId, project.id)
  assert.equal(activated.restored, false, 'a pending project is not a restore')
  assert.deepEqual(
    getWattClawProjectAgentIds(activated.project).sort(),
    ['p-demo-manager', 'p-demo-worker'],
  )

  await writeProject('in_progress')
  await waitFor(
    () => events.some(entry =>
      entry.event === 'wattclaw.team.project.updated'
      && entry.payload.project?.status === 'in_progress'),
    'in_progress event',
  )
  recordTransition('pending', 'in_progress', 'activate')
  results.push('activate: 1 missing agent restored; project.updated(in_progress) emitted')

  // ----- Phase 3: stop (unsubscribe, then retention stops the project) -----
  service.unsubscribe('demo-client')
  assert.equal(service.getActiveProjectCount(), 0, 'stop releases the watcher')
  const frozenCount = events.length
  await writeProject('success')
  await sleep(150)
  assert.equal(events.length, frozenCount, 'no events are emitted after stop')
  recordTransition('in_progress', 'success', 'stop/complete')

  // The retention pass is the stop/archival path. It must archive only the
  // expired terminal project and refuse the illegal in_progress -> archived
  // transition for a still-running project.
  const now = Date.now()
  const oldUpdatedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString()
  const projects = [
    { ...project, status: 'success', updatedAt: oldUpdatedAt },
    {
      id: 'p-running',
      name: 'Running project',
      status: 'in_progress',
      updatedAt: oldUpdatedAt,
      members: [{ agentId: 'p-running-manager', isLead: true }],
    },
  ]
  const pruneRpc = async (method, params) => {
    if (method === 'wattclaw.team.project.list') return { projects }
    if (method === 'agents.list') {
      return { agents: projects.flatMap(item => item.members.map(m => ({ id: m.agentId }))) }
    }
    if (method === 'wattclaw.team.project.archive') return { id: params.id, status: 'archived' }
    throw new Error(`unexpected gateway method: ${method}`)
  }

  const retention = await pruneWattClawProjectsForUser({ gatewayRpc: pruneRpc, now })
  assert.deepEqual(retention.archived, [project.id], 'only the terminal project is archived')
  assert.deepEqual(retention.kept, ['p-running'], 'running project is never archived')
  recordTransition('success', 'archived', 'stop/retention')

  // Refusal proofs: the illegal transitions are rejected, not silently taken.
  assert.throws(() => assertLegalTransition('success', 'in_progress'), /illegal transition/)
  assert.throws(() => assertLegalTransition('pending', 'restored'), /illegal transition/)
  assert.throws(() => assertLegalTransition('failed', 'in_progress'), /illegal transition/)
  assert.ok(TERMINAL_STATUSES.has('success') && TERMINAL_STATUSES.has('failed'))
  results.push('stop: watcher released, terminal project archived, running project kept')

  // Every observed transition is legal, and the observed sequence is complete.
  assert.deepEqual(
    observedTransitions.map(t => `${t.from}->${t.to}`),
    ['(created)->pending', 'pending->in_progress', 'in_progress->success', 'success->archived'],
  )

  console.log('WattClaw project lifecycle demo: PASS')
  for (const line of results) console.log(`  ✓ ${line}`)
  console.log('  ✓ observed transitions:', observedTransitions.map(t => `${t.from}->${t.to}`).join(', '))
} catch (error) {
  console.error('WattClaw project lifecycle demo: FAIL')
  console.error(error?.stack || error)
  process.exitCode = 1
} finally {
  service?.stop()
  await rm(root, { recursive: true, force: true })
}
