// Failure-isolation contract fixture for server/core/config-queue.js.
//
// Contract under test: when the FIRST queued configuration job fails, the
// NEXT queued job must still run and settle deterministically, and the queue
// must not remain stuck (a later job still settles too).
//
// The fixture is self-contained and executable with the repository's Node
// runtime alone (no node_modules needed): a synchronous module resolve hook
// replaces the real ./gateway-client.js dependency of config-queue.js with an
// in-memory scripted gateway so the real ConfigQueue code under test runs
// unmodified.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// --- Scripted gateway stub, injected in place of ./gateway-client.js --------
// config-queue.js imports { gatewayAdminRpc } from './gateway-client.js'.
// We resolve that specifier to a data: URL module that forwards to a
// test-controlled global. Same data URL => same module instance.
const STUB_SOURCE = `
export function gatewayAdminRpc (method, params) {
  const fn = globalThis.__CONFIG_QUEUE_GW_RPC__
  if (typeof fn !== 'function') throw new Error('gateway stub not configured')
  return fn(method, params)
}
export const HTTP_RPC_METHODS = new Set()
`
const STUB_URL = 'data:text/javascript,' + encodeURIComponent(STUB_SOURCE)

registerHooks({
  resolve (specifier, context, nextResolve) {
    if (specifier.endsWith('gateway-client.js')) {
      return { url: STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

// --- Scripted gateway behavior ---------------------------------------------
// Call sequence per job:
//   config.get -> transformFn -> config.patch -> config.get -> config.apply
// The first `config.patch` call of a scenario fails (non-retryable message,
// so _execute does not wait out its retry backoff); later patches succeed.
function makeScriptedGateway ({ failingPatchError }) {
  let patchCount = 0
  const calls = []
  globalThis.__CONFIG_QUEUE_GW_RPC__ = async (method, params) => {
    calls.push(method)
    if (method === 'config.get') {
      return { ok: true, payload: { sourceConfig: {}, hash: 'h0' } }
    }
    if (method === 'config.patch') {
      patchCount += 1
      if (patchCount === 1) return { ok: false, error: failingPatchError }
      return { ok: true, payload: {} }
    }
    if (method === 'config.apply') return { ok: true, payload: {} }
    return { ok: false, error: `unexpected method ${method}` }
  }
  return { calls }
}

// A fresh ConfigQueue singleton per iteration: an ESM import with a unique
// query string is a distinct module instance, so rate-limit state from a
// previous iteration cannot leak into the next one.
async function freshQueue (runId) {
  const mod = await import(`../server/core/config-queue.js?fixture-run=${runId}`)
  return mod.configQueueExecute
}

test('first job failure does not block the next job from settling', async () => {
  const { calls } = makeScriptedGateway({ failingPatchError: 'fixture: first job failed' })
  const execute = await freshQueue('primary')

  // Enqueue synchronously in order: A first (fails), B second (succeeds).
  const jobA = execute((cfg) => ({ ...cfg, a: 1 }), 'job-A')
  const jobB = execute((cfg) => ({ ...cfg, b: 1 }), 'job-B')

  const [a, b] = await Promise.allSettled([jobA, jobB])

  // The failing job settles as a rejection carrying its error...
  assert.equal(a.status, 'rejected', 'first job must reject')
  assert.match(String(a.reason?.message ?? a.reason), /first job failed/)
  // ...and the next job still runs and settles as a fulfilled promise.
  assert.equal(b.status, 'fulfilled', 'second job must still settle')
  assert.equal(b.value, undefined)

  // Proof the queue did not wedge after the failure: a third job settles too.
  const jobC = execute((cfg) => ({ ...cfg, c: 1 }), 'job-C')
  const c = await jobC
  assert.equal(c, undefined, 'post-failure job must still settle')

  // Ordering was serial and the failed job never reached the apply step.
  assert.deepEqual(calls, [
    'config.get', 'config.patch', // job-A: fails at patch
    'config.get', 'config.patch', 'config.get', 'config.apply', // job-B
    'config.get', 'config.patch', 'config.get', 'config.apply', // job-C
  ])
})

test('repeated runs of the failing-first fixture settle identically', async () => {
  const outcomes = []
  for (let run = 0; run < 3; run++) {
    const { calls } = makeScriptedGateway({ failingPatchError: `fixture: run ${run} failed` })
    const execute = await freshQueue(`determinism-${run}`)

    const a = execute((cfg) => ({ ...cfg, a: run }), 'job-A')
    const b = execute((cfg) => ({ ...cfg, b: run }), 'job-B')
    const settled = await Promise.allSettled([a, b])

    outcomes.push({
      a: settled[0].status,
      b: settled[1].status,
      bValue: settled[1].value,
      calls,
    })
  }

  // Every run produced the same normalized outcome: fail-then-settle.
  assert.equal(outcomes.length, 3)
  assert.deepEqual(
    outcomes.map((o) => [o.a, o.b, o.bValue]),
    [['rejected', 'fulfilled', undefined], ['rejected', 'fulfilled', undefined], ['rejected', 'fulfilled', undefined]]
  )
  // The successful job always performed the full get->patch->get->apply cycle.
  for (const o of outcomes) {
    assert.deepEqual(o.calls.slice(2), ['config.get', 'config.patch', 'config.get', 'config.apply'])
  }
})
