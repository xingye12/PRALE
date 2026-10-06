#!/usr/bin/env node
// Deterministic contract fixture for ConfigQueue: the first job fails and the
// next job must still settle deterministically.
//
// The real implementation under test is `server/core/config-queue.js`. Its only
// runtime dependency is `gatewayAdminRpc` from `server/core/gateway-client.js`
// (that module reaches into the SQLite/Gateway stack, which is not installed
// here). Node's synchronous module hooks (`module.registerHooks`) stub *only*
// that one specifier, so the ConfigQueue class body executed below is the
// repository's own source, unmodified.
//
// Run: node .prale-eval/fixtures/config-queue-first-failure.mjs
// Exit code 0 == contract holds.

import { registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKSPACE = path.resolve(import.meta.dirname, '..', '..')
const QUEUE_FILE = path.join(WORKSPACE, 'server', 'core', 'config-queue.js')
const GATEWAY_CLIENT_FILE = path.join(WORKSPACE, 'server', 'core', 'gateway-client.js')
const GATEWAY_CLIENT_URL = pathToFileURL(GATEWAY_CLIENT_FILE).href

// ---------------------------------------------------------------------------
// Scripted RPC surface
// ---------------------------------------------------------------------------

const stub = {
  calls: [],
  responder: null,
  handle (method, params) {
    this.calls.push({ method, params })
    return this.responder(method, params, this.calls.length)
  },
}
globalThis.__configQueueStub = stub

registerHooks({
  load (url, context, nextLoad) {
    if (url === GATEWAY_CLIENT_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'const stub = globalThis.__configQueueStub',
          'export function gatewayAdminRpc (method, params) { return stub.handle(method, params) }',
          '',
        ].join('\n'),
      }
    }
    return nextLoad(url, context)
  },
})

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures = []
let checks = 0

function check (label, condition, detail) {
  checks += 1
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

function summarise (settled) {
  return settled.status === 'rejected'
    ? `rejected(${settled.reason?.message ?? settled.reason})`
    : `fulfilled(${JSON.stringify(settled.value)})`
}

/** Counts settlements so a double-settle (resolve after reject) is detectable. */
function track (promise, slot) {
  promise.then(
    (value) => { slot.settlements += 1; slot.status = 'fulfilled'; slot.value = value },
    (error) => { slot.settlements += 1; slot.status = 'rejected'; slot.error = error },
  )
  return promise
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const baseConfig = { gateway: { port: 18789 }, agents: [{ id: 'a1' }] }

const scenarios = []

// Scenario 1: terminal failure on the first job (no retry, no timers).
scenarios.push({
  name: 'terminal-failure-then-success',
  async run ({ configQueueExecute }) {
    stub.calls.length = 0
    let gets = 0
    const transformed = []
    stub.responder = (method) => {
      if (method === 'config.get') {
        gets += 1
        if (gets === 1) return { ok: false, error: 'unknown key "alpha" in config' }
        return { ok: true, payload: { sourceConfig: { ...baseConfig }, hash: `hash-${gets}` } }
      }
      return { ok: true, payload: {} }
    }

    const slotA = { settlements: 0 }
    const slotB = { settlements: 0 }
    const a = track(
      configQueueExecute((cfg) => { transformed.push(['a', cfg]); return cfg }, 'first-job'),
      slotA,
    )
    const b = track(
      configQueueExecute((cfg) => { transformed.push(['b', cfg]); return { ...cfg, patched: true } }, 'second-job'),
      slotB,
    )

    const settled = await Promise.allSettled([a, b])
    await Promise.resolve()

    check('s1: first job rejected', settled[0].status === 'rejected', summarise(settled[0]))
    check('s1: rejection carries the gateway error',
      settled[0].reason?.message === 'unknown key "alpha" in config',
      summarise(settled[0]))
    check('s1: second job still settled', settled[1].status === 'fulfilled', summarise(settled[1]))
    check('s1: first job settled exactly once', slotA.settlements === 1, `got ${slotA.settlements}`)
    check('s1: second job settled exactly once', slotB.settlements === 1, `got ${slotB.settlements}`)
    check('s1: failed job never reached its transform', !transformed.some(([who]) => who === 'a'),
      JSON.stringify(transformed.map(([who]) => who)))
    check('s1: next job transform ran against the fetched source config',
      transformed.length === 1 && transformed[0][0] === 'b' && transformed[0][1].gateway.port === 18789,
      JSON.stringify(transformed.map(([who]) => who)))
    check('s1: second job drove the full apply sequence',
      stub.calls.map((c) => c.method).join(',') === 'config.get,config.get,config.patch,config.get,config.apply',
      stub.calls.map((c) => c.method).join(','))

    return { calls: stub.calls.map((c) => c.method) }
  },
})

// Scenario 2: retryable failure exhausts retries on the first job, and the
// next job must still settle. Retry back-off timers are compressed to 0ms so
// the scenario stays deterministic and fast; the requested delays are recorded.
scenarios.push({
  name: 'retries-exhausted-then-success',
  async run ({ configQueueExecute }) {
    stub.calls.length = 0
    const delays = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0) }

    try {
      let gets = 0
      stub.responder = (method) => {
        if (method === 'config.get') {
          gets += 1
          if (gets <= 3) return { ok: false, error: 'config changed since last load' }
          return { ok: true, payload: { sourceConfig: { ...baseConfig }, hash: `hash-${gets}` } }
        }
        return { ok: true, payload: {} }
      }

      const slotA = { settlements: 0 }
      const slotB = { settlements: 0 }
      const a = track(configQueueExecute((cfg) => cfg, 'first-job-retrying'), slotA)
      const b = track(configQueueExecute((cfg) => ({ ...cfg, patched: true }), 'second-job'), slotB)

      const settled = await Promise.allSettled([a, b])
      await Promise.resolve()
      const getsAfterFailover = stub.calls.filter((c) => c.method === 'config.get').length

      // A third job enqueued after the failing one proves the queue is not
      // wedged (the `_running` guard released, nothing left dangling).
      const slotC = { settlements: 0 }
      const c = track(configQueueExecute((cfg) => ({ ...cfg, patched: true }), 'third-job'), slotC)
      const settledC = await Promise.allSettled([c])
      check('s2: third job enqueued after the failure also settles',
        settledC[0].status === 'fulfilled', summarise(settledC[0]))

      check('s2: first job rejected after retries', settled[0].status === 'rejected', summarise(settled[0]))
      // 3 failed attempts for the first job, then the next job's own
      // read -> patch -> read -> apply cycle (2 of its 4 frames are config.get).
      check('s2: first job tried maxRetries(3) times before rejecting, then the next job completed its cycle',
        slotA.settlements === 1 && getsAfterFailover === 5,
        `settlements=${slotA.settlements} gets=${getsAfterFailover}`)
      check('s2: retry back-off was linear 2s/4s', delays.join(',') === '2000,4000', delays.join(','))
      check('s2: second job still settled', settled[1].status === 'fulfilled', summarise(settled[1]))
      check('s2: second job settled exactly once', slotB.settlements === 1, `got ${slotB.settlements}`)

      return { calls: stub.calls.map((c) => c.method), delays }
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  },
})

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main () {
  const { configQueueExecute } = await import(pathToFileURL(QUEUE_FILE).href)
  const ran = []

  for (const scenario of scenarios) {
    const started = Date.now()
    const detail = await scenario.run({ configQueueExecute })
    ran.push({ name: scenario.name, ms: Date.now() - started, ...detail })
  }

  return { ran }
}

const { ran } = await main()

console.log(JSON.stringify({
  contract: 'config-queue: first job fails, next job still settles deterministically',
  subject: 'server/core/config-queue.js',
  scenarios: ran,
  checks,
  failures,
  status: failures.length === 0 ? 'pass' : 'fail',
}, null, 2))

if (failures.length > 0) process.exit(1)
