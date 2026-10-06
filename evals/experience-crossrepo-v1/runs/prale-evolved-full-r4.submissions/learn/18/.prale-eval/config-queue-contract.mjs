// Executable contract demo for server/core/config-queue.js
//
// Covers the two behaviours requested by TASK.md:
//   1. ordered updates      -> enqueued jobs are serialized FIFO, and every job
//                              observes the config written by the previous job.
//   2. one rejected action  -> a failing job rejects its own promise, leaves the
//                              gateway config untouched, and does not stall the
//                              queue for the jobs enqueued after it.
//
// The real server/core/gateway-client.js is replaced (resolve hook) with
// .prale-eval/stub-gateway-client.mjs, an in-memory fake of the admin RPC
// surface: config.get, config.patch, config.apply.

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stubUrl = new URL('./stub-gateway-client.mjs', import.meta.url).href
const targetUrl = new URL('../server/core/config-queue.js', import.meta.url).href

registerHooks({
  resolve (specifier, context, nextResolve) {
    if (specifier === './gateway-client.js' && String(context.parentURL || '').endsWith('/server/core/config-queue.js')) {
      return { url: stubUrl, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { configQueueExecute } = await import(targetUrl)

// ---------------------------------------------------------------- fake gateway
const gateway = {
  config: { channels: {}, mcp: { servers: {} } },
  hash: 'hash-0',
  rev: 0,
  calls: [],
  applied: [],
}

globalThis.__configQueueRpcHandler = async (method, params = {}) => {
  gateway.calls.push({ method })
  if (method === 'config.get') {
    return { ok: true, payload: { config: JSON.parse(JSON.stringify(gateway.config)), hash: gateway.hash } }
  }
  if (method === 'config.patch') {
    gateway.config = JSON.parse(params.raw)
    gateway.hash = `hash-${++gateway.rev}`
    return { ok: true, payload: { hash: gateway.hash } }
  }
  if (method === 'config.apply') {
    gateway.applied.push(JSON.parse(params.raw))
    return { ok: true, payload: {} }
  }
  return { ok: false, error: `unsupported method ${method}` }
}

const results = {}
let failures = 0

async function check (name, fn) {
  results[name] = { status: 'pending' }
  try {
    await fn()
    results[name].status = 'pass'
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    results[name].status = 'fail'
    results[name].error = err.message
    console.log(`FAIL ${name}: ${err.message}`)
  }
}

// ------------------------------------------------ 1. ordered updates (FIFO)
await check('ordered-updates', async () => {
  gateway.calls.length = 0
  const observed = []

  // Enqueued without awaiting, so the queue must serialize them itself.
  const pA = configQueueExecute((cfg) => {
    observed.push('A')
    return { ...cfg, channels: { ...cfg.channels, alpha: { enabled: true } } }
  }, 'add-alpha')

  const pB = configQueueExecute((cfg) => {
    observed.push('B')
    // B must see the config written by A.
    assert.deepEqual(cfg.channels.alpha, { enabled: true }, 'B must observe the update made by A')
    assert.deepEqual(cfg.channels.beta, undefined, 'B must not observe its own write yet')
    return { ...cfg, channels: { ...cfg.channels, beta: { enabled: true } } }
  }, 'add-beta')

  const [ra, rb] = await Promise.all([pA, pB])
  assert.equal(ra, undefined, 'config.patch jobs resolve with undefined')
  assert.equal(rb, undefined)

  // Strict FIFO execution: each job runs get -> patch -> get -> apply, and the
  // second job's get happens only after the first job's apply.
  assert.deepEqual(
    gateway.calls.map(c => c.method),
    ['config.get', 'config.patch', 'config.get', 'config.apply',
      'config.get', 'config.patch', 'config.get', 'config.apply'],
    `unexpected RPC sequence: ${gateway.calls.map(c => c.method).join(',')}`
  )
  assert.deepEqual(observed, ['A', 'B'], 'transform order must be FIFO')
  assert.equal(gateway.hash, 'hash-2', 'each applied update bumps the config revision')
  assert.deepEqual(gateway.config.channels, {
    alpha: { enabled: true },
    beta: { enabled: true },
  }, 'both ordered updates must be present in the final config')

  results['ordered-updates'].call_sequence = gateway.calls.map(c => c.method)
  results['ordered-updates'].final_hash = gateway.hash
})

// ------------------------------------------- 2. one rejected config action
await check('rejected-action', async () => {
  const revBefore = gateway.rev
  const hashBefore = gateway.hash
  const callsBefore = gateway.calls.length
  gateway.calls.length = 0

  // A non-retryable failure must reject immediately (no silent retry).
  const rejected = configQueueExecute((_cfg) => {
    throw new Error('invalid configuration: mcp.servers.broken is not an object')
  }, 'reject-broken-mcp')

  await assert.rejects(rejected, (err) => {
    assert.match(err.message, /invalid configuration/, 'rejection must surface the original error')
    return true
  })

  // The rejected job must have mutated nothing: it stopped before config.patch.
  assert.deepEqual(gateway.calls.map(c => c.method), ['config.get'], 'a rejected action must not patch or apply')
  assert.equal(gateway.rev, revBefore, 'rejected action must not bump the config revision')
  assert.equal(gateway.hash, hashBefore, 'rejected action must not change the config hash')

  // The queue keeps serving later jobs after the rejection (recovery).
  gateway.calls.length = 0
  const recovered = await configQueueExecute((cfg) => {
    assert.deepEqual(cfg.mcp, { servers: {} }, 'later job sees the un-mutated config')
    return { ...cfg, mcp: { servers: { good: { command: 'run' } } } }
  }, 'add-good-mcp')

  assert.equal(recovered, undefined)
  assert.deepEqual(gateway.calls.map(c => c.method),
    ['config.get', 'config.patch', 'config.get', 'config.apply'],
    'queue must resume normal operation after a rejection')
  assert.deepEqual(gateway.config.mcp, { servers: { good: { command: 'run' } } })

  results['rejected-action'].rejected_calls = callsBefore >= 0 ? ['config.get'] : []
  results['rejected-action'].recovery_sequence = gateway.calls.map(c => c.method)
  results['rejected-action'].recovered = true
})

const summary = {
  demo: 'server/core/config-queue.js contract',
  covered: ['ordered updates', 'one rejected configuration action'],
  total_patches: gateway.rev,
  checks: results,
  status: failures === 0 ? 'pass' : 'fail',
}
console.log('\n--- demo result ---')
console.log(JSON.stringify(summary, null, 2))
process.exit(failures === 0 ? 0 : 1)
