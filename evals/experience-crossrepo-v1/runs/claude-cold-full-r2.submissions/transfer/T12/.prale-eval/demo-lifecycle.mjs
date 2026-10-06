#!/usr/bin/env node
/**
 * WattClaw project lifecycle demo — create -> activate -> stop.
 *
 * Drives a *fresh local project fixture* through the three lifecycle
 * operations and asserts:
 *   1. only legal transitions are accepted; illegal ones are rejected;
 *   2. activation restores missing project agents through the gateway RPC
 *      (activateWattClawProjectRuntime from wattclaw-project-runtime.js);
 *   3. the emitted realtime events match the wattclaw-project-events contract
 *      and stop exactly when the runtime is stopped.
 *
 * Runs on plain Node with built-in modules only — no package install needed.
 * Exit code 0 = every assertion held; non-zero = at least one failed.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  activateWattClawProjectRuntime,
  trackWattClawProjectOwnership,
  getWattClawProjectAgentIds,
} from '../server/services/wattclaw-project-runtime.js'
import { createWattClawProjectEventService } from '../server/services/wattclaw-project-events.js'

/* ------------------------------------------------------------------ *
 * Fresh local project fixture                                        *
 * ------------------------------------------------------------------ */

const PROJECT = {
  id: 'p-demo',
  name: 'Demo project',
  status: 'pending',
  members: [
    { agentId: 'p-demo-manager', name: 'Manager', role: 'Lead', isLead: true },
    { agentId: 'p-demo-worker', name: 'Worker', role: 'Researcher', isLead: false },
  ],
}

// A fresh in-memory gateway + a fresh project directory. Only the worker
// agent is missing on first `agents.list`, so activation must restore it.
function createFixtureGateway(project) {
  const calls = []
  let workerLoaded = false
  const gatewayRpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'agents.list') {
      return {
        agents: [
          { id: `${project.id}-manager` },
          ...(workerLoaded ? [{ id: `${project.id}-worker` }] : []),
        ],
      }
    }
    if (method === 'wattclaw.team.project.member.update') {
      workerLoaded = true
      return project
    }
    throw new Error(`unexpected gateway method: ${method}`)
  }
  return { gatewayRpc, calls }
}

async function createProjectDirectory(root, tenantId, project) {
  const projectDir = join(root, tenantId, '.wattclaw-team', 'projects', project.id)
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'config.json'), JSON.stringify(project))
  await writeFile(join(projectDir, 'task-list.json'), '[]')
  return projectDir
}

/* ------------------------------------------------------------------ *
 * Lifecycle state machine — the "legal transitions" contract         *
 * ------------------------------------------------------------------ */

const LEGAL_TRANSITIONS = {
  absent: ['create'],
  created: ['activate'],
  active: ['stop'],
  stopped: [],
}

class ProjectLifecycle {
  constructor(label) {
    this.label = label
    this.state = 'absent'
    this.history = []
  }

  can(operation) {
    return (LEGAL_TRANSITIONS[this.state] || []).includes(operation)
  }

  // Returns a normalized operation result instead of throwing, so the demo
  // can assert that illegal transitions are *rejected*.
  attempt(operation, run) {
    if (!this.can(operation)) {
      return {
        ok: false,
        operation,
        from: this.state,
        error: `illegal transition: ${operation} from ${this.state}`,
      }
    }
    const previous = this.state
    const next = { create: 'created', activate: 'active', stop: 'stopped' }[operation]
    const value = run()
    this.state = next
    this.history.push({ operation, from: previous, to: next })
    return { ok: true, operation, from: previous, to: next, value }
  }
}

/* ------------------------------------------------------------------ *
 * Assertion harness                                                   *
 * ------------------------------------------------------------------ */

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`  ok    ${name}`)
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return predicate()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * The demo                                                            *
 * ------------------------------------------------------------------ */

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'wattclaw-lifecycle-demo-'))
  const tenantId = 'tenant-demo'
  const events = []
  let service = null

  try {
    const projectDir = await createProjectDirectory(root, tenantId, PROJECT)
    const lifecycle = new ProjectLifecycle('p-demo')

    // ---------------------------------------------------------------- //
    // Illegal transitions are rejected before anything is driven.      //
    // ---------------------------------------------------------------- //
    console.log('\n[guard] illegal transitions are rejected')
    check('stop is illegal from absent', !lifecycle.can('stop'))
    check('activate is illegal from absent', !lifecycle.can('activate'))
    const rejected = lifecycle.attempt('stop', () => { throw new Error('must not run') })
    check('stop from absent is rejected', rejected.ok === false, rejected.error)
    check('state unchanged after rejection', lifecycle.state === 'absent')

    // ---------------------------------------------------------------- //
    // 1. CREATE — fresh fixture + owned members + subscribed client.    //
    // ---------------------------------------------------------------- //
    console.log('\n[create] fresh local project fixture')
    const createResult = lifecycle.attempt('create', () => {
      const tracked = trackWattClawProjectOwnership({
        project: PROJECT,
        agents: [{ id: 'p-demo-manager', workspace: '/manager' }, { id: 'p-demo-worker', workspace: '/worker' }],
        userId: 'user-demo',
        trackAgent: () => {},
        trackSession: () => {},
      })
      return { projectDir, agentIds: tracked.agentIds, sessionKeys: tracked.sessionKeys }
    })
    check('create accepted', createResult.ok === true)
    check('create -> created', lifecycle.state === 'created')
    check(
      'all project agents bound',
      JSON.stringify(createResult.value.agentIds) === JSON.stringify(getWattClawProjectAgentIds(PROJECT)),
      JSON.stringify(createResult.value.agentIds),
    )
    check(
      'one main session per member',
      createResult.value.sessionKeys.length === 2
        && createResult.value.sessionKeys.includes('agent:p-demo-manager:main')
        && createResult.value.sessionKeys.includes('agent:p-demo-worker:main'),
      JSON.stringify(createResult.value.sessionKeys),
    )

    service = createWattClawProjectEventService({
      publish: entry => events.push(entry),
      debounceMs: 10,
    })
    service.subscribe({ clientId: 'client-demo', projectId: PROJECT.id, tenantId, projectDir })
    await waitFor(() => events.some(e => e.event === 'wattclaw.team.project.updated'))
    await waitFor(() => events.some(e => e.event === 'wattclaw.team.tasks.updated'))

    check('one project watcher active after create', service.getActiveProjectCount() === 1)
    const createdProjectEvent = events.find(e => e.event === 'wattclaw.team.project.updated')
    check(
      'create emitted wattclaw.team.project.updated (pending)',
      createdProjectEvent?.payload?.project?.status === 'pending'
        && createdProjectEvent.payload.projectId === 'p-demo'
        && JSON.stringify(createdProjectEvent.clientIds) === '["client-demo"]',
      JSON.stringify(createdProjectEvent?.payload),
    )
    check(
      'create emitted wattclaw.team.tasks.updated ([])',
      events.some(e => e.event === 'wattclaw.team.tasks.updated' && Array.isArray(e.payload.tasks)),
    )

    // ---------------------------------------------------------------- //
    // 2. ACTIVATE — restore missing agents, then flip status.           //
    // ---------------------------------------------------------------- //
    console.log('\n[activate] restore missing agents + status -> in_progress')
    const { gatewayRpc, calls } = createFixtureGateway(PROJECT)
    const activateResult = lifecycle.attempt('activate', () => activateWattClawProjectRuntime({ project: PROJECT, gatewayRpc }))
    check('activate accepted', activateResult.ok === true)
    check('created -> active', lifecycle.state === 'active')

    const activation = await activateResult.value
    const memberUpdates = calls.filter(c => c.method === 'wattclaw.team.project.member.update')
    check(
      'only the missing worker was restored',
      memberUpdates.length === 1
        && memberUpdates[0].params.agentId === 'p-demo-worker'
        && memberUpdates[0].params.projectId === 'p-demo',
      JSON.stringify(memberUpdates.map(c => c.params.agentId)),
    )
    check(
      'activation returned the full agent set',
      JSON.stringify(activation.agents.map(a => a.id)) === '["p-demo-manager","p-demo-worker"]',
      JSON.stringify(activation.agents.map(a => a.id)),
    )
    check('fresh project is not a restore', activation.restored === false)

    const activeProject = { ...PROJECT, status: 'in_progress' }
    await writeFile(join(projectDir, 'config.json'), JSON.stringify(activeProject))
    await waitFor(() => events.some(e => e.event === 'wattclaw.team.project.updated' && e.payload.project?.status === 'in_progress'))
    check(
      'activate emitted project.updated -> in_progress',
      events.some(e => e.event === 'wattclaw.team.project.updated' && e.payload.project?.status === 'in_progress'),
    )
    check(
      'revisions increase monotonically',
      events.filter(e => e.event === 'wattclaw.team.project.updated')
        .every((e, i, arr) => i === 0 || e.payload.revision > arr[i - 1].payload.revision),
    )

    // ---------------------------------------------------------------- //
    // 3. STOP — close watchers; no further events.                     //
    // ---------------------------------------------------------------- //
    console.log('\n[stop] teardown + silence')
    const stopResult = lifecycle.attempt('stop', () => service.stop())
    check('stop accepted', stopResult.ok === true)
    check('active -> stopped', lifecycle.state === 'stopped')
    check('no project watchers remain', service.getActiveProjectCount() === 0)

    const countAtStop = events.length
    await writeFile(join(projectDir, 'config.json'), JSON.stringify({ ...PROJECT, status: 'success' }))
    await sleep(150)
    check('stop silenced further events', events.length === countAtStop, `count ${countAtStop} -> ${events.length}`)

    // ---------------------------------------------------------------- //
    // Illegal transitions after reachable legal states are rejected.    //
    // ---------------------------------------------------------------- //
    console.log('\n[guard] post-lifecycle transitions are rejected')
    check('stop is illegal from stopped', !lifecycle.can('stop'))
    check('activate is illegal from stopped', !lifecycle.can('activate'))
    check('create is illegal from stopped', !lifecycle.can('create'))
    const reActivate = lifecycle.attempt('activate', () => { throw new Error('must not run') })
    check('activate from stopped is rejected', reActivate.ok === false, reActivate.error)

    // ---------------------------------------------------------------- //
    // Normalized operation result.                                      //
    // ---------------------------------------------------------------- //
    const failed = checks.filter(c => !c.ok)
    const summary = {
      demo: 'wattclaw-project-lifecycle',
      flow: ['create', 'activate', 'stop'],
      finalState: lifecycle.state,
      legalHistory: lifecycle.history,
      emittedEvents: events.map(e => ({
        event: e.event,
        projectId: e.payload?.projectId,
        revision: e.payload?.revision,
        status: e.payload?.project?.status,
      })),
      gatewayCalls: calls.map(c => c.method),
      checks: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    }
    console.log('\n' + JSON.stringify(summary, null, 2))

    if (failed.length > 0) {
      console.error(`\nDEMO FAILED: ${failed.length}/${checks.length} checks failed`)
      process.exitCode = 1
    } else {
      console.log(`\nDEMO OK: ${checks.length}/${checks.length} checks passed, only legal transitions emitted events`)
    }
  } finally {
    try { service?.stop() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\nDEMO ERROR:', error?.message || error)
  process.exitCode = 1
})
