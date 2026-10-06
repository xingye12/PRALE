#!/usr/bin/env node
// WattClaw multi-tenant dispatch demo (task T23, repository wattclaw, mode demo).
//
// Runs entirely offline against local fake gateway backends and local fixtures.
// No npm dependencies, no Docker, no real OpenClaw container.
//
// Contract demonstrated (all citations are repository-relative, inclusive lines):
//
//   1. server/core/request-context.js:5-7   runWithRequestContext(context, fn)
//      server/core/request-context.js:17-19 getRequestTenant()
//      Every in-flight request carries the tenant it was authorized against in an
//      AsyncLocalStorage context (set by server/core/auth.js:25-36 authMiddleware
//      after ensureTenantForUser resolves the caller's tenant).
//
//   2. server/core/multi-tenant-gateway.js:501-509 getTenantForUser(userId)
//      The user -> tenant binding is a lookup over user_tenant_assignments joined
//      with openclaw_tenants; a user has exactly one bound tenant.
//
//   3. server/core/multi-tenant-gateway.js:448-466 getHttpTargetForCurrentRequest()
//      The dispatch target is derived ONLY from the request-context tenant:
//        baseUrl = `http://${tenant.host}:${tenant.port}`
//        headers  = { Authorization: `Bearer ${tenant.token || ''}` }
//      so tenant A's traffic can never inherit tenant B's host/port or token.
//
//   4. server/index.js:390-398 broadcastWattClawProjectsChanged()
//      server/core/gateway-client.js:14-30 _buildGatewayHttpOptions() consumes the
//      per-tenant target above when dispatching admin RPCs.
//      The repository's existing cross-tenant guard pattern: a shared fan-out
//      skips any client whose tenantId does not match the event tenant
//      (`if (!client.isAdmin && tenantId && client.tenantId !== tenantId) continue`).
//      This demo reuses that same "mismatched tenant => do not proceed" predicate,
//      hoisted in front of dispatch so a mismatched request is rejected with 403
//      before any target is built and before any byte reaches a fake backend.
//
// Usage:  node demo/tenant-routing-demo.mjs
// Exit code 0 = every fixture expectation held; 1 = a check failed.

import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const gatewaysConfig = JSON.parse(readFileSync(path.join(here, 'fixtures/gateway-config.json'), 'utf8'))
const requestsConfig = JSON.parse(readFileSync(path.join(here, 'fixtures/requests.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Request context: a faithful local stand-in for server/core/request-context.js
// (AsyncLocalStorage-backed user + tenant binding).
// ---------------------------------------------------------------------------
const requestContext = new AsyncLocalStorage()

function runWithRequestContext(context, fn) {
  return requestContext.run(context || {}, fn)
}

function getRequestContext() {
  return requestContext.getStore() || null
}

function getRequestTenant() {
  return getRequestContext()?.tenant || null
}

function getRequestUser() {
  return getRequestContext()?.user || null
}

// ---------------------------------------------------------------------------
// Fake gateway backends: one HTTP server per tenant record in the fixture.
// Each backend only accepts its own bearer token and records everything it saw,
// which is what lets the demo prove "no bytes arrived" for rejected requests.
// ---------------------------------------------------------------------------
function startFakeBackend(tenant, bindHost, rpcPath) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const authorization = req.headers.authorization || ''
      const tokenOk = authorization === `Bearer ${tenant.token}`
      let rpc = null
      try { rpc = body ? JSON.parse(body) : null } catch { rpc = null }
      received.push({ method: req.method, url: req.url, authorization, tokenOk, rpc })
      if (!tokenOk) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, tenant: tenant.id, error: 'fake backend rejected bearer token' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tenant: tenant.id, rpc: rpc?.method ?? null, echo: rpc?.params ?? null }))
    })
  })
  return new Promise(resolve => {
    server.listen(tenant.port, bindHost, () => {
      tenant.port = server.address().port            // resolved ephemeral port
      tenant.baseUrl = `http://${tenant.host}:${tenant.port}`
      resolve({ tenant, server, received })
    })
  })
}

// ---------------------------------------------------------------------------
// Routing helpers mirroring the cited production code paths.
// ---------------------------------------------------------------------------
function tenantById(tenants, id) {
  return tenants.find(t => t.id === id) || null
}

// server/core/multi-tenant-gateway.js:501-509 — one tenant per user.
function getTenantForUser(config, userId) {
  const assignment = config.assignments.find(a => a.userId === userId)
  if (!assignment) return null
  return tenantById(config.tenants, assignment.tenantId)
}

// server/core/multi-tenant-gateway.js:448-466 — target built only from the
// request-context tenant record.
function getHttpTargetForCurrentRequest() {
  const tenant = getRequestTenant()
  return {
    baseUrl: `http://${tenant.host}:${tenant.port}`,
    headers: { Authorization: `Bearer ${tenant.token || ''}` },
    tenant,
  }
}

// server/index.js:390-398 — the repository's cross-tenant guard predicate.
function tenantMatches(routeTenantId, contextTenantId) {
  return !routeTenantId || routeTenantId === contextTenantId
}

// ---------------------------------------------------------------------------
// One inbound request lifecycle: authenticate -> bind tenant -> guard -> dispatch.
// ---------------------------------------------------------------------------
async function handleRequest(env, request) {
  const user = env.config.users.find(u => u.id === request.user)
  if (!user) throw new Error(`unknown fixture user: ${request.user}`)
  const boundTenant = getTenantForUser(env.config, user.id)
  if (!boundTenant) throw new Error(`no tenant assignment for ${user.id}`)

  return runWithRequestContext({ user, tenant: boundTenant }, async () => {
    const contextTenant = getRequestTenant()
    const routeTenantId = request.requestedTenantId || ''
    const dispatchAttemptsBefore = env.dispatchAttempts

    // Guard runs BEFORE any target is built / any socket is written.
    if (!tenantMatches(routeTenantId, contextTenant.id)) {
      return {
        name: request.name,
        user: user.id,
        requestedTenantId: routeTenantId,
        boundTenantId: contextTenant.id,
        status: 403,
        dispatched: false,
        dispatchAttemptsBefore,
        dispatchAttemptsAfter: env.dispatchAttempts,
        backendTenantId: null,
        authorization: null,
        baseUrl: null,
        error: `tenant mismatch: user ${user.id} is bound to ${contextTenant.id} but requested ${routeTenantId}`,
        response: null,
      }
    }

    const target = getHttpTargetForCurrentRequest()
    env.dispatchAttempts += 1

    const res = await fetch(new URL(env.config.gateway.rpcPath, target.baseUrl), {
      method: 'POST',
      headers: { ...target.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `rpc-${request.name}`, method: request.rpc.method, params: request.rpc.params }),
    })
    const payload = await res.json()

    return {
      name: request.name,
      user: user.id,
      requestedTenantId: routeTenantId,
      boundTenantId: contextTenant.id,
      status: res.status,
      dispatched: true,
      dispatchAttemptsBefore,
      dispatchAttemptsAfter: env.dispatchAttempts,
      backendTenantId: target.tenant.id,
      authorization: target.headers.Authorization,
      baseUrl: target.baseUrl,
      error: null,
      response: payload,
    }
  })
}

// ---------------------------------------------------------------------------
// Expectations from the request fixture.
// ---------------------------------------------------------------------------
function evaluateCase(result, expect, env, receivedBefore) {
  const checks = []
  const add = (ok, detail) => checks.push({ ok, detail })

  if (expect.status !== undefined) add(result.status === expect.status, `status ${result.status} === ${expect.status}`)
  if (expect.dispatched !== undefined) add(result.dispatched === expect.dispatched, `dispatched ${result.dispatched} === ${expect.dispatched}`)
  if (expect.backendTenantId !== undefined) add(result.backendTenantId === expect.backendTenantId, `backendTenantId ${result.backendTenantId} === ${expect.backendTenantId}`)
  if (expect.authorization !== undefined) add(result.authorization === expect.authorization, `authorization ${JSON.stringify(result.authorization)} === ${JSON.stringify(expect.authorization)}`)
  if (expect.errorContains !== undefined) add(String(result.error || '').includes(expect.errorContains), `error contains ${JSON.stringify(expect.errorContains)}`)
  if (expect.noNewBackendRequests === true) {
    const grewBackends = env.backends.filter(b => b.received.length > (receivedBefore[b.tenant.id] ?? 0))
    add(result.dispatchAttemptsAfter === result.dispatchAttemptsBefore, `dispatch attempt counter unchanged (${result.dispatchAttemptsBefore})`)
    add(grewBackends.length === 0, `no fake backend received a request (grew: ${grewBackends.map(b => b.tenant.id).join(',') || 'none'})`)
  }
  return checks
}

// ---------------------------------------------------------------------------
// Run the demo.
// ---------------------------------------------------------------------------
async function main() {
  const env = {
    config: {
      ...gatewaysConfig,
      tenants: gatewaysConfig.tenants.map(t => ({ ...t })),
    },
    dispatchAttempts: 0,
    backends: [],
  }

  for (const tenant of env.config.tenants) {
    env.backends.push(await startFakeBackend(tenant, env.config.gateway.bindHost, env.config.gateway.rpcPath))
  }

  const report = {
    demo: 'wattclaw-multi-tenant-dispatch',
    task: 'T23',
    repository: 'wattclaw',
    mode: 'demo',
    fakeBackends: env.backends.map(b => ({ tenantId: b.tenant.id, baseUrl: b.tenant.baseUrl, token: b.tenant.token })),
    results: [],
    checks: [],
    passed: true,
  }

  for (const request of requestsConfig.cases) {
    const receivedBefore = Object.fromEntries(env.backends.map(b => [b.tenant.id, b.received.length]))
    const result = await handleRequest(env, request)
    const checks = evaluateCase(result, request.expect, env, receivedBefore)
    const ok = checks.every(c => c.ok)
    if (!ok) report.passed = false
    report.checks.push({ case: request.name, ok, checks })
    report.results.push({
      case: request.name,
      status: result.status,
      dispatched: result.dispatched,
      requestedTenantId: result.requestedTenantId,
      boundTenantId: result.boundTenantId,
      backendTenantId: result.backendTenantId,
      authorization: result.authorization,
      baseUrl: result.baseUrl,
      error: result.error,
      backendResponse: result.response,
    })
  }

  report.backendTraffic = env.backends.map(b => ({
    tenantId: b.tenant.id,
    requests: b.received.length,
    allTokensValid: b.received.every(r => r.tokenOk),
    seen: b.received.map(r => ({ method: r.method, url: r.url, authorization: r.authorization, tokenOk: r.tokenOk, rpc: r.rpc?.method ?? null })),
  }))
  report.totalDispatchAttempts = env.dispatchAttempts

  for (const backend of env.backends) backend.server.close()

  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) {
    console.error('\nDEMO FAILED: at least one fixture expectation did not hold.')
    process.exitCode = 1
    return
  }
  console.log('\nDEMO OK: allowed tenant request reached its fake backend; mismatched tenant was rejected (403) before dispatch.')
}

main().catch(err => {
  console.error('DEMO ERROR:', err)
  process.exitCode = 1
})
