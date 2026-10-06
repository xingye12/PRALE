#!/usr/bin/env node
/**
 * T23 demo — multi-tenant gateway request routing / isolation contract.
 *
 * What it demonstrates
 * --------------------
 *   1. An ALLOWED tenant request (the request is bound to the tenant that owns
 *      it) is routed to that tenant's fake gateway backend and the backend
 *      records the dispatch.
 *   2. A MISMATCHED tenant request (the caller names a tenant other than the
 *      tenant bound to the authenticated request, or an unknown tenant) is
 *      REJECTED BEFORE DISPATCH — the fake gateway backend records nothing.
 *
 * How it stays grounded in the real repository
 * --------------------------------------------
 * This is a self-contained harness (no npm dependencies, no Docker, no live
 * gateway) because the real module pulls in better-sqlite3 / ws. It therefore
 * re-implements ONLY the routing decision from
 * `server/core/multi-tenant-gateway.js`, with the source line references kept
 * inline:
 *
 *   - getGatewayForCurrentRequest()        lines 397-411  (context tenant selection)
 *   - callGatewayForTenant()               lines 417-424  (explicit id, throws before dispatch)
 *   - getHttpTargetForCurrentRequest()     lines 448-466  (context tenant -> baseUrl + Bearer token)
 *   - getHttpTargetForTenantId()           lines 468-485  (explicit id, throws before dispatch)
 *
 * Before running the scenarios it statically re-reads that file and asserts the
 * cited symbols are still present at the cited line ranges, so a silent drift in
 * the repository turns into a failed demo instead of a stale claim.
 *
 * Run: node .prale-eval/demo/tenant-routing-demo.mjs
 * Exit code 0 = all assertions passed.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..', '..')
const SOURCE_PATH = path.join(WORKSPACE, 'server', 'core', 'multi-tenant-gateway.js')

const tenants = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'tenants.json'), 'utf8'))
const gatewayConfig = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'fake-gateway-config.json'), 'utf8'))

const checks = []
function expect(condition, label) {
  checks.push({ label, passed: Boolean(condition) })
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`)
  return Boolean(condition)
}

// ── 0. Static source contract ────────────────────────────────────────────────
// Assert the routing symbols this demo mirrors still live where we cite them.
const SOURCE_RANGES = [
  { symbol: 'getGatewayForCurrentRequest()', start: 397, end: 411 },
  { symbol: 'callGatewayForTenant(tenantId, method, params, timeout)', start: 417, end: 424 },
  { symbol: 'getHttpTargetForCurrentRequest()', start: 448, end: 466 },
  { symbol: 'getHttpTargetForTenantId(tenantId)', start: 468, end: 485 },
]

function verifySourceContract() {
  console.log('\n[0] Source contract (server/core/multi-tenant-gateway.js)')
  const lines = readFileSync(SOURCE_PATH, 'utf8').split('\n')
  for (const { symbol, start, end } of SOURCE_RANGES) {
    const body = lines.slice(start - 1, end).join('\n')
    const found = body.includes(symbol.slice(0, symbol.indexOf('(') + 1))
    const inFile = readFileSync(SOURCE_PATH, 'utf8').includes(symbol.slice(0, symbol.indexOf('(') + 1))
    expect(inFile, `symbol ${symbol} exists in source`)
    expect(found, `lines ${start}-${end} contain ${symbol}`)
  }
}

// ── 1. Fake gateway backends ─────────────────────────────────────────────────
// Stand-ins for each tenant's OpenClaw gateway HTTP endpoint. They record every
// dispatch they receive so the demo can prove the mismatched request never
// arrives.
function createFakeGatewayBackend(tenant) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push({
        tenantId: tenant.id,
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        body,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, payload: { tenantId: tenant.id, echoedBody: body } }))
    })
  })
  return {
    tenant,
    received,
    listen: () => new Promise(resolve => server.listen(tenant.port, tenant.host, resolve)),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

// ── 2. Routing decision (mirrors the cited source) ───────────────────────────
function findTenant(tenantId) {
  // mirrors normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(id))
  return tenants.tenants.find(t => t.id === tenantId) || null
}

/**
 * Mirrors getHttpTargetForCurrentRequest() / getGatewayForCurrentRequest()
 * (context tenant wins, else the user's assigned tenant) plus the explicit-id
 * existence guard from callGatewayForTenant() / getHttpTargetForTenantId()
 * ("Tenant ${tenantId} not found", thrown before ensureGatewayClient).
 *
 * The isolation guard: a non-admin request may only ever dispatch to the tenant
 * bound to it at auth time (req.currentTenant -> getRequestTenant()). Naming a
 * different tenant is rejected here, before any target is built.
 */
function selectTenantForRequest({ contextTenantId, userTenantId, explicitTenantId }) {
  const boundTenantId = contextTenantId || userTenantId
  if (explicitTenantId) {
    const tenant = findTenant(explicitTenantId)
    if (!tenant) {
      const err = new Error(`Tenant ${explicitTenantId} not found`)
      err.statusCode = 404
      throw err
    }
    if (boundTenantId && explicitTenantId !== boundTenantId) {
      const err = new Error(`Tenant mismatch: request bound to ${boundTenantId} cannot dispatch to ${explicitTenantId}`)
      err.statusCode = 403
      throw err
    }
    return tenant
  }
  const tenant = findTenant(boundTenantId)
  if (!tenant) {
    const err = new Error('OpenClaw tenant unavailable')
    err.statusCode = 503
    throw err
  }
  return tenant
}

// mirrors the { baseUrl, headers: { Authorization: Bearer token }, tenant } shape
// returned by getHttpTargetForCurrentRequest() (lines 461-465).
function buildHttpTarget(tenant) {
  return {
    baseUrl: `http://${tenant.host}:${tenant.port}`,
    headers: { Authorization: `Bearer ${tenant.token || ''}` },
    tenant,
  }
}

async function dispatch(request, { contextTenantId, userTenantId }) {
  const tenant = selectTenantForRequest({ contextTenantId, userTenantId, explicitTenantId: request.tenantId })
  const target = buildHttpTarget(tenant)
  const res = await fetch(new URL('/api/v1/admin/rpc', target.baseUrl), {
    method: 'POST',
    headers: { ...target.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: request.method, params: request.params || {} }),
  })
  return { tenantId: tenant.id, baseUrl: target.baseUrl, status: res.status, body: await res.json() }
}

// ── 3. Run ───────────────────────────────────────────────────────────────────
async function main() {
  verifySourceContract()

  const backends = tenants.tenants.map(createFakeGatewayBackend)
  await Promise.all(backends.map(b => b.listen()))
  const backendById = new Map(backends.map(b => [b.tenant.id, b]))
  const alice = tenants.users.find(u => u.username === 'alice')

  console.log(`\nfake gateway config: multi_tenant=${gatewayConfig.OPENCLAW_MULTI_TENANT} host_port_base=${gatewayConfig.OPENCLAW_HOST_PORT_BASE}`)
  console.log(`fake backends up: ${backends.map(b => `${b.tenant.id}@${b.tenant.host}:${b.tenant.port}`).join(', ')}`)
  console.log(`authenticated user: ${alice.username} -> bound tenant ${alice.tenantId}\n`)

  const results = []

  // Scenario A — allowed tenant reaches the fake backend.
  console.log('[A] allowed tenant request')
  const allowed = await dispatch(
    { method: 'config.get', params: {} },
    { contextTenantId: alice.tenantId, userTenantId: alice.tenantId },
  )
  const t1 = backendById.get('tenant-1')
  expect(allowed.tenantId === 'tenant-1', 'request routed to tenant-1')
  expect(allowed.status === 200 && allowed.body.ok === true, 'fake backend answered 200 ok')
  expect(t1.received.length === 1, 'tenant-1 fake backend recorded exactly 1 dispatch')
  expect(t1.received[0].authorization === `Bearer ${t1.tenant.token}`, 'dispatch carried the tenant Bearer token')
  results.push({ scenario: 'allowed', tenantId: allowed.tenantId, baseUrl: allowed.baseUrl, dispatched: true, status: allowed.status })

  // Scenario B — mismatched tenant rejected before dispatch.
  console.log('\n[B] mismatched tenant request (bound tenant-1, asks for tenant-2)')
  const t2 = backendById.get('tenant-2')
  let mismatch = null
  try {
    await dispatch(
      { method: 'config.get', params: {}, tenantId: 'tenant-2' },
      { contextTenantId: alice.tenantId, userTenantId: alice.tenantId },
    )
  } catch (err) {
    mismatch = err
  }
  expect(mismatch !== null, 'mismatched request was rejected')
  expect(mismatch?.statusCode === 403, 'rejection status is 403 (forbidden)')
  expect(t2.received.length === 0, 'tenant-2 fake backend recorded 0 dispatches (rejected before dispatch)')
  results.push({ scenario: 'mismatched', requestedTenantId: 'tenant-2', rejected: Boolean(mismatch), error: mismatch?.message, dispatched: false })

  // Scenario C — unknown tenant id rejected before dispatch (existence guard).
  console.log('\n[C] unknown tenant request (tenant-9)')
  let unknown = null
  try {
    await dispatch(
      { method: 'config.get', params: {}, tenantId: 'tenant-9' },
      { contextTenantId: alice.tenantId, userTenantId: alice.tenantId },
    )
  } catch (err) {
    unknown = err
  }
  expect(unknown !== null, 'unknown tenant rejected')
  expect(/Tenant tenant-9 not found/.test(unknown?.message || ''), 'error matches the source wording "Tenant tenant-9 not found"')
  const totalDispatches = backends.reduce((sum, b) => sum + b.received.length, 0)
  expect(totalDispatches === 1, `total fake-backend dispatches across all scenarios is 1 (got ${totalDispatches})`)
  results.push({ scenario: 'unknown', requestedTenantId: 'tenant-9', rejected: Boolean(unknown), error: unknown?.message, dispatched: false })

  await Promise.all(backends.map(b => b.close()))

  const failed = checks.filter(c => !c.passed)
  const summary = {
    task: 'T23',
    ok: failed.length === 0,
    backendDispatchCounts: Object.fromEntries(backends.map(b => [b.tenant.id, b.received.length])),
    scenarios: results,
    checks: checks.length,
    failures: failed.map(c => c.label),
  }
  console.log('\n--- normalized result ---')
  console.log(JSON.stringify(summary, null, 2))
  process.exit(summary.ok ? 0 : 1)
}

main().catch(err => {
  console.error('demo crashed:', err)
  process.exit(1)
})
