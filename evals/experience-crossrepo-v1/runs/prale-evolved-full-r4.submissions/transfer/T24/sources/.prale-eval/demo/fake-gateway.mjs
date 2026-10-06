// Fake OpenClaw gateway backend used by the T24 demo.
//
// It stands in for the per-tenant gateway HTTP endpoint that
// server/core/multi-tenant-gateway.js targets via getHttpTargetForCurrentRequest()
// (`baseUrl = http://<tenant.host>:<tenant.port>`, `Authorization: Bearer <tenant.token>`).
//
// Each accepted request is appended as one JSON line to the --hits file so the demo
// can prove a request actually reached the backend (and, for the rejected case, that
// no line was written).
//
// Usage: node fake-gateway.mjs --hits <path> [--config <path>]
// On ready it prints: FAKE_GATEWAY_READY <port>
import http from 'http'
import { appendFileSync, readFileSync } from 'fs'

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const hitsPath = argValue('--hits')
const configPath = argValue('--config')
if (!hitsPath) {
  console.error('fake-gateway: --hits <path> is required')
  process.exit(2)
}

// Token -> tenant id map so the fake backend can attribute a hit to a tenant,
// exactly like a real per-tenant gateway would resolve its own credential.
const tokenToTenant = new Map()
if (configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  for (const tenant of config.tenants || []) tokenToTenant.set(tenant.token, tenant.id)
}

function tenantFromAuthorization(header = '') {
  const match = /^Bearer\s+(.+)$/i.exec(String(header))
  if (!match) return null
  return tokenToTenant.get(match[1]) || null
}

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || ''
  const tenantId = tenantFromAuthorization(auth)
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    appendFileSync(hitsPath, `${JSON.stringify({
      ts: Date.now(),
      method: req.method,
      path: req.url,
      authorization: auth,
      tenantId,
      body: body ? JSON.parse(body) : null,
    })}\n`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, receivedBy: 'fake-backend', tenantId }))
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`FAKE_GATEWAY_READY ${server.address().port}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
