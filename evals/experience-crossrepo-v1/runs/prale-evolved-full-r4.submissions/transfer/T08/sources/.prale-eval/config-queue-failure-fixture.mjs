#!/usr/bin/env node
// Contract fixture: "the first queued config job fails, the next one must still
// settle deterministically."
//
// It exercises the REAL server/core/config-queue.js ConfigQueue class.  Only the
// single module specifier `./gateway-client.js` is rebound to an injected stub
// (via a data: URL module) so the fixture can run without the repository's
// node_modules; the queue's enqueue/_process/_execute/retry code paths are the
// unmodified source.
//
// The scripted gateway is a *configuration fixture*: an in-memory config
// document (sourceConfig + hash) that mutates only when a config.patch is
// accepted. Two fixtures are contracted:
//
//   S1 get-fails-first    job1's first config.get returns a non-retryable
//                         transport error, so job1 rejects and never reads,
//                         transforms or writes config; job2 then reads the
//                         untouched config and settles (patch -> get -> apply).
//   S2 patch-fails-first  job1 reads + transforms, but its config.patch is
//                         rejected (non-retryable), so job1 rejects without
//                         recording a patch or applying; job2 then patches and
//                         applies against the still-original hash.
//
// Each fixture is replayed REPEATS times; every run must produce an identical
// observable trace/outcome, which is what "settles deterministically" means here.
//
// Exit code 0 => every contracted check passed; 1 => at least one failed.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QUEUE_PATH = path.join(WORKSPACE, 'server/core/config-queue.js')
const REPEATS = 30

const IMPORT_SPECIFIER = "import { gatewayAdminRpc } from './gateway-client.js'"
const REBIND = 'const gatewayAdminRpc = (...args) => globalThis.__configQueueFixtureRpc(...args)'

async function loadConfigQueueClass () {
  const source = readFileSync(QUEUE_PATH, 'utf8')
  if (!source.includes(IMPORT_SPECIFIER)) {
    throw new Error(`cannot rebind gatewayAdminRpc: import not found in ${QUEUE_PATH}`)
  }
  const body = `${source.replace(IMPORT_SPECIFIER, REBIND)}\nexport { ConfigQueue }\n`
  const url = `data:text/javascript;base64,${Buffer.from(body, 'utf8').toString('base64')}`
  const mod = await import(url)
  return mod.ConfigQueue
}

function deepClone (value) {
  return JSON.parse(JSON.stringify(value))
}

// Scripted in-memory Gateway config document. `failGet`/`failPatch` make the
// first N calls of that method return a non-retryable error, which is exactly
// what makes "the first job fails" deterministic (no OCC/rate-limit backoff).
function createScriptedGateway ({ hash, config, failGet = 0, failPatch = 0 }) {
  const gw = {
    hash,
    config: deepClone(config),
    calls: [],
    getCalls: 0,
    patchCalls: 0,
    applyCalls: 0,
  }

  gw.rpc = async (method, params = {}) => {
    gw.calls.push({ method, params: deepClone(params), hash: gw.hash })
    if (method === 'config.get') {
      gw.getCalls += 1
      if (gw.getCalls <= failGet) return { ok: false, error: 'gateway transport offline (fixture)' }
      return { ok: true, payload: { sourceConfig: deepClone(gw.config), hash: gw.hash } }
    }
    if (method === 'config.patch') {
      gw.patchCalls += 1
      if (gw.patchCalls <= failPatch) return { ok: false, error: 'config.patch rejected: invalid logLevel (fixture)' }
      gw.config = JSON.parse(params.raw)
      gw.hash = `${hash}-r${gw.patchCalls}`
      return { ok: true, payload: {} }
    }
    if (method === 'config.apply') {
      gw.applyCalls += 1
      return { ok: true, payload: { applied: true, hash: gw.hash } }
    }
    return { ok: false, error: `unexpected method: ${method}` }
  }

  return gw
}

// The two contracted configuration fixtures.
const FIXTURES = [
  {
    id: 'get-fails-first',
    gateway: {
      hash: 'hash-s1-1',
      config: { agents: { main: { name: 'main' } }, gateway: { logLevel: 'info' }, bindings: [] },
      failGet: 1,
    },
    jobs: [
      { label: 'fail-at-get', transform: cfg => ({ ...cfg, gateway: { ...cfg.gateway, logLevel: 'warn' } }) },
      { label: 'settle-after', transform: cfg => ({ ...cfg, gateway: { ...cfg.gateway, logLevel: 'debug' } }) },
    ],
    expect: {
      firstError: 'gateway transport offline (fixture)',
      trace: ['config.get:fail', 'config.get:ok', 'config.patch:ok', 'config.get:ok', 'config.apply:ok'],
      patchCalls: 1,
      applyCalls: 1,
      finalLogLevel: 'debug',
      patchBaseHashes: ['hash-s1-1'],
    },
  },
  {
    id: 'patch-fails-first',
    gateway: {
      hash: 'hash-s2-1',
      config: { agents: { main: { name: 'main' } }, gateway: { logLevel: 'info' }, bindings: [] },
      failPatch: 1,
    },
    jobs: [
      { label: 'fail-at-patch', transform: cfg => ({ ...cfg, gateway: { ...cfg.gateway, logLevel: 'trace' } }) },
      { label: 'settle-after', transform: cfg => ({ ...cfg, gateway: { ...cfg.gateway, logLevel: 'debug' } }) },
    ],
    expect: {
      firstError: 'config.patch rejected: invalid logLevel (fixture)',
      trace: ['config.get:ok', 'config.patch:fail', 'config.get:ok', 'config.patch:ok', 'config.get:ok', 'config.apply:ok'],
      patchCalls: 2,
      applyCalls: 1,
      finalLogLevel: 'debug',
      // job1 read hash-s2-1; its rejected patch left the document untouched, so
      // job2 must still read+patch against the SAME base hash.
      patchBaseHashes: ['hash-s2-1', 'hash-s2-1'],
    },
  },
]

function traceOf (calls) {
  const seen = { 'config.get': 0, 'config.patch': 0, 'config.apply': 0 }
  return calls.map((call) => {
    switch (call.method) {
      case 'config.get':
        seen['config.get'] += 1
        // A call is "fail" when its recorded outcome is not ok; the scripted
        // gateway marks that by returning an error to _execute.
        return `config.get:${call.ok ? 'ok' : 'fail'}`
      case 'config.patch':
        seen['config.patch'] += 1
        return `config.patch:${call.ok ? 'ok' : 'fail'}`
      case 'config.apply':
        seen['config.apply'] += 1
        return `config.apply:${call.ok ? 'ok' : 'fail'}`
      default:
        return call.method
    }
  })
}

async function runFixture (ConfigQueue, fixture) {
  const gw = createScriptedGateway(fixture.gateway)

  // Record outcomes on the call log so traceOf() can label ok/fail.
  const rawRpc = gw.rpc
  gw.rpc = async (method, params) => {
    const result = await rawRpc(method, params)
    gw.calls[gw.calls.length - 1].ok = result.ok === true
    return result
  }

  globalThis.__configQueueFixtureRpc = gw.rpc
  const queue = new ConfigQueue()
  const hashBeforeFirstJob = gw.hash

  const first = queue.enqueue(fixture.jobs[0].transform, fixture.jobs[0].label)
  const second = queue.enqueue(fixture.jobs[1].transform, fixture.jobs[1].label)
  const [r1, r2] = await Promise.allSettled([first, second])

  const hashAfterBothSettled = gw.hash
  const patchBaseHashes = gw.calls
    .filter(call => call.method === 'config.patch')
    .map(call => call.params.baseHash)

  // Freeze outcome 2 without throwing when the queue resolved `undefined`.
  const secondOutcome = r2.status === 'fulfilled' ? `resolved:${String(r2.value)}` : `rejected:${r2.reason?.message}`

  return {
    id: fixture.id,
    firstStatus: r1.status,
    firstError: r1.status === 'rejected' ? r1.reason?.message : null,
    secondOutcome,
    queueDrained: queue.length === 0,
    hashBeforeFirstJob,
    hashAfterBothSettled,
    trace: traceOf(gw.calls),
    patchCalls: gw.patchCalls,
    applyCalls: gw.applyCalls,
    patchBaseHashes,
    finalLogLevel: gw.config.gateway.logLevel,
    finalConfig: gw.config,
  }
}

function checkFixture (fixture, run) {
  const e = fixture.expect
  const checks = [
    ['first job rejected', run.firstStatus === 'rejected', run.firstStatus],
    ['first job carries its own error', run.firstError === e.firstError, run.firstError],
    ['next job settled', run.secondOutcome === 'resolved:undefined', run.secondOutcome],
    ['queue drained after both jobs', run.queueDrained === true, run.queueDrained],
    ['patch/apply counts', run.patchCalls === e.patchCalls && run.applyCalls === e.applyCalls,
      `patch=${run.patchCalls} apply=${run.applyCalls}`],
    ['call trace', JSON.stringify(run.trace) === JSON.stringify(e.trace), run.trace.join(',')],
    ['base hashes', JSON.stringify(run.patchBaseHashes) === JSON.stringify(e.patchBaseHashes),
      run.patchBaseHashes.join(',')],
    ['final config', run.finalLogLevel === e.finalLogLevel, run.finalLogLevel],
  ]
  return checks
}

async function main () {
  const ConfigQueue = await loadConfigQueueClass()
  let failed = 0

  for (const fixture of FIXTURES) {
    const runs = []
    for (let i = 0; i < REPEATS; i++) runs.push(await runFixture(ConfigQueue, fixture))

    const signatures = new Set(runs.map(run => JSON.stringify(run)))
    const deterministic = signatures.size === 1
    const run = runs[0]
    const checks = checkFixture(fixture, run)
    const failures = checks.filter(([, ok]) => !ok)

    if (!deterministic) {
      failed += 1
      console.log(`[fixture] ${fixture.id}: FAIL (${signatures.size} distinct outcomes over ${REPEATS} runs)`)
    }
    for (const [name, ok, detail] of checks) {
      if (!ok) {
        failed += 1
        console.log(`[fixture] ${fixture.id}: FAIL ${name} -> ${detail}`)
      }
    }
    if (deterministic && failures.length === 0) {
      console.log(`[fixture] ${fixture.id}: PASS (${REPEATS}/${REPEATS} identical runs; first job rejected, next job settled)`)
    }
  }

  if (failed > 0) {
    console.log(`[fixture] CONTRACT FAILED (${failed} failing check(s))`)
    process.exitCode = 1
    return
  }
  console.log('[fixture] ALL CHECKS PASSED')
}

main().catch((err) => {
  console.error(`[fixture] harness error: ${err?.stack || err}`)
  process.exitCode = 1
})
