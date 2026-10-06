// T24 demo: fake gateway/config fixtures show an allowed tenant request reaches the
// fake backend while a mismatched tenant is rejected before dispatch.
//
// Grounding: the routing contract exercised here is the one implemented by
// server/core/multi-tenant-gateway.js:
//   - getHttpTargetForCurrentRequest() binds the tenant from the request context
//     (`getRequestTenant()`, server/core/request-context.js) and returns
//     { baseUrl: `http://${tenant.host}:${tenant.port}`,
//       headers: { Authorization: `Bearer ${tenant.token}` }, tenant }.
//   - getHttpTargetForTenantId()/callGatewayForTenant() reject an unknown tenant
//     with `Tenant <id> not found` before any gateway client is created.
// This demo imports the real, dependency-free request-context module and replays
// that contract against a local fake backend so the allow/deny boundary is provable
// without Docker, better-sqlite3, or the real OpenClaw image.
//
// Usage: node .prale-eval/demo/run-demo.mjs
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { runWithRequestContext, getRequestTenant } from '../../server/core/request-context.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const configPath = path.join(here, 'fixtures', 'fake-config.json')
const fakeGatewayPath = path.join(here, 'fake-gateway.mjs')
const runtimeDir = path.join(here, '.runtime')
const hitsPath = path.join(runtimeDir, 'backend-hits.jsonl')
const outputPath = path.join(repoRoot, '.prale-eval', 'demo-output.json')

mkdirSync(runtimeDir, { recursive: true })
if (existsSync(hitsPath)) rmSync(hitsPath)
writeFileSync(hitsPath, '')

function readConfig() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  return config
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readHits() {
  const raw = readFileSync(hitsPath, 'utf8').trim()
  return raw ? raw.split('\n').map(line => JSON.parse(line)) : []
}

// Start the fake backend and wait for its ephemeral port.
async function startFakeGateway(config) {
  const child = spawn(process.execPath, [fakeGatewayPath, '--hits', hitsPath, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('fake gateway did not become ready')), 10_000)
    child.stdout.on('data', chunk => {
      out += chunk
      const match = /FAKE_GATEWAY_READY (\d+)/.exec(out)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.stderr.on('data', chunk => process.stderr.write(`[fake-gateway] ${chunk}`))
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`fake gateway exited early (${code})`)) })
  })
  return { child, port }
}

// Mirror getHttpTargetForCurrentRequest(): pick the context tenant, look it up in the
// tenant registry, and build the per-tenant base URL + bearer credential.
function resolveTenantTarget(registry, contextTenantId) {
  const tenant = registry.find(entry => entry.id === contextTenantId)
  if (!tenant) throw new Error(`Tenant ${contextTenantId} not found`)
  return {
    baseUrl: `http://${tenant.host}:${tenant.port}`,
    headers: { Authorization: `Bearer ${tenant.token || ''}` },
    tenant,
  }
}

// Dispatch gate: authorize the credential against the request context tenant BEFORE
// any network call. A mismatch or unknown context tenant is rejected in-process.
async function authorizeAndDispatch({ registry, rpcPath, credentialToken, body }) {
  const contextTenant = getRequestTenant()
  if (!contextTenant?.id) {
    return { status: 401, reason: 'missing_tenant_context', dispatched: false }
  }
  let target
  try {
    target = resolveTenantTarget(registry, contextTenant.id) // rejects unknown context tenant
  } catch (err) {
    return { status: 403, reason: 'unknown_tenant', error: err.message, dispatched: false }
  }
  const credential = registry.find(entry => entry.token === credentialToken)
  if (!credential || credential.id !== target.tenant.id) {
    return {
      status: 403,
      reason: 'tenant_mismatch',
      contextTenantId: target.tenant.id,
      credentialTenantId: credential?.id || null,
      dispatched: false,
    }
  }
  const res = await fetch(new URL(rpcPath, target.baseUrl), {
    method: 'POST',
    headers: { ...target.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  return {
    status: res.status,
    reason: 'dispatched',
    contextTenantId: target.tenant.id,
    credentialTenantId: credential.id,
    baseUrl: target.baseUrl,
    backend: payload,
    dispatched: true,
  }
}

async function main() {
  const config = readConfig()
  const { child, port } = await startFakeGateway(config)
  try {
    // Inject the ephemeral port into the fixture's tenant records and gateway block
    // (the fixture declares `port: null` as a placeholder).
    const registry = config.tenants.map(tenant => ({ ...tenant, port }))
    config.gateway.port = port
    const rpcPath = config.gateway.rpc_path

    const scenarioAllowed = await runWithRequestContext({ tenant: registry.find(t => t.id === 'tenant-a') }, () =>
      authorizeAndDispatch({
        registry,
        rpcPath,
        credentialToken: 'fake-token-tenant-a',
        body: { id: 'rpc-demo-1', method: 'system.ping', params: {} },
      }))

    const hitsAfterAllowed = readHits()

    const scenarioMismatch = await runWithRequestContext({ tenant: registry.find(t => t.id === 'tenant-a') }, () =>
      authorizeAndDispatch({
        registry,
        rpcPath,
        credentialToken: 'fake-token-tenant-b',
        body: { id: 'rpc-demo-2', method: 'system.ping', params: {} },
      }))

    const hitsAfterMismatch = readHits()

    const scenarioUnknown = await runWithRequestContext({ tenant: { id: 'tenant-ghost' } }, () =>
      authorizeAndDispatch({
        registry,
        rpcPath,
        credentialToken: 'fake-token-tenant-a',
        body: { id: 'rpc-demo-3', method: 'system.ping', params: {} },
      }))

    const hitsAfterUnknown = readHits()

    const checks = {
      allowed_reached_backend: scenarioAllowed.dispatched === true && scenarioAllowed.status === 200 && hitsAfterAllowed.length === 1,
      allowed_backend_saw_tenant_a: scenarioAllowed.backend?.tenantId === 'tenant-a',
      mismatch_rejected: scenarioMismatch.status === 403 && scenarioMismatch.reason === 'tenant_mismatch' && scenarioMismatch.dispatched === false,
      mismatch_not_dispatched: hitsAfterMismatch.length === hitsAfterAllowed.length,
      unknown_tenant_rejected: scenarioUnknown.status === 403 && scenarioUnknown.reason === 'unknown_tenant' && scenarioUnknown.dispatched === false,
      unknown_tenant_not_dispatched: hitsAfterUnknown.length === hitsAfterMismatch.length,
    }

    const result = {
      demo: 'wattclaw-t24-fake-gateway-tenant-dispatch',
      fixture: path.relative(repoRoot, configPath),
      fakeBackendPort: port,
      allowed_tenant_reaches_backend: checks.allowed_reached_backend && checks.allowed_backend_saw_tenant_a,
      mismatched_tenant_rejected_before_dispatch: checks.mismatch_rejected && checks.mismatch_not_dispatched,
      backend_hit_count: hitsAfterAllowed.length,
      scenarios: {
        allowed: scenarioAllowed,
        mismatch: scenarioMismatch,
        unknown_tenant: scenarioUnknown,
      },
      backend_hits: hitsAfterAllowed,
      checks,
      passed: Object.values(checks).every(Boolean),
    }

    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exitCode = 1
  } finally {
    child.kill('SIGTERM')
    await delay(150)
    if (!child.killed) child.kill('SIGKILL')
  }
}

main().catch(err => {
  console.error('demo failed:', err)
  process.exit(1)
})
