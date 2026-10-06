// Executable contract demo for server/core/config-queue.js
//
// Covers:
//   1. ordered updates   — enqueued config transforms execute FIFO, one at a
//                          time, and each later transform observes the previous
//                          transform's committed result.
//   2. one rejected action — a config mutation rejected by the Gateway (a
//                          non-retryable error) rejects ONLY its own enqueued
//                          promise, records no patch, and the queue keeps
//                          draining subsequent items in order.
//
// The demo is dependency-free: it uses Node's built-in synchronous module
// hooks (module.registerHooks) to redirect the queue's `./gateway-client.js`
// import to an in-memory stub, so the real ConfigQueue code path runs without
// a live Gateway or any installed npm package.

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// --- Stub for ./gateway-client.js -----------------------------------------
// The real module is replaced by a shim that delegates to the handler the demo
// installs on globalThis. This keeps the queue's own logic (import, FIFO,
// retry classification, resolve/reject) under test.
const STUB_SOURCE = `
export function gatewayAdminRpc (method, params = {}) {
  return globalThis.__gatewayHandler(method, params)
}
`

registerHooks({
  resolve (specifier, context, nextResolve) {
    if (specifier === './gateway-client.js' && context.parentURL?.endsWith('/server/core/config-queue.js')) {
      return { url: 'stub:gateway-client', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load (url, context, nextLoad) {
    if (url === 'stub:gateway-client') {
      return { format: 'module', source: STUB_SOURCE, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

// --- Fake Gateway ----------------------------------------------------------
const gatewayCalls = []
let store = { channels: { feishu: { accounts: {} } }, models: { providers: {} } }
let hashSeed = 0
let hash = 'hash-0'

const clone = (v) => JSON.parse(JSON.stringify(v))

globalThis.__gatewayHandler = async (method, params) => {
  gatewayCalls.push({ method, raw: params?.raw ?? null })

  if (method === 'config.get') {
    return { ok: true, payload: { sourceConfig: clone(store), hash } }
  }

  if (method === 'config.patch' || method === 'config.set') {
    const candidate = JSON.parse(params.raw)
    if (Object.prototype.hasOwnProperty.call(candidate, 'gamma')) {
      // Non-retryable rejection of the 'update-gamma' action: the message has
      // no 'rate limit' / 'config changed since last load' substring, so
      // _execute must NOT enter its retry loop.
      return { ok: false, error: 'mutation rejected by gateway policy' }
    }
    const next = candidate
    store = method === 'config.set' ? next : { ...store, ...next }
    hash = `hash-${++hashSeed}`
    return { ok: true, payload: {} }
  }

  if (method === 'config.apply') {
    return { ok: true, payload: {} }
  }

  return { ok: false, error: `unknown method ${method}` }
}

// --- Drive the queue -------------------------------------------------------
const { configQueueExecute } = await import('../server/core/config-queue.js')

const settleOrder = []
const track = (promise, name) =>
  promise.then(
    (value) => { settleOrder.push(`${name}:resolved`); return value },
    (error) => { settleOrder.push(`${name}:rejected`); throw error },
  )

// Two ordered, successful updates.
const first = track(
  configQueueExecute((cfg) => ({ ...cfg, alpha: 1 }), 'update-alpha'),
  'update-alpha',
)
const second = track(
  configQueueExecute((cfg) => ({ ...cfg, beta: 2 }), 'update-beta'),
  'update-beta',
)

// One rejected configuration action, enqueued between the successful updates so
// the demo also proves the queue keeps its order and drains after a rejection.
const rejected = track(
  configQueueExecute((cfg) => ({ ...cfg, gamma: 3 }), 'update-gamma'),
  'update-gamma',
)

// A final successful update after the rejection.
const third = track(
  configQueueExecute((cfg) => ({ ...cfg, delta: 4 }), 'update-delta'),
  'update-delta',
)

await Promise.allSettled([first, second, rejected, third])

// --- Assertions ------------------------------------------------------------
// 1. Ordered updates: FIFO execution, each step is get -> patch -> get -> apply.
const mutationLane = gatewayCalls.map((c) => c.method)
assert.deepEqual(
  mutationLane,
  [
    'config.get', 'config.patch', 'config.get', 'config.apply', // update-alpha
    'config.get', 'config.patch', 'config.get', 'config.apply', // update-beta
    'config.get', 'config.patch',                            // update-gamma (rejected)
    'config.get', 'config.patch', 'config.get', 'config.apply', // update-delta
  ],
  'queue must serialize each update and keep FIFO order',
)

// Successful updates resolve; the rejected action rejects exactly once.
assert.equal(await first, undefined)
assert.equal(await second, undefined)
await assert.rejects(() => rejected, /mutation rejected by gateway policy/)
assert.equal(await third, undefined)

// Cumulative committed state proves updates were applied in order and the
// rejected action was never committed.
assert.deepEqual(store, {
  channels: { feishu: { accounts: {} } },
  models: { providers: {} },
  alpha: 1,
  beta: 2,
  delta: 4,
})
assert.equal('gamma' in store, false, 'rejected action must not mutate config')

// 2. The rejected action left the queue healthy: a later update still ran.
assert.equal(settleOrder.filter((s) => s === 'update-gamma:rejected').length, 1)
assert.deepEqual(
  settleOrder,
  ['update-alpha:resolved', 'update-beta:resolved', 'update-gamma:rejected', 'update-delta:resolved'],
)

console.log('CONTRACT OK')
console.log('  ordered updates :', ['update-alpha', 'update-beta', 'update-delta'].join(' -> '), 'committed in FIFO order')
console.log('  rejected action :', 'update-gamma rejected without committing or stalling the queue')
console.log('  gateway calls   :', gatewayCalls.length, '(', mutationLane.length, 'mutation-lane frames )')
