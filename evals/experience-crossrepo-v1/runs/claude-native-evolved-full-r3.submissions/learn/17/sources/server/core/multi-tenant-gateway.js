import EventEmitter from 'events'
import http from 'http'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  chownSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import db from '../database.js'
import { OpenClawGateway } from '../gateway.js'
import { getRequestTenant, getRequestUser } from './request-context.js'
import { hashDirectory } from './plugin-fingerprint.js'

const DEFAULT_OPENCLAW_IMAGE = 'ghcr.io/openclaw/openclaw:latest'
const WEB_SEARCH_SETUP_SCRIPT = 'scripts/configure-openclaw-web-search.sh'
const WATTCLAW_TEAM_INSTALL_MARKER = '/home/node/.openclaw/.wattclaw-team-install.json'
const PROMPT_CAPTURE_INSTALL_MARKER = '/home/node/.openclaw/.wattclaw-prompt-capture-install.json'
const HERMES_PLUGIN_INSTALL_MARKER = '/home/node/.openclaw/.openclaw-plugin-hermes-install.json'
const LARK_INSTALL_MARKER = '/home/node/.openclaw/.openclaw-lark-install.json'

const larkPluginPatchFiles = [
  'core/owner-policy.js',
  'tools/oauth.js',
  'tools/onboarding-auth.js',
  'channel/monitor.js',
]

const extraPersistentMounts = [
  { relativePath: 'openclaw.json', containerPath: '/home/node/openclaw.json', type: 'file', defaultContent: '{}\n' },
  { relativePath: 'container/home-node/.config', containerPath: '/home/node/.config', type: 'dir' },
  { relativePath: 'container/home-node/.cache', containerPath: '/home/node/.cache', type: 'dir' },
  { relativePath: 'container/home-node/.local/share', containerPath: '/home/node/.local/share', type: 'dir' },
  { relativePath: 'container/home-node/.local/state', containerPath: '/home/node/.local/state', type: 'dir' },
  { relativePath: 'container/tmp', containerPath: '/tmp/openclaw', type: 'dir' },
]

let manager = null

function trace(message, details = {}) {
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  console.log(`[MultiTenantTrace] ${message}${entries.length ? ` ${entries.join(' ')}` : ''}`)
}

export function initMultiTenantGateway(envConfig) {
  manager = new MultiTenantGatewayManager(envConfig)
  return manager.proxy
}

export function getMultiTenantManager() {
  return manager
}

export async function ensureTenantForUser(user) {
  if (!manager || !manager.enabled || !user?.id) return null
  return manager.ensureUserTenant(user)
}

export async function getGatewayForCurrentRequest() {
  if (!manager || !manager.enabled) return null
  return manager.getGatewayForCurrentRequest()
}

export async function getGatewayHttpTargetForCurrentRequest() {
  if (!manager || !manager.enabled) return null
  return manager.getHttpTargetForCurrentRequest()
}

export async function callGatewayForTenant(tenantId, method, params, timeout) {
  if (!manager || !manager.enabled) return null
  return manager.callGatewayForTenant(tenantId, method, params, timeout)
}

export async function callGatewayForAllTenants(method, params, timeout) {
  if (!manager || !manager.enabled) return null
  return manager.callGatewayForAllTenants(method, params, timeout)
}

export async function getGatewayHttpTargetForTenantId(tenantId) {
  if (!manager || !manager.enabled) return null
  return manager.getHttpTargetForTenantId(tenantId)
}

export async function getGatewayHttpTargetsForAllTenants() {
  if (!manager || !manager.enabled) return null
  return manager.getHttpTargetsForAllTenants()
}

export function listOpenClawTenants() {
  if (!manager) return []
  return manager.listTenants()
}

export function getAllUserAssignments() {
  if (!manager || !manager.enabled) return { tenants: [], unassigned: [] }
  return manager.getAllUserAssignments()
}

export function moveUserToTenant(userId, tenantId, beforeAssign) {
  if (!manager || !manager.enabled) throw new Error('Multi-tenant not enabled')
  return manager.moveUserToTenant(userId, tenantId, beforeAssign)
}

export async function createOpenClawTenant() {
  if (!manager || !manager.enabled) throw new Error('Multi-tenant not enabled')
  return manager.createTenantFromTemplate()
}

export async function runOpenClawCliForTenant(tenant, args = [], timeoutMs = 30_000) {
  if (!manager || !manager.enabled || !tenant?.containerName) return null
  await manager.ensureContainerRunning(tenant.containerName)
  return dockerExecOpenClawCli(tenant.containerName, args, timeoutMs)
}

export function getAllTenantStates() {
  if (!manager || !manager.enabled) return []
  return manager.getAllTenantStates()
}

export class MultiTenantGatewayProxy extends EventEmitter {
  constructor(manager) {
    super()
    this.manager = manager
  }

  get isConnected() {
    return this.manager.hasConnectedGateway()
  }

  async connect() {
    await this.manager.bootstrap()
  }

  disconnect() {
    this.manager.disconnectAll()
  }

  async call(method, params, timeout) {
    const gateway = await this.manager.getGatewayForCurrentRequest()
    return gateway.call(method, params, timeout)
  }
}

class MultiTenantGatewayManager {
  constructor(envConfig) {
    this.envConfig = envConfig
    this.enabled = envConfig.OPENCLAW_MULTI_TENANT !== 'false'
    this.proxy = new MultiTenantGatewayProxy(this)
    this.clients = new Map()
    this.connecting = new Map()
    this.larkPatched = new Map()
    this.larkRetryAfter = new Map()
    this.larkSourceState = null
    this.wattclawTeamInstalled = new Map()
    this.wattclawTeamRetryAfter = new Map()
    this.pluginProvisioning = new Map()
    this.wattclawTeamSourceState = null
    this.promptCaptureInstalled = new Map()
    this.promptCaptureRetryAfter = new Map()
    this.promptCaptureSourceState = null
    this.webSearchProvidersReady = new Set()
    this.webSearchProviderRetryAfter = new Map()
    this.hermesPluginInstalled = new Map()
    this.hermesPluginRetryAfter = new Map()
    this.hermesPluginSourceState = null
    this.hermesContainerReady = new Set()
    this.hermesSharedInflight = null
    this.hermesImageReady = false
    this.bootstrapped = false
    this.bootstrapping = null
    this.allocating = Promise.resolve()
    this.imagePulling = null
    this.config = resolveConfig(envConfig)
  }

  async bootstrap() {
    if (!this.enabled) return
    if (this.bootstrapped) return
    if (this.bootstrapping) return this.bootstrapping
    this.bootstrapping = this._bootstrap()
    return this.bootstrapping
  }

  async _bootstrap() {
    const initialCount = Math.min(this.config.maxTenants, Math.max(1, this.config.initialTenants))

    // Records are created synchronously first (better-sqlite3 is synchronous),
    // then containers start in parallel. Each tenant provisions independently,
    // so bootstrap no longer serializes the (slow) container start + plugin
    // install + health wait across tenants.
    const initialTenants = []
    for (let i = 1; i <= initialCount; i += 1) {
      initialTenants.push(this.ensureTenantRecord(`tenant-${i}`))
    }

    const staleTenants = this.listTenants().filter(t =>
      t.id.startsWith('tenant-')
      && tenantIndex(t.id) > initialCount
      && tenantIndex(t.id) <= this.config.maxTenants
    ).map(t => this.ensureTenantRecord(t.id))

    // Initial tenants must succeed (failure aborts bootstrap); stale tenant
    // recovery is best-effort and only logs on failure.
    await Promise.all([
      ...initialTenants.map(async tenant => {
        await this.ensureTenantContainer(tenant)
        this.ensureGatewayClient(tenant)
      }),
      ...staleTenants.map(async tenant => {
        try {
          await this.ensureTenantContainer(tenant)
          this.ensureGatewayClient(tenant)
        } catch (err) {
          console.error(`[MultiTenant] Failed to recover container ${tenant.id}: ${err.message}`)
        }
      }),
    ])

    this.bootstrapped = true

    await new Promise(resolve => setTimeout(resolve, 2000))

    if (this.hasConnectedGateway()) {
      this.proxy.emit('stateChange', 'connected')
    } else {
      this.proxy.emit('stateChange', 'connecting')
    }

    await this.preallocateUsers()
  }

  async preallocateUsers() {
    const users = db.prepare("SELECT id, username FROM users WHERE id NOT IN (SELECT user_id FROM user_tenant_assignments)").all()
    if (users.length === 0) return

    let tenants = this.listTenants()
    if (tenants.length === 0) return

    const totalCapacity = tenants.reduce((sum, t) => sum + t.maxUsers, 0)
    if (users.length > totalCapacity) {
      const needed = Math.ceil((users.length - totalCapacity) / this.config.maxUsers)
      if (tenants.length + needed > this.config.maxTenants) {
        throw new Error(`OpenClaw tenant capacity exceeded (${users.length} users, ${this.config.maxTenants} tenants)`)
      }
      let nextId = nextTenantId(tenants.map(t => t.id))
      for (let i = 0; i < needed; i += 1) {
        const tenant = this.ensureTenantRecord(nextId)
        try {
          await this.ensureTenantContainer(tenant)
          this.ensureGatewayClient(tenant)
        } catch (err) {
          console.error(`[MultiTenant] Failed to create container ${tenant.id}: ${err.message}`)
        }
        nextId = `tenant-${tenantIndex(nextId) + 1}`
      }
      tenants = this.listTenants()
    }

    let tenantIdx = 0
    for (const user of users) {
      let tenant = tenants[tenantIdx % tenants.length]
      let assigned = false

      for (let attempts = 0; attempts < tenants.length; attempts += 1) {
        tenant = tenants[(tenantIdx + attempts) % tenants.length]
        const count = db.prepare("SELECT COUNT(*) AS cnt FROM user_tenant_assignments WHERE tenant_id = ?").get(tenant.id).cnt
        if (count < tenant.maxUsers) {
          this.assignUserToTenant(user.id, tenant.id)
          assigned = true
          break
        }
      }

      if (!assigned && tenants[0]) {
        this.assignUserToTenant(user.id, tenants[0].id)
      }

      tenantIdx += 1
    }

    console.log(`[MultiTenant] Preallocated ${users.length} users across ${tenants.length} tenants`)
  }

  getAllUserAssignments() {
    const tenants = this.listTenants()
    const result = tenants.map(tenant => {
      const users = db.prepare(`
        SELECT u.id, u.username, u.display_name
        FROM user_tenant_assignments uta
        JOIN users u ON u.id = uta.user_id
        WHERE uta.tenant_id = ?
        ORDER BY u.username
      `).all(tenant.id)
      return {
        id: tenant.id,
        token: tenant.token,
        containerName: tenant.containerName,
        host: tenant.host,
        port: tenant.port,
        publicProtocol: this.config.publicProtocol,
        publicHost: this.config.publicHost,
        publicPort: this.resolveTenantPublicPort(tenant.id),
        maxUsers: tenant.maxUsers,
        status: tenant.status,
        userCount: users.length,
        users,
      }
    })

    const assignedUserIds = new Set()
    for (const tenant of result) {
      for (const user of tenant.users) {
        assignedUserIds.add(user.id)
      }
    }

    const unassigned = db.prepare(`
      SELECT id, username, display_name FROM users
      ORDER BY username
    `).all().filter(u => !assignedUserIds.has(u.id))

    return { tenants: result, unassigned }
  }

  moveUserToTenant(userId, tenantId, beforeAssign) {
    const tenant = normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(tenantId))
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`)

    const current = db.prepare('SELECT tenant_id FROM user_tenant_assignments WHERE user_id = ?').get(userId)
    const previousTenantId = current?.tenant_id || ''
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM user_tenant_assignments WHERE tenant_id = ? AND user_id != ?").get(tenantId, userId).cnt
    if (count >= tenant.maxUsers) {
      throw new Error(`Tenant ${tenantId} is full (${count}/${tenant.maxUsers})`)
    }

    const sync = typeof beforeAssign === 'function'
      ? beforeAssign({ userId, tenantId, previousTenantId })
      : null
    this.assignUserToTenant(userId, tenantId)
    return sync ? { ok: true, sync } : { ok: true }
  }

  async ensureUserTenant(user) {
    await this.bootstrap()
    const current = this.getTenantForUser(user.id)
    if (current) {
      trace('user tenant found', {
        userId: user.id,
        username: user.username,
        tenantId: current.id,
        container: current.containerName,
        dataSource: current.dataSource,
      })
      await this.ensureTenantContainer(current)
      this.ensureGatewayClient(current)
      return current
    }

    return this.withAllocationLock(async () => {
      const latest = this.getTenantForUser(user.id)
      if (latest) {
        trace('user tenant found after allocation wait', {
          userId: user.id,
          username: user.username,
          tenantId: latest.id,
          container: latest.containerName,
          dataSource: latest.dataSource,
        })
        return latest
      }

      const tenant = await this.allocateTenant()
      this.assignUserToTenant(user.id, tenant.id)
      trace('user tenant assigned', {
        userId: user.id,
        username: user.username,
        tenantId: tenant.id,
        container: tenant.containerName,
        dataSource: tenant.dataSource,
      })
      await this.ensureTenantContainer(tenant)
      this.ensureGatewayClient(tenant)
      return tenant
    })
  }

  async getGatewayForCurrentRequest() {
    const user = getRequestUser()
    const contextTenant = getRequestTenant()
    const tenant = contextTenant || (user ? await this.ensureUserTenant(user) : await this.getDefaultTenant())
    trace('request gateway selected', {
      userId: user?.id,
      username: user?.username,
      tenantId: tenant.id,
      container: tenant.containerName,
      wsUrl: this.buildWsUrl(tenant),
    })
    const gateway = this.ensureGatewayClient(tenant)
    await this.ensureConnected(tenant.id, gateway)
    return gateway
  }

  // Call a specific tenant's cached WS gateway client directly. Used for
  // cross-tenant admin operations (e.g. aggregating collaboration projects that
  // are physically isolated per tenant). Unlike getGatewayForCurrentRequest,
  // this bypasses request-context tenant selection.
  async callGatewayForTenant(tenantId, method, params, timeout) {
    await this.bootstrap()
    const tenant = normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(tenantId))
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`)
    const gateway = this.ensureGatewayClient(tenant)
    await this.ensureConnected(tenant.id, gateway)
    return gateway.call(method, params, timeout)
  }

  // Fan out an RPC across every tenant's WS client. Returns an array of
  // { tenantId, ok, value|error } so callers can attribute each result to its
  // owning tenant (needed to route scoped follow-up operations).
  async callGatewayForAllTenants(method, params, timeout) {
    await this.bootstrap()
    const tenants = this.listTenants()
    const settled = await Promise.allSettled(
      tenants.map(async tenant => {
        const gateway = this.ensureGatewayClient(tenant)
        await this.ensureConnected(tenant.id, gateway)
        return gateway.call(method, params, timeout)
      })
    )
    return settled.map((outcome, index) => {
      const tenantId = tenants[index]?.id
      if (outcome.status === 'fulfilled') {
        return { tenantId, ok: true, value: outcome.value }
      }
      return { tenantId, ok: false, error: outcome.reason }
    })
  }

  async getHttpTargetForCurrentRequest() {
    const user = getRequestUser()
    const contextTenant = getRequestTenant()
    const tenant = contextTenant || (user ? await this.ensureUserTenant(user) : await this.getDefaultTenant())
    trace('request http target selected', {
      userId: user?.id,
      username: user?.username,
      tenantId: tenant.id,
      container: tenant.containerName,
      baseUrl: `http://${tenant.host}:${tenant.port}`,
    })
    const gateway = this.ensureGatewayClient(tenant)
    await this.ensureConnected(tenant.id, gateway)
    return {
      baseUrl: `http://${tenant.host}:${tenant.port}`,
      headers: { Authorization: `Bearer ${tenant.token || ''}` },
      tenant,
    }
  }

  async getHttpTargetForTenantId(tenantId) {
    await this.bootstrap()
    const tenant = normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(tenantId))
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`)

    trace('explicit http target selected', {
      tenantId: tenant.id,
      container: tenant.containerName,
      baseUrl: `http://${tenant.host}:${tenant.port}`,
    })
    const gateway = this.ensureGatewayClient(tenant)
    await this.ensureConnected(tenant.id, gateway)
    return {
      baseUrl: `http://${tenant.host}:${tenant.port}`,
      headers: { Authorization: `Bearer ${tenant.token || ''}` },
      tenant,
    }
  }

  async getHttpTargetsForAllTenants() {
    await this.bootstrap()
    const tenants = this.listTenants()
    const results = await Promise.allSettled(tenants.map(tenant => this.getHttpTargetForTenantId(tenant.id)))
    return results
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value)
  }

  async getDefaultTenant() {
    await this.bootstrap()
    return this.listTenants()[0] || this.ensureTenantRecord('tenant-1')
  }

  getTenantForUser(userId) {
    const row = db.prepare(`
      SELECT t.*
      FROM user_tenant_assignments uta
      JOIN openclaw_tenants t ON t.id = uta.tenant_id
      WHERE uta.user_id = ?
    `).get(userId)
    return normalizeTenant(row)
  }

  listTenants() {
    const rows = db.prepare(`
      SELECT t.*, COUNT(uta.user_id) AS user_count
      FROM openclaw_tenants t
      LEFT JOIN user_tenant_assignments uta ON uta.tenant_id = t.id
      GROUP BY t.id
      ORDER BY CAST(substr(t.id, 8) AS INTEGER), t.id
    `).all()
    return rows.map(row => ({ ...normalizeTenant(row), userCount: Number(row.user_count || 0) }))
  }

  getAllTenantStates() {
    return this.listTenants().map(tenant => {
      const gw = this.clients.get(tenant.id)
      return {
        id: tenant.id,
        token: tenant.token,
        containerName: tenant.containerName,
        connected: gw && gw.isConnected ? true : false,
        userCount: tenant.userCount,
        publicProtocol: this.config.publicProtocol,
        publicHost: this.config.publicHost,
        publicPort: this.resolveTenantPublicPort(tenant.id),
      }
    })
  }

  async allocateTenant() {
    const tenants = this.listTenants()
    const available = tenants.find(tenant => tenant.userCount < tenant.maxUsers)
    if (available) return available

    if (tenants.length >= this.config.maxTenants) {
      throw new Error(`OpenClaw tenant limit reached (${this.config.maxTenants})`)
    }

    const nextId = nextTenantId(tenants.map(tenant => tenant.id))
    const tenant = this.ensureTenantRecord(nextId)
    await this.ensureTenantContainer(tenant)
    return tenant
  }

  async createTenantFromTemplate() {
    await this.bootstrap()
    return this.withAllocationLock(async () => {
      const tenants = this.listTenants()
      if (tenants.length >= this.config.maxTenants) {
        throw new Error(`OpenClaw tenant limit reached (${this.config.maxTenants})`)
      }
      const tenant = this.ensureTenantRecord(nextTenantId(tenants.map(t => t.id)))
      await this.ensureTenantContainer(tenant)
      this.ensureGatewayClient(tenant)
      return {
        id: tenant.id,
        token: tenant.token,
        containerName: tenant.containerName,
        host: tenant.host,
        port: tenant.port,
        publicProtocol: this.config.publicProtocol,
        publicHost: this.config.publicHost,
        publicPort: this.resolveTenantPublicPort(tenant.id),
        maxUsers: tenant.maxUsers,
        status: tenant.status,
        userCount: 0,
        users: [],
      }
    })
  }

  ensureTenantRecord(id) {
    const existing = normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(id))
    const dataSource = this.resolveTenantDataSource(id)
    const containerName = `${this.config.containerPrefix}-${id.replace(/^tenant-/, '')}`
    const index = tenantIndex(id) - 1
    const token = existing?.token || this.config.tokenForIndex(index, id)
    const cpusetCpus = existing?.cpusetCpus || this.config.resolveCpuSet(index)
    const now = Date.now()

    if (existing) {
      db.prepare(`
        UPDATE openclaw_tenants
        SET container_name = ?, token = ?, host = ?, port = ?, max_users = ?,
            cpuset_cpus = ?, data_source = ?, updated_at = ?
        WHERE id = ?
      `).run(
        containerName, token, containerName, this.config.port, this.config.maxUsers,
        cpusetCpus || '', dataSource, now, id
      )
      return normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(id))
    }

    db.prepare(`
      INSERT INTO openclaw_tenants (
        id, container_name, token, host, port, max_users, cpuset_cpus, data_source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      id, containerName, token, containerName, this.config.port, this.config.maxUsers,
      cpusetCpus || '', dataSource, now, now
    )
    return normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(id))
  }

  assignUserToTenant(userId, tenantId) {
    const now = Date.now()
    db.prepare(`
      INSERT INTO user_tenant_assignments (user_id, tenant_id, assignment_mode, created_at, updated_at)
      VALUES (?, ?, 'auto', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET tenant_id = excluded.tenant_id, updated_at = excluded.updated_at
    `).run(userId, tenantId, now, now)
  }

  async withAllocationLock(fn) {
    const next = this.allocating.then(fn, fn)
    this.allocating = next.catch(() => {})
    return next
  }

  ensureGatewayClient(tenant) {
    const cached = this.clients.get(tenant.id)
    const url = this.buildWsUrl(tenant)
    if (cached?.url === url && cached?.authToken === tenant.token) {
      trace('gateway client reused', {
        tenantId: tenant.id,
        wsUrl: url,
        connected: cached.isConnected,
        readyState: cached.ws?.readyState,
      })
      return cached
    }

    cached?.disconnect?.()
    trace('gateway client created', {
      tenantId: tenant.id,
      container: tenant.containerName,
      wsUrl: url,
      dataSource: tenant.dataSource,
    })
    const gateway = new OpenClawGateway(url, tenant.token, '', this.envConfig.LOG_LEVEL)
    gateway.url = url
    gateway.authToken = tenant.token
    gateway.on('connected', payload => {
      trace('gateway connected event', {
        tenantId: tenant.id,
        wsUrl: url,
        payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      })
      this.proxy.emit('connected', { ...payload, tenantId: tenant.id })
      this.proxy.emit('tenantState', { tenantId: tenant.id, state: 'connected' })
      if (!this.hasConnectedGateway()) this.proxy.emit('stateChange', 'connected')
    })
    gateway.on('version', info => this.proxy.emit('version', info))
    gateway.on('disconnected', (...args) => {
      trace('gateway disconnected event', {
        tenantId: tenant.id,
        code: args[0],
        reason: args[1],
      })
      this.proxy.emit('tenantState', { tenantId: tenant.id, state: 'disconnected' })
      if (!this.hasConnectedGateway()) {
        this.proxy.emit('disconnected', ...args)
        this.proxy.emit('stateChange', 'connecting')
      }
    })
    gateway.on('error', err => {
      trace('gateway error event', {
        tenantId: tenant.id,
        message: err?.message || String(err),
      })
      this.proxy.emit('error', err)
    })
    gateway.on('stateChange', state => {
      trace('gateway state change', {
        tenantId: tenant.id,
        state,
      })
      this.proxy.emit('tenantState', { tenantId: tenant.id, state })
      if (state === 'connected') {
        if (!this.hasConnectedGateway()) this.proxy.emit('stateChange', 'connected')
      } else if (!this.hasConnectedGateway()) {
        this.proxy.emit('stateChange', state)
      }
    })
    gateway.on('event', (event, payload) => {
      const enriched = payload && typeof payload === 'object'
        ? { ...payload, tenantId: tenant.id }
        : payload
      this.proxy.emit('event', event, enriched)
    })
    this.clients.set(tenant.id, gateway)
    gateway.connect()
    return gateway
  }

  async ensureConnected(tenantId, gateway) {
    trace('ensure connected start', {
      tenantId,
      connected: gateway.isConnected,
      readyState: gateway.ws?.readyState,
    })
    if (gateway.isConnected) {
      trace('ensure connected already connected', { tenantId })
      return
    }
    if (this.connecting.has(tenantId)) {
      trace('ensure connected awaiting existing attempt', { tenantId })
      return this.connecting.get(tenantId)
    }

    if (this.approvePendingBackendDevice(tenantId)) {
      trace('ensure connected approved before retry', { tenantId })
      gateway.disconnect()
      gateway.connect()
    }

    const promise = new Promise((resolve, reject) => {
      let approvedOnce = false
      const timer = setTimeout(() => {
        cleanup()
        trace('ensure connected timeout', {
          tenantId,
          readyState: gateway.ws?.readyState,
          connected: gateway.isConnected,
        })
        reject(new Error(`Gateway for ${tenantId} did not connect in time`))
      }, this.config.connectTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        gateway.off('connected', onConnected)
        gateway.off('error', onError)
      }
      const onConnected = () => {
        cleanup()
        trace('ensure connected success', { tenantId })
        resolve()
      }
      const onError = err => {
        trace('ensure connected error', {
          tenantId,
          message: err?.message || String(err),
        })
        if (!approvedOnce && isPairingOrScopeError(err) && this.approvePendingBackendDevice(tenantId)) {
          approvedOnce = true
          trace('ensure connected approved after pairing error', { tenantId })
          gateway.disconnect()
          gateway.connect()
          return
        }
        cleanup()
        reject(err)
      }
      gateway.once('connected', onConnected)
      gateway.once('error', onError)
      if (gateway.isConnected) {
        onConnected()
        return
      }
      if (!gateway.ws || gateway.ws.readyState > 1) {
        trace('ensure connected reconnecting websocket', {
          tenantId,
          readyState: gateway.ws?.readyState,
        })
        gateway.connect()
      }
    }).finally(() => {
      this.connecting.delete(tenantId)
    })

    this.connecting.set(tenantId, promise)
    return promise
  }

  hasConnectedGateway() {
    return [...this.clients.values()].some(client => client.isConnected)
  }

  disconnectAll() {
    for (const client of this.clients.values()) {
      client.disconnect()
    }
    this.clients.clear()
  }

  buildWsUrl(tenant) {
    const wsPath = this.config.wsPath ? `/${this.config.wsPath.replace(/^\/+/, '')}` : ''
    return `ws://${tenant.host}:${tenant.port}${wsPath}`
  }

  resolveTenantDataSource(id) {
    if (this.config.hostDataDir) {
      return `${this.config.hostDataDir.replace(/[\\/]+$/g, '')}/${id}`
    }
    return `${this.config.dataVolumePrefix}-${id}`
  }

  resolveTenantPublicPort(id) {
    return this.config.hostPortBase + Math.max(0, tenantIndex(id) - 1)
  }

  async ensureTenantContainer(tenant) {
    if (!this.config.manageContainers) return
    this.prepareTenantDataDir(tenant.id)
    this.prepareSharedWattclawDir()
    this.prepareSharedAgentsDir()

    const binds = this.buildBinds(tenant.dataSource)
    const env = this.buildTenantEnv(tenant)
    const cmd = this.buildTenantCommand()
    const portBindings = this.buildPortBindings(tenant)

    try {
      const info = await dockerRequest('GET', `/containers/${encodeURIComponent(tenant.containerName)}/json`)
      if (this.shouldRecreateTenantContainer(info, binds, env, cmd, portBindings)) {
        console.log(`[MultiTenant] Recreating ${tenant.containerName} to refresh OpenClaw container config`)
        await dockerRequest('DELETE', `/containers/${encodeURIComponent(tenant.containerName)}?force=true`, null, { allow204: true })
        throw Object.assign(new Error('container config drift'), { statusCode: 404 })
      }
      if (!info?.State?.Running) {
        await dockerRequest('POST', `/containers/${encodeURIComponent(tenant.containerName)}/start`, null, { allow404: false, allow304: true })
      }
      await this.provisionTenantContainer(tenant)
      return
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[MultiTenant] Failed to inspect ${tenant.containerName}: ${err.message}`)
        throw err
      }
    }

    await this.ensureImage()
    const createPayload = {
      Image: this.config.image,
      Cmd: cmd,
      Env: env,
      ExposedPorts: {
        [`${this.config.port}/tcp`]: {},
      },
      HostConfig: {
        Binds: binds,
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: this.config.containerMemoryMb * 1024 * 1024,
        NanoCpus: Math.round(this.config.containerCpus * 1000 * 1000 * 1000),
        ...(tenant.cpusetCpus ? { CpusetCpus: tenant.cpusetCpus } : {}),
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.config.network]: {},
        },
      },
      Labels: {
        'openclaw.gateway.managed': 'true',
        'openclaw.gateway.tenant-id': tenant.id,
        'wattclaw.instance': this.config.instanceId,
        'wattclaw.project-root': this.config.projectRoot,
      },
    }

    await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(tenant.containerName)}`, createPayload)
    await dockerRequest('POST', `/containers/${encodeURIComponent(tenant.containerName)}/start`, null, { allow304: true })
    await this.provisionTenantContainer(tenant)
    console.log(`[MultiTenant] Created OpenClaw container ${tenant.containerName} for ${tenant.id}`)
  }

  // ─── Hermes 1:1 container ──────────────────────────────────────────────────

  hermesContainerNameFor(tenantId) {
    if (this.config.hermesMode === 'shared') {
      return `${this.config.hermesContainerPrefix}-shared`
    }
    return `${this.config.hermesContainerPrefix}-${String(tenantId).replace(/^tenant-/, '')}`
  }

  // Hermes owns this directory at /opt/data. OpenClaw only mounts projections.
  // In shared mode, all tenants share a single Hermes data dir (hermes-shared/),
  // sibling to per-tenant data dirs.
  hermesSharedHostDir(dataSource) {
    if (this.config.hermesMode === 'shared') {
      return path.join(path.dirname(dataSource), 'hermes-shared')
    }
    return joinDockerHostPath(dataSource, 'hermes')
  }

  prepareHermesSharedDir(dataSource) {
    if (!isHostPathDataSource(dataSource)) return
    const hostDir = this.hermesSharedHostDir(dataSource)
    try {
      mkdirSync(path.join(hostDir, 'execenv'), { recursive: true })
      mkdirSync(path.join(hostDir, 'skills'), { recursive: true })
      prepareOwnedPath(path.join(hostDir, 'execenv'), 0o777, this.config.runtimeUid, this.config.runtimeGid)
      prepareOwnedPath(path.join(hostDir, 'skills'), 0o755, this.config.runtimeUid, this.config.runtimeGid)
    } catch (err) {
      console.warn(`[Hermes] Failed to prepare shared dir ${hostDir}: ${err.message}`)
    }
  }

  // Create/start the tenant's paired Hermes container. In shared mode
  // (OPENCLAW_HERMES_MODE=shared), a single Hermes container serves all tenants;
  // the method short-circuits after the first successful create/start, and
  // concurrent callers during bootstrap are serialized so they never race to
  // create the same-named container.
  async ensureHermesContainer(tenant) {
    if (!this.config.manageContainers) return
    if (!this.config.hermesEnabled) return
    if (!this.config.hermesBaseImage) {
      if (!this.hermesContainerReady.has('__warned__')) {
        console.warn('[Hermes] HERMES_IMAGE not set — skipping Hermes container creation')
        this.hermesContainerReady.add('__warned__')
      }
      return
    }

    if (this.config.hermesMode !== 'shared') {
      return this._ensureHermesContainer(tenant)
    }

    // Shared mode: only ever create/start once. Coalesce concurrent bootstrap
    // callers onto a single in-flight promise so parallel tenant provisioning
    // does not issue duplicate `create` calls for the same container name.
    if (this.hermesContainerReady.has('__shared__')) return
    if (this.hermesSharedInflight) return this.hermesSharedInflight

    this.hermesSharedInflight = (async () => {
      try {
        await this._ensureHermesContainer(tenant)
      } finally {
        this.hermesSharedInflight = null
      }
    })()
    return this.hermesSharedInflight
  }

  async _ensureHermesContainer(tenant) {
    const containerName = this.hermesContainerNameFor(tenant.id)
    const dataSource = tenant.dataSource || this.resolveTenantDataSource(tenant.id)
    this.prepareHermesSharedDir(dataSource)

    const binds = isHostPathDataSource(dataSource)
      ? [`${this.hermesSharedHostDir(dataSource)}:/opt/data`]
      : []
    const env = this.buildHermesEnv(tenant)
    const cmd = this.buildHermesCommand()

    try {
      const info = await dockerRequest('GET', `/containers/${encodeURIComponent(containerName)}/json`)
      if (this.shouldRecreateHermesContainer(info, binds, env, cmd)) {
        console.log(`[Hermes] Recreating ${containerName} to refresh container config`)
        await dockerRequest('DELETE', `/containers/${encodeURIComponent(containerName)}?force=true`, null, { allow204: true })
        throw Object.assign(new Error('hermes container config drift'), { statusCode: 404 })
      }
      if (!info?.State?.Running) {
        await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/start`, null, { allow404: false, allow304: true })
      }
      if (this.config.hermesMode === 'shared') this.hermesContainerReady.add('__shared__')
      return
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`[Hermes] Failed to inspect ${containerName}: ${err.message}`)
        return
      }
    }

    try {
      await this.ensureHermesImage()
      const createPayload = {
        Image: this.config.hermesRuntimeImage,
        ...(cmd ? { Cmd: cmd } : {}),
        Env: env,
        HostConfig: {
          Binds: binds,
          RestartPolicy: { Name: 'unless-stopped' },
          Memory: this.config.hermesContainerMemoryMb * 1024 * 1024,
          NanoCpus: Math.round(this.config.hermesContainerCpus * 1000 * 1000 * 1000),
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [this.config.network]: {},
          },
        },
        Labels: {
          'openclaw.gateway.managed': 'true',
          'openclaw.gateway.tenant-id': tenant.id,
          'openclaw.gateway.role': 'hermes',
          'wattclaw.instance': this.config.instanceId,
          'wattclaw.project-root': this.config.projectRoot,
        },
      }
      await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, createPayload)
      await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/start`, null, { allow304: true })
      console.log(`[Hermes] Created Hermes container ${containerName} for ${tenant.id}`)
      if (this.config.hermesMode === 'shared') this.hermesContainerReady.add('__shared__')
    } catch (err) {
      console.warn(`[Hermes] Failed to create ${containerName}: ${err.message}`)
    }
  }

  buildHermesEnv(tenant) {
    return [
      ...Object.entries(this.config.providerEnv)
        .filter(([key, value]) => value && (key === 'OPENAI_API_KEY' || key === 'OPENAI_BASE_URL'))
        .map(([key, value]) => `${key}=${value}`),
      `TZ=${this.config.timezone}`,
      // ACP TCP bridge (acp-tcp-server.py) listens here; must match the plugin's
      // tcpPort. Bind 0.0.0.0 so the paired OpenClaw container reaches it by DNS.
      `ACP_TCP_PORT=${this.config.hermesAcpPort}`,
      'ACP_TCP_HOST=0.0.0.0',
      ...(this.config.hermesModel ? [`HERMES_DEFAULT_MODEL=${this.config.hermesModel}`] : []),
    ]
  }

  buildHermesCommand() {
    if (!this.config.hermesAcpCmd) return null
    return ['sh', '-lc', this.config.hermesAcpCmd]
  }

  shouldRecreateHermesContainer(info, expectedBinds, expectedEnv, expectedCmd) {
    if (info?.Config?.Labels?.['openclaw.gateway.managed'] !== 'true') return false
    const actualBinds = new Set(info?.HostConfig?.Binds || [])
    const actualEnv = new Set(info?.Config?.Env || [])
    const actualImage = info?.Config?.Image
    return info?.Config?.Labels?.['wattclaw.instance'] !== this.config.instanceId
      || info?.Config?.Labels?.['wattclaw.project-root'] !== this.config.projectRoot
      || actualImage !== this.config.hermesRuntimeImage
      || expectedBinds.some(bind => !actualBinds.has(bind))
      || expectedEnv.some(entry => !actualEnv.has(entry))
      || (expectedCmd ? JSON.stringify(info?.Config?.Cmd || []) !== JSON.stringify(expectedCmd) : false)
  }

  // Ensure the derived runtime image exists. Mirrors how the OpenClaw image is
  // handled during provisioning (so `deploy:test` triggers it), but the base
  // Hermes image only speaks OpenAI/gateway — we wrap it with the ACP TCP bridge
  // (server/hermes-acp/Dockerfile) so openclaw-plugin-hermes can reach it.
  async ensureHermesImage() {
    const runtimeImage = this.config.hermesRuntimeImage
    if (this.hermesImageReady) return
    try {
      await dockerRequest('GET', `/images/${encodeURIComponent(runtimeImage)}/json`)
      this.hermesImageReady = true
      return
    } catch (err) {
      if (err.statusCode !== 404) throw err
    }

    // 1) Ensure the upstream base image is present (pull-on-404).
    await this.ensureHermesBaseImage()

    // 2) Build the derived image (base + ACP TCP bridge) from the baked context.
    console.log(`[Hermes] Building derived image ${runtimeImage} from ${this.config.hermesBaseImage}`)
    const context = createDirTarFlat(this.config.hermesBuildContextDir)
    const buildArgs = encodeURIComponent(JSON.stringify({ HERMES_BASE_IMAGE: this.config.hermesBaseImage }))
    const query = [
      `t=${encodeURIComponent(runtimeImage)}`,
      'dockerfile=Dockerfile',
      `buildargs=${buildArgs}`,
    ].join('&')
    await dockerRequest('POST', `/build?${query}`, context, {
      rawBody: true,
      contentType: 'application/x-tar',
      stream: true,
    })

    // /build returns HTTP 200 even on failure (errors are in the streamed body,
    // which we drain/discard). Confirm the image really exists before caching.
    await dockerRequest('GET', `/images/${encodeURIComponent(runtimeImage)}/json`)
    this.hermesImageReady = true
    console.log(`[Hermes] Built derived image ${runtimeImage}`)
  }

  async ensureHermesBaseImage() {
    try {
      await dockerRequest('GET', `/images/${encodeURIComponent(this.config.hermesBaseImage)}/json`)
      return
    } catch (err) {
      if (err.statusCode !== 404) throw err
    }
    console.log(`[Hermes] Pulling base image ${this.config.hermesBaseImage}`)
    await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(this.config.hermesBaseImage)}`, null, { stream: true })
  }

  buildTenantEnv(tenant) {
    return [
      `OPENCLAW_GATEWAY_TOKEN=${tenant.token}`,
      ...Object.entries(this.config.providerEnv)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}=${value}`),
      `TZ=${this.config.timezone}`,
      'HOME=/home/node',
      'OPENCLAW_HOME=/home/node',
      'GATEWAY_CONFIG_DIR=/home/node/.openclaw',
      'MAX_CONCURRENT_REQUESTS=10',
      'WORKER_THREADS=4',
      'XDG_CONFIG_HOME=/home/node/.config',
      'XDG_CACHE_HOME=/home/node/.cache',
      'XDG_DATA_HOME=/home/node/.local/share',
      'XDG_STATE_HOME=/home/node/.local/state',
      'TMPDIR=/tmp/openclaw',
    ]
  }

  buildTenantCommand() {
    return ['sh', '-lc', [
      'set -eu',
      'umask 022',
      'for dir in /home/node/.openclaw /home/node/.config /home/node/.cache /home/node/.local/share /home/node/.local/state /tmp/openclaw; do [ ! -d "$dir" ] || chmod u+rwx,go+rx "$dir" 2>/dev/null || true; done',
      '[ ! -f /home/node/openclaw.json ] || chmod u+rw,go+r /home/node/openclaw.json 2>/dev/null || true',
      'for plugin_root in /home/node/.openclaw/extensions /home/node/.openclaw/npm/projects; do [ ! -d "$plugin_root" ] || chmod -R u+rwX,go-w "$plugin_root" 2>/dev/null || true; done',
      'node openclaw.mjs config set gateway.controlUi.allowInsecureAuth true',
      'node openclaw.mjs config set gateway.controlUi.dangerouslyDisableDeviceAuth true',
      buildWebSearchSetupCommand(this.config.webSearchSetupScript),
      'exec node openclaw.mjs gateway --allow-unconfigured',
    ].join('\n')]
  }

  buildPortBindings(tenant) {
    return {
      [`${this.config.port}/tcp`]: [{
        HostIp: this.config.hostPortBind,
        HostPort: String(this.resolveTenantPublicPort(tenant.id)),
      }],
    }
  }

  shouldRecreateTenantContainer(info, expectedBinds, expectedEnv, expectedCmd, expectedPortBindings) {
    if (info?.Config?.Labels?.['openclaw.gateway.managed'] !== 'true') return false

    const actualBinds = new Set(info?.HostConfig?.Binds || [])
    const actualEnv = new Set(info?.Config?.Env || [])
    const actualCmd = info?.Config?.Cmd || []
    const actualPortBindings = info?.HostConfig?.PortBindings || {}
    return info?.Config?.Labels?.['wattclaw.instance'] !== this.config.instanceId
      || info?.Config?.Labels?.['wattclaw.project-root'] !== this.config.projectRoot
      || expectedBinds.some(bind => !actualBinds.has(bind))
      || expectedEnv.some(entry => !actualEnv.has(entry))
      || JSON.stringify(actualCmd) !== JSON.stringify(expectedCmd)
      || !portBindingsMatch(actualPortBindings, expectedPortBindings)
  }

  // Install required plugins and approve pending devices, then
  // restart the container at most once. Previously each step restarted the
  // container and waited for health independently, which meant up to three
  // restarts per tenant and made bootstrap very slow.
  async provisionTenantContainer(tenant) {
    const containerName = tenant.containerName
    const pending = this.pluginProvisioning.get(containerName)
    if (pending) return pending

    const run = this._provisionTenantContainer(tenant)
      .finally(() => this.pluginProvisioning.delete(containerName))
    this.pluginProvisioning.set(containerName, run)
    return run
  }

  // 确保租户容器具备 skill 运行所需的系统工具（如 jq）。以 root 执行，
  // 失败不阻断 provision（仅告警），避免装包问题拖垮整个租户启动。
  async ensureTenantSystemTooling(containerName) {
    try {
      await dockerExecShell(
        containerName,
        buildEnsureTenantToolingCommand(),
        this.config.wattclawTeamInstallTimeoutMs,
        { user: '0' },
      )
    } catch (err) {
      console.warn(`[tenant-tooling] Failed to ensure jq for ${containerName}: ${err.message}`)
    }
  }

  async ensureWebSearchProvider(containerName) {
    if (this.webSearchProvidersReady.has(containerName)) return false

    const retryAfter = this.webSearchProviderRetryAfter.get(containerName)
    if (retryAfter && retryAfter > Date.now()) return false

    try {
      await dockerExecOpenClawCli(containerName, ['plugins', 'inspect', 'brave', '--runtime', '--json'], 30_000)
      this.webSearchProvidersReady.add(containerName)
      return false
    } catch {
      try {
        console.log(`[web-search] installing Brave plugin for ${containerName}`)
        await dockerExecOpenClawCli(containerName, ['plugins', 'install', '@openclaw/brave-plugin'], 300_000)
        this.webSearchProvidersReady.add(containerName)
        this.webSearchProviderRetryAfter.delete(containerName)
        return true
      } catch (err) {
        this.webSearchProviderRetryAfter.set(containerName, Date.now() + 300_000)
        console.warn(`[web-search] Failed to install Brave plugin for ${containerName}: ${err.message}`)
        return false
      }
    }
  }

  async _provisionTenantContainer(tenant) {
    const containerName = tenant.containerName
    await this.ensureContainerRunning(containerName)
    await this.ensureTenantSystemTooling(containerName)

    // Ensure the tenant's paired Hermes container exists/runs. Best-effort:
    // a Hermes failure must not block OpenClaw tenant provisioning.
    try {
      await this.ensureHermesContainer(tenant)
    } catch (err) {
      console.warn(`[Hermes] ensureHermesContainer failed for ${tenant.id}: ${err.message}`)
    }

    let webSearchChanged = false
    if (this.config.webSearchEnabled && this.config.webSearchProvider === 'brave') {
      webSearchChanged = await this.ensureWebSearchProvider(containerName)
    }

    const [larkPlan, teamPlan, promptCapturePlan, hermesPlan] = await Promise.all([
      this.planLarkInstall(containerName),
      this.planWattclawTeamInstall(containerName),
      this.planPromptCaptureInstall(containerName),
      this.planHermesPluginInstall(containerName),
    ])

    if (larkPlan.shouldInstall || teamPlan.shouldInstall || promptCapturePlan.shouldInstall || hermesPlan.shouldInstall) {
      await this.waitForContainerHealthy(containerName, this.config.containerHealthTimeoutMs)
    }

    let changed = webSearchChanged
    let larkApplied = false
    let teamApplied = false
    let promptCaptureApplied = false
    let hermesApplied = false

    if (larkPlan.shouldInstall) {
      try {
        this.validateLarkPatchFiles()
        await dockerExecShell(containerName, buildLarkInstallCommand(this.config.larkPackage), this.config.larkInstallTimeoutMs)
        await putDockerArchive(containerName, '/tmp', createLarkPatchTar(this.config.larkPatchDir))
        await dockerExecShell(containerName, buildLarkPatchCommand(this.config.larkDistTarget), this.config.larkInstallTimeoutMs)
        larkApplied = true
        changed = true
      } catch (err) {
        this.larkRetryAfter.set(containerName, {
          sourceHash: larkPlan.sourceState.sourceHash,
          until: Date.now() + this.config.larkRetryCooldownMs,
        })
        const message = `[LarkPlugin] Failed to install/patch Feishu plugin for ${containerName}: ${err.message}`
        if (this.config.larkFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (teamPlan.shouldInstall) {
      try {
        await putDockerArchive(containerName, '/tmp', createDirTar(this.config.wattclawTeamPluginDir, 'wattclaw-team'))
        await dockerExecShell(containerName, buildWattclawTeamInstallCommand(), this.config.wattclawTeamInstallTimeoutMs)
        teamApplied = true
        changed = true
      } catch (err) {
        this.wattclawTeamRetryAfter.set(containerName, {
          sourceHash: teamPlan.sourceState.sourceHash,
          until: Date.now() + this.config.wattclawTeamRetryCooldownMs,
        })
        const message = `[WattClawTeam] Failed to install WattClaw Team plugin for ${containerName}: ${err.message}`
        if (this.config.wattclawTeamFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (promptCapturePlan.shouldInstall) {
      try {
        await putDockerArchive(containerName, '/tmp', createDirTar(this.config.promptCapturePluginDir, 'wattclaw-prompt-capture'))
        await dockerExecShell(containerName, buildPromptCaptureInstallCommand(), this.config.promptCaptureInstallTimeoutMs)
        promptCaptureApplied = true
        changed = true
      } catch (err) {
        this.promptCaptureRetryAfter.set(containerName, {
          sourceHash: promptCapturePlan.sourceState.sourceHash,
          until: Date.now() + this.config.promptCaptureRetryCooldownMs,
        })
        const message = `[PromptCapture] Failed to install WattClaw Prompt Capture plugin for ${containerName}: ${err.message}`
        if (this.config.promptCaptureFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (hermesPlan.shouldInstall) {
      try {
        await putDockerArchive(containerName, '/tmp', createDirTar(this.config.hermesPluginDir, 'openclaw-plugin-hermes'))
        await dockerExecShell(containerName, buildHermesPluginInstallCommand(), this.config.hermesPluginInstallTimeoutMs)
        hermesApplied = true
        changed = true
      } catch (err) {
        this.hermesPluginRetryAfter.set(containerName, {
          sourceHash: hermesPlan.sourceState.sourceHash,
          until: Date.now() + this.config.hermesPluginRetryCooldownMs,
        })
        const message = `[Hermes] Failed to install Hermes plugin for ${containerName}: ${err.message}`
        if (this.config.hermesPluginFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (this.approvePendingBackendDevice(tenant.id)) changed = true

    if (changed) {
      await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/restart`, null, { allow204: true })
      await this.waitForContainerHealthy(containerName, this.config.containerHealthTimeoutMs)
    }

    if (larkApplied) {
      // The install marker must be written after the restart so it reflects a
      // container that actually loaded the new plugin.
      try {
        await dockerExecShell(containerName, buildLarkInstallMarkerCommand(larkPlan.sourceState), this.config.larkInstallTimeoutMs)
        this.larkPatched.set(containerName, larkPlan.sourceState.sourceHash)
        this.larkRetryAfter.delete(containerName)
        console.log(`[LarkPlugin] Installed/patched Feishu plugin for ${containerName}`)
      } catch (err) {
        this.larkRetryAfter.set(containerName, {
          sourceHash: larkPlan.sourceState.sourceHash,
          until: Date.now() + this.config.larkRetryCooldownMs,
        })
        const message = `[LarkPlugin] Failed to record Feishu plugin marker for ${containerName}: ${err.message}`
        if (this.config.larkFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (teamApplied) {
      // The install marker must be written after the restart so it reflects a
      // container that actually loaded the new plugin.
      try {
        await dockerExecShell(containerName, buildWattclawTeamInstallMarkerCommand(teamPlan.sourceState), this.config.wattclawTeamInstallTimeoutMs)
        this.wattclawTeamInstalled.set(containerName, teamPlan.sourceState.sourceHash)
        this.wattclawTeamRetryAfter.delete(containerName)
        console.log(`[WattClawTeam] Installed WattClaw Team plugin for ${containerName}`)
      } catch (err) {
        this.wattclawTeamRetryAfter.set(containerName, {
          sourceHash: teamPlan.sourceState.sourceHash,
          until: Date.now() + this.config.wattclawTeamRetryCooldownMs,
        })
        const message = `[WattClawTeam] Failed to record WattClaw Team plugin marker for ${containerName}: ${err.message}`
        if (this.config.wattclawTeamFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (promptCaptureApplied) {
      // The install marker must be written after the restart so it reflects a
      // container that actually loaded the new plugin.
      try {
        await dockerExecShell(containerName, buildPromptCaptureInstallMarkerCommand(promptCapturePlan.sourceState), this.config.promptCaptureInstallTimeoutMs)
        this.promptCaptureInstalled.set(containerName, promptCapturePlan.sourceState.sourceHash)
        this.promptCaptureRetryAfter.delete(containerName)
        console.log(`[PromptCapture] Installed WattClaw Prompt Capture plugin for ${containerName}`)
      } catch (err) {
        this.promptCaptureRetryAfter.set(containerName, {
          sourceHash: promptCapturePlan.sourceState.sourceHash,
          until: Date.now() + this.config.promptCaptureRetryCooldownMs,
        })
        const message = `[PromptCapture] Failed to record WattClaw Prompt Capture plugin marker for ${containerName}: ${err.message}`
        if (this.config.promptCaptureFailOnError) throw new Error(message)
        console.warn(message)
      }
    }

    if (hermesApplied) {
      try {
        await dockerExecShell(containerName, buildHermesPluginInstallMarkerCommand(hermesPlan.sourceState), this.config.hermesPluginInstallTimeoutMs)
        this.hermesPluginInstalled.set(containerName, hermesPlan.sourceState.sourceHash)
        this.hermesPluginRetryAfter.delete(containerName)
        console.log(`[Hermes] Installed Hermes plugin for ${containerName}`)
      } catch (err) {
        this.hermesPluginRetryAfter.set(containerName, {
          sourceHash: hermesPlan.sourceState.sourceHash,
          until: Date.now() + this.config.hermesPluginRetryCooldownMs,
        })
        const message = `[Hermes] Failed to record Hermes plugin marker for ${containerName}: ${err.message}`
        if (this.config.hermesPluginFailOnError) throw new Error(message)
        console.warn(message)
      }
    }
  }

  async planHermesPluginInstall(containerName) {
    if (!this.config.hermesPluginAutoInstall) return { shouldInstall: false }
    if (!this.config.hermesEnabled) return { shouldInstall: false }

    let sourceState
    try {
      sourceState = this.getHermesPluginSourceState()
    } catch (err) {
      const message = `[Hermes] Failed to read plugin source for ${containerName}: ${err.message}`
      if (this.config.hermesPluginFailOnError) throw new Error(message)
      console.warn(message)
      return { shouldInstall: false }
    }

    if (this.hermesPluginInstalled.get(containerName) === sourceState.sourceHash) return { shouldInstall: false }

    const retryAfter = this.hermesPluginRetryAfter.get(containerName)
    if (retryAfter?.sourceHash === sourceState.sourceHash && retryAfter.until > Date.now()) return { shouldInstall: false }

    try {
      const installedState = await this.readHermesPluginInstallState(containerName)
      if (installedState?.sourceHash === sourceState.sourceHash) {
        this.hermesPluginInstalled.set(containerName, sourceState.sourceHash)
        console.log(`[Hermes] Plugin already up to date for ${containerName}`)
        return { shouldInstall: false }
      }
    } catch {
      // Ignore read failures and fall through to install.
    }

    return { shouldInstall: true, sourceState }
  }

  getHermesPluginSourceState() {
    if (this.hermesPluginSourceState) return this.hermesPluginSourceState
    this.validateHermesPluginDir()
    const packageInfo = readJsonObject(path.join(this.config.hermesPluginDir, 'package.json'))
    this.hermesPluginSourceState = {
      sourceHash: hashDirectory(this.config.hermesPluginDir),
      pluginVersion: typeof packageInfo.version === 'string' ? packageInfo.version : '',
    }
    return this.hermesPluginSourceState
  }

  async readHermesPluginInstallState(containerName) {
    const output = await dockerExecShellWithOutput(containerName, buildHermesPluginInstallStateReadCommand(), this.config.hermesPluginInstallTimeoutMs)
    const raw = String(output || '').trim()
    if (!raw) return null
    try {
      const state = JSON.parse(raw)
      return state && typeof state === 'object' && !Array.isArray(state) ? state : null
    } catch {
      return null
    }
  }

  validateHermesPluginDir() {
    const dir = this.config.hermesPluginDir
    for (const file of ['openclaw.plugin.json', 'package.json']) {
      if (!existsSync(path.join(dir, file))) {
        throw new Error(`plugin file not found: ${path.join(dir, file)}`)
      }
    }
  }

  async planLarkInstall(containerName) {
    if (!this.config.larkAutoInstall) return { shouldInstall: false }

    let sourceState
    try {
      sourceState = this.getLarkSourceState()
    } catch (err) {
      const message = `[LarkPlugin] Failed to read plugin patch source for ${containerName}: ${err.message}`
      if (this.config.larkFailOnError) throw new Error(message)
      console.warn(message)
      return { shouldInstall: false }
    }

    if (this.larkPatched.get(containerName) === sourceState.sourceHash) return { shouldInstall: false }

    const retryAfter = this.larkRetryAfter.get(containerName)
    if (retryAfter?.sourceHash === sourceState.sourceHash && retryAfter.until > Date.now()) return { shouldInstall: false }

    // The container may already carry the current plugin + patches (e.g. after
    // a process restart with no config change). Confirm against the in-container
    // marker before deciding to reinstall, so a host reboot does not force a
    // redundant tenant restart for every tenant.
    try {
      const installedState = await this.readLarkInstallState(containerName)
      if (installedState?.sourceHash === sourceState.sourceHash) {
        this.larkPatched.set(containerName, sourceState.sourceHash)
        console.log(`[LarkPlugin] Plugin already up to date for ${containerName}`)
        return { shouldInstall: false }
      }
    } catch {
      // Ignore read failures and fall through to install.
    }

    return { shouldInstall: true, sourceState }
  }

  getLarkSourceState() {
    if (this.larkSourceState) return this.larkSourceState

    this.validateLarkPatchFiles()
    const hash = createHash('sha256')
    hash.update(`package:${this.config.larkPackage}\n`)
    for (const file of [...larkPluginPatchFiles, 'monitor-Bog7UNtj.js']) {
      const body = readFileSync(path.join(this.config.larkPatchDir, file))
      hash.update(`file:${file}:${body.length}\n`)
      hash.update(body)
    }
    this.larkSourceState = { sourceHash: hash.digest('hex') }
    return this.larkSourceState
  }

  async readLarkInstallState(containerName) {
    const output = await dockerExecShellWithOutput(containerName, buildLarkInstallStateReadCommand(), this.config.larkInstallTimeoutMs)
    const raw = String(output || '').trim()
    if (!raw) return null
    try {
      const state = JSON.parse(raw)
      return state && typeof state === 'object' && !Array.isArray(state) ? state : null
    } catch {
      return null
    }
  }

  async planWattclawTeamInstall(containerName) {
    if (!this.config.wattclawTeamAutoInstall) return { shouldInstall: false }

    let sourceState
    try {
      sourceState = this.getWattclawTeamSourceState()
    } catch (err) {
      const message = `[WattClawTeam] Failed to read plugin source for ${containerName}: ${err.message}`
      if (this.config.wattclawTeamFailOnError) throw new Error(message)
      console.warn(message)
      return { shouldInstall: false }
    }

    if (this.wattclawTeamInstalled.get(containerName) === sourceState.sourceHash) return { shouldInstall: false }

    const retryAfter = this.wattclawTeamRetryAfter.get(containerName)
    if (retryAfter?.sourceHash === sourceState.sourceHash && retryAfter.until > Date.now()) return { shouldInstall: false }

    // The container may already carry the current plugin (e.g. after a process
    // restart with no config change). Confirm against the in-container marker
    // before deciding to reinstall.
    try {
      const installedState = await this.readWattclawTeamInstallState(containerName)
      if (installedState?.sourceHash === sourceState.sourceHash) {
        this.wattclawTeamInstalled.set(containerName, sourceState.sourceHash)
        console.log(`[WattClawTeam] Plugin already up to date for ${containerName}`)
        return { shouldInstall: false }
      }
    } catch {
      // Ignore read failures and fall through to install.
    }

    return { shouldInstall: true, sourceState }
  }

  validateLarkPatchFiles() {
    for (const file of [...larkPluginPatchFiles, 'monitor-Bog7UNtj.js']) {
      const sourcePath = path.join(this.config.larkPatchDir, file)
      if (!existsSync(sourcePath)) {
        throw new Error(`patch file not found: ${sourcePath}`)
      }
    }
  }

  getWattclawTeamSourceState() {
    if (this.wattclawTeamSourceState) return this.wattclawTeamSourceState

    this.validateWattclawTeamPluginDir()
    const packageInfo = readJsonObject(path.join(this.config.wattclawTeamPluginDir, 'package.json'))
    this.wattclawTeamSourceState = {
      sourceHash: hashDirectory(this.config.wattclawTeamPluginDir),
      pluginVersion: typeof packageInfo.version === 'string' ? packageInfo.version : '',
    }
    return this.wattclawTeamSourceState
  }

  async readWattclawTeamInstallState(containerName) {
    const output = await dockerExecShellWithOutput(containerName, buildWattclawTeamInstallStateReadCommand(), this.config.wattclawTeamInstallTimeoutMs)
    const raw = String(output || '').trim()
    if (!raw) return null
    try {
      const state = JSON.parse(raw)
      return state && typeof state === 'object' && !Array.isArray(state) ? state : null
    } catch {
      return null
    }
  }

  validateWattclawTeamPluginDir() {
    const dir = this.config.wattclawTeamPluginDir
    for (const file of ['openclaw.plugin.json', 'dist/index.js']) {
      if (!existsSync(path.join(dir, file))) {
        throw new Error(`plugin file not found: ${path.join(dir, file)}`)
      }
    }
  }

  async planPromptCaptureInstall(containerName) {
    if (!this.config.promptCaptureAutoInstall) return { shouldInstall: false }

    let sourceState
    try {
      sourceState = this.getPromptCaptureSourceState()
    } catch (err) {
      const message = `[PromptCapture] Failed to read plugin source for ${containerName}: ${err.message}`
      if (this.config.promptCaptureFailOnError) throw new Error(message)
      console.warn(message)
      return { shouldInstall: false }
    }

    if (this.promptCaptureInstalled.get(containerName) === sourceState.sourceHash) return { shouldInstall: false }

    const retryAfter = this.promptCaptureRetryAfter.get(containerName)
    if (retryAfter?.sourceHash === sourceState.sourceHash && retryAfter.until > Date.now()) return { shouldInstall: false }

    // The container may already carry the current plugin (e.g. after a process
    // restart with no config change). Confirm against the in-container marker
    // and the compiled native dependency before deciding to reinstall.
    try {
      const installedState = await this.readPromptCaptureInstallState(containerName)
      if (installedState?.sourceHash === sourceState.sourceHash) {
        this.promptCaptureInstalled.set(containerName, sourceState.sourceHash)
        console.log(`[PromptCapture] Plugin already up to date for ${containerName}`)
        return { shouldInstall: false }
      }
    } catch {
      // Ignore read failures and fall through to install.
    }

    return { shouldInstall: true, sourceState }
  }

  getPromptCaptureSourceState() {
    if (this.promptCaptureSourceState) return this.promptCaptureSourceState

    this.validatePromptCapturePluginDir()
    const packageInfo = readJsonObject(path.join(this.config.promptCapturePluginDir, 'package.json'))
    this.promptCaptureSourceState = {
      sourceHash: hashDirectory(this.config.promptCapturePluginDir),
      pluginVersion: typeof packageInfo.version === 'string' ? packageInfo.version : '',
    }
    return this.promptCaptureSourceState
  }

  async readPromptCaptureInstallState(containerName) {
    const output = await dockerExecShellWithOutput(containerName, buildPromptCaptureInstallStateReadCommand(), this.config.promptCaptureInstallTimeoutMs)
    const raw = String(output || '').trim()
    if (!raw) return null
    try {
      const state = JSON.parse(raw)
      return state && typeof state === 'object' && !Array.isArray(state) ? state : null
    } catch {
      return null
    }
  }

  validatePromptCapturePluginDir() {
    const dir = this.config.promptCapturePluginDir
    for (const file of ['openclaw.plugin.json', 'index.js', 'package.json']) {
      if (!existsSync(path.join(dir, file))) {
        throw new Error(`plugin file not found: ${path.join(dir, file)}`)
      }
    }
  }

  async ensureContainerRunning(containerName) {
    const info = await dockerRequest('GET', `/containers/${encodeURIComponent(containerName)}/json`)
    if (!info?.State?.Running) {
      console.log(`[MultiTenant] Starting ${containerName}`)
      await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/start`, null, { allow304: true })
    }
  }

  async waitForContainerHealthy(containerName, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastState = 'unknown'

    while (Date.now() < deadline) {
      const info = await dockerRequest('GET', `/containers/${encodeURIComponent(containerName)}/json`)
      const running = Boolean(info?.State?.Running)
      const health = info?.State?.Health?.Status || 'none'
      lastState = `${info?.State?.Status || 'unknown'}/${health}`
      if (running && (health === 'healthy' || health === 'none')) return
      if (!running && ['dead', 'exited'].includes(info?.State?.Status)) {
        throw new Error(`${containerName} stopped while waiting for health (${lastState})`)
      }
      await delay(2_000)
    }

    throw new Error(`${containerName} did not become healthy within ${Math.round(timeoutMs / 1000)}s (${lastState})`)
  }

  approvePendingBackendDevice(tenantRef) {
    const tenant = typeof tenantRef === 'string'
      ? normalizeTenant(db.prepare('SELECT * FROM openclaw_tenants WHERE id = ?').get(tenantRef)) || { id: tenantRef, dataSource: this.resolveTenantDataSource(tenantRef) }
      : tenantRef
    const tenantDir = this.resolveTenantDataDirForApproval(tenant)
    if (!tenantDir) {
      trace('approve skipped no tenant dir', {
        tenantId: tenant?.id,
        dataSource: tenant?.dataSource,
      })
      return false
    }

    const devicesDir = path.join(tenantDir, 'devices')
    const pendingPath = path.join(devicesDir, 'pending.json')
    const pairedPath = path.join(devicesDir, 'paired.json')

    const pending = readJsonObject(pendingPath)
    const paired = readJsonObject(pairedPath)
    let approved = false
    const now = Date.now()
    const identity = loadWebBackendDeviceIdentity()

    trace('approve inspect files', {
      tenantId: tenant.id,
      tenantDir,
      devicesDirExists: existsSync(devicesDir),
      pendingExists: existsSync(pendingPath),
      pairedExists: existsSync(pairedPath),
      pendingCount: Object.keys(pending).length,
      pairedCount: Object.keys(paired).length,
      webDeviceId: identity?.deviceId,
      webDevicePaired: identity?.deviceId ? Boolean(paired[identity.deviceId]) : false,
    })

    for (const [requestId, request] of Object.entries(pending)) {
      if (!isManagedBackendDeviceRequest(request)) {
        trace('approve pending ignored', {
          tenantId: tenant.id,
          requestId,
          displayName: request?.displayName,
          clientId: request?.clientId,
          clientMode: request?.clientMode,
          role: request?.role,
          scopes: Array.isArray(request?.scopes) ? request.scopes : [],
        })
        continue
      }
      trace('approve pending backend request', {
        tenantId: tenant.id,
        requestId,
        deviceId: request.deviceId,
      })
      paired[request.deviceId] = {
        deviceId: request.deviceId,
        publicKey: request.publicKey,
        platform: request.platform || 'linux',
        clientId: request.clientId || 'cli',
        clientMode: request.clientMode || 'cli',
        role: 'operator',
        roles: ['operator'],
        scopes: ['operator.admin'],
        approvedScopes: ['operator.admin'],
        tokens: {
          operator: {
            token: randomBytes(32).toString('hex'),
            role: 'operator',
            scopes: ['operator.admin', 'operator.read', 'operator.write'],
            createdAtMs: now,
          },
        },
        createdAtMs: request.ts || now,
        approvedAtMs: now,
      }
      delete pending[requestId]
      approved = true
    }

    if (!approved) {
      if (!identity) {
        trace('approve skipped no web identity', { tenantId: tenant.id })
        return false
      }
      const existing = paired[identity.deviceId]
      const next = buildApprovedBackendDevice(identity, existing, now)
      if (JSON.stringify(existing || null) === JSON.stringify(next)) {
        trace('approve no changes needed', {
          tenantId: tenant.id,
          deviceId: identity.deviceId,
        })
        return false
      }
      paired[identity.deviceId] = next
      approved = true
    }

    if (!approved) return false
    writeJsonObject(pairedPath, paired)
    writeJsonObject(pendingPath, pending)
    console.log(`[MultiTenant] Auto-approved OpenClaw Web Backend device for ${tenant.id}`)
    return true
  }

  resolveTenantDataDirForApproval(tenant) {
    if (!tenant?.id) return null

    const dataSource = tenant.dataSource || this.resolveTenantDataSource(tenant.id)
    const candidates = []

    if (dataSource && isHostPathDataSource(dataSource)) {
      const hostRoot = this.config.hostDataDir ? path.resolve(this.config.hostDataDir) : ''
      const containerRoot = this.config.containerDataDir ? path.resolve(this.config.containerDataDir) : ''
      const sourcePath = path.resolve(dataSource)

      if (hostRoot && containerRoot && (sourcePath === hostRoot || sourcePath.startsWith(`${hostRoot}${path.sep}`))) {
        candidates.push(path.resolve(containerRoot, path.relative(hostRoot, sourcePath)))
      }
      candidates.push(sourcePath)
    }

    if (this.config.containerDataDir) {
      const root = path.resolve(this.config.containerDataDir)
      const tenantDir = path.resolve(root, tenant.id)
      if (tenantDir.startsWith(`${root}${path.sep}`)) candidates.push(tenantDir)
    }

    const selected = candidates.find(candidate => existsSync(candidate)) || candidates.find(Boolean) || null
    trace('approve dir candidates', {
      tenantId: tenant.id,
      dataSource,
      candidates,
      selected,
      selectedExists: selected ? existsSync(selected) : false,
    })
    return selected
  }

  async ensureImage() {
    try {
      await dockerRequest('GET', `/images/${encodeURIComponent(this.config.image)}/json`)
      return
    } catch (err) {
      if (err.statusCode !== 404) throw err
    }
    if (!this.imagePulling) {
      console.log(`[MultiTenant] Pulling OpenClaw image ${this.config.image}`)
      this.imagePulling = dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(this.config.image)}`, null, { stream: true })
        .finally(() => { this.imagePulling = null })
    }
    await this.imagePulling
  }

  prepareTenantDataDir(id) {
    if (!this.config.containerDataDir) return

    const root = path.resolve(this.config.containerDataDir)
    const tenantDir = path.resolve(root, id)
    if (!tenantDir.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Invalid tenant data directory: ${tenantDir}`)
    }

    const legacyMap = new Map([['tenant-1', 'tenant-a'], ['tenant-2', 'tenant-b']])
    const legacyId = legacyMap.get(id)
    if (legacyId) {
      const legacyDir = path.resolve(root, legacyId)
      if (legacyDir.startsWith(`${root}${path.sep}`) && existsSync(legacyDir) && !existsSync(tenantDir)) {
        renameSync(legacyDir, tenantDir)
      }
    }

    mkdirSync(tenantDir, { recursive: true })
    prepareOwnedPath(tenantDir, 0o755, this.config.runtimeUid, this.config.runtimeGid)
    this.prepareDevicePairingDir(tenantDir)
    for (const mount of extraPersistentMounts) {
      const sourcePath = path.resolve(tenantDir, mount.relativePath)
      if (!sourcePath.startsWith(`${tenantDir}${path.sep}`)) {
        throw new Error(`Invalid OpenClaw persistent path: ${sourcePath}`)
      }
      if (mount.type === 'file') {
        mkdirSync(path.dirname(sourcePath), { recursive: true })
        if (!existsSync(sourcePath)) writeFileSync(sourcePath, mount.defaultContent || '')
      } else {
        mkdirSync(sourcePath, { recursive: true })
      }
      prepareOwnedPath(sourcePath, mount.type === 'file' ? 0o644 : 0o755, this.config.runtimeUid, this.config.runtimeGid)
    }
  }

  prepareDevicePairingDir(tenantDir) {
    const devicesDir = path.join(tenantDir, 'devices')
    mkdirSync(devicesDir, { recursive: true })
    prepareOwnedPath(devicesDir, 0o700, this.config.runtimeUid, this.config.runtimeGid)

    for (const file of ['pending.json', 'paired.json']) {
      const filePath = path.join(devicesDir, file)
      if (!existsSync(filePath)) writeJsonObject(filePath, {})
      prepareOwnedPath(filePath, 0o600, this.config.runtimeUid, this.config.runtimeGid)
    }
  }

  buildBinds(dataSource) {
    const binds = [
      `${dataSource}:/home/node/.openclaw`,
      `${dataSource}:/home/wattman/.openclaw`,
    ]
    if (isHostPathDataSource(dataSource)) {
      for (const mount of extraPersistentMounts) {
        binds.push(`${joinDockerHostPath(dataSource, mount.relativePath)}:${mount.containerPath}`)
      }
    }
    if (this.config.wattclawHostDir && this.config.wattclawContainerDir) {
      binds.push(`${this.config.wattclawHostDir}:${this.config.wattclawContainerDir}`)
    }
    if (this.config.agentsShareHostDir && this.config.agentsShareContainerDir) {
      binds.push(`${this.config.agentsShareHostDir}:${this.config.agentsShareContainerDir}`)
    }
    // Only projections are shared with OpenClaw; the Hermes data root contains
    // tenant credentials and remains private to the Hermes container.
    if (this.config.hermesEnabled && this.config.hermesBaseImage && isHostPathDataSource(dataSource)) {
      const execEnvHostDir = joinDockerHostPath(this.hermesSharedHostDir(dataSource), 'execenv')
      const execEnvContainerDir = path.posix.join(this.config.hermesDataDir, 'execenv')
      const skillsHostDir = joinDockerHostPath(this.hermesSharedHostDir(dataSource), 'skills')
      const skillsContainerDir = path.posix.join(this.config.hermesDataDir, 'skills')
      binds.push(`${execEnvHostDir}:${execEnvContainerDir}`)
      binds.push(`${skillsHostDir}:${skillsContainerDir}:ro`)
    }
    return binds
  }

  prepareSharedWattclawDir() {
    if (!this.config.wattclawHostDir) return
    if (!isHostPathDataSource(this.config.wattclawHostDir)) return

    try {
      mkdirSync(this.config.wattclawHostDir, { recursive: true })
      prepareOwnedPath(this.config.wattclawHostDir, 0o755, this.config.runtimeUid, this.config.runtimeGid)
    } catch (err) {
      console.warn(`[MultiTenant] Failed to prepare shared WattClaw dir ${this.config.wattclawHostDir}: ${err.message}`)
    }
  }

  prepareSharedAgentsDir() {
    if (!this.config.agentsShareHostDir) return
    if (!isHostPathDataSource(this.config.agentsShareHostDir)) return

    try {
      mkdirSync(this.config.agentsShareHostDir, { recursive: true })
      prepareOwnedPath(this.config.agentsShareHostDir, 0o755, this.config.runtimeUid, this.config.runtimeGid)
    } catch (err) {
      console.warn(`[MultiTenant] Failed to prepare shared OpenClaw agents dir ${this.config.agentsShareHostDir}: ${err.message}`)
    }
  }
}

function resolveConfig(envConfig) {
  const maxUsers = positiveInt(envConfig.OPENCLAW_MAX_USERS, 20)
  const initialTenants = positiveInt(envConfig.OPENCLAW_INITIAL_TENANTS, 1)
  const maxTenants = positiveInt(envConfig.OPENCLAW_MAX_TENANTS, 100)
  const tokenPrefix = envConfig.OPENCLAW_TOKEN_PREFIX || 'openclaw-token'
  const configuredCpuSets = String(envConfig.OPENCLAW_CPUSETS || '').split(';').map(v => v.trim()).filter(Boolean)
  const instanceId = envConfig.INSTANCE_ID || 'test'
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))

  return {
    instanceId,
    projectRoot: envConfig.PROJECT_ROOT || '',
    image: envConfig.OPENCLAW_IMAGE || DEFAULT_OPENCLAW_IMAGE,
    network: envConfig.OPENCLAW_NETWORK || 'multi-openclaw-net',
    containerPrefix: envConfig.OPENCLAW_CONTAINER_PREFIX || 'openclaw-tenant',
    port: positiveInt(envConfig.OPENCLAW_PORT, 18789),
    hostPortBase: positiveInt(envConfig.OPENCLAW_HOST_PORT_BASE, 19789),
    hostPortBind: envConfig.OPENCLAW_HOST_PORT_BIND || '0.0.0.0',
    containerMemoryMb: positiveInt(envConfig.OPENCLAW_CONTAINER_MEMORY_MB, 8192),
    containerCpus: positiveNumber(envConfig.OPENCLAW_CONTAINER_CPUS, 4),
    runtimeUid: positiveInt(envConfig.OPENCLAW_RUNTIME_UID, 1000),
    runtimeGid: positiveInt(envConfig.OPENCLAW_RUNTIME_GID, 1000),
    timezone: envConfig.OPENCLAW_TIMEZONE || envConfig.TZ || 'Asia/Shanghai',
    publicProtocol: envConfig.OPENCLAW_PUBLIC_PROTOCOL || 'http',
    publicHost: envConfig.OPENCLAW_PUBLIC_HOST || '',
    wsPath: envConfig.OPENCLAW_WS_PATH || '',
    maxUsers,
    initialTenants,
    maxTenants,
    tokenPrefix,
    dataVolumePrefix: envConfig.OPENCLAW_DATA_VOLUME_PREFIX || 'openclaw-data',
    hostDataDir: envConfig.OPENCLAW_HOST_DATA_DIR || '',
    containerDataDir: envConfig.OPENCLAW_CONTAINER_DATA_DIR || '',
    wattclawHostDir: envConfig.OPENCLAW_WATTCLAW_HOST_DIR || '/home/wattman/.wattclaw',
    wattclawContainerDir: envConfig.OPENCLAW_WATTCLAW_CONTAINER_DIR || '/home/wattman/.wattclaw',
    agentsShareHostDir: envConfig.OPENCLAW_AGENTS_SHARE_HOST_DIR || '/home/wattman/.openclaw/agents',
    agentsShareContainerDir: envConfig.OPENCLAW_AGENTS_SHARE_CONTAINER_DIR || '/home/node/.openclaw/agents',
    manageContainers: envConfig.OPENCLAW_MANAGE_CONTAINERS !== 'false',
    connectTimeoutMs: positiveInt(envConfig.OPENCLAW_CONNECT_TIMEOUT_MS, 60_000),
    hermesEnabled: envConfig.OPENCLAW_HERMES_ENABLED !== 'false',
    hermesMode: envConfig.OPENCLAW_HERMES_MODE || 'dedicated',
    // Upstream base image to wrap (pulled). Empty → skip Hermes entirely.
    hermesBaseImage: envConfig.HERMES_IMAGE || '',
    // Derived image the Hermes container actually runs. Built by the backend
    // from server/hermes-acp/Dockerfile (base + ACP TCP bridge). Instance-scoped
    // so parallel deployments on one host don't clash.
    hermesRuntimeImage: envConfig.HERMES_RUNTIME_IMAGE
      || (envConfig.HERMES_IMAGE ? `wattclaw-hermes-acp-${instanceId}:latest` : ''),
    // Docker build context (baked into the app image under server/hermes-acp).
    // moduleDir is server/core, so the context lives one level up in server/.
    hermesBuildContextDir: envConfig.OPENCLAW_HERMES_BUILD_CONTEXT_DIR
      || path.join(moduleDir, '..', 'hermes-acp'),
    hermesContainerPrefix: envConfig.OPENCLAW_HERMES_CONTAINER_PREFIX
      || (envConfig.OPENCLAW_CONTAINER_PREFIX || 'openclaw-tenant').replace(/openclaw/gi, 'hermes'),
    hermesAcpPort: positiveInt(envConfig.OPENCLAW_HERMES_ACP_PORT, 3100),
    hermesModel: envConfig.HERMES_DEFAULT_MODEL || '',
    // Path inside the OpenClaw container where the shared Hermes projection
    // directory is bind-mounted. Must equal the plugin's `hermesDataDir` so the
    // execenv-builder免-exec 捷径 (hostExecEnvPath under hermesDataDir ↔
    // /opt/data/execenv inside Hermes) is hit.
    hermesDataDir: envConfig.OPENCLAW_HERMES_DATA_DIR || '/home/node/hermes-data',
    hermesContainerMemoryMb: positiveInt(envConfig.OPENCLAW_HERMES_CONTAINER_MEMORY_MB, 4096),
    hermesContainerCpus: positiveNumber(envConfig.OPENCLAW_HERMES_CONTAINER_CPUS, 2),
    hermesAcpCmd: envConfig.HERMES_ACP_CMD || '',
    hermesPluginDir: envConfig.OPENCLAW_HERMES_PLUGIN_DIR || '/app/plugins/openclaw-plugin-hermes',
    hermesPluginAutoInstall: envConfig.OPENCLAW_HERMES_PLUGIN_AUTO_INSTALL !== 'false',
    hermesPluginFailOnError: envConfig.OPENCLAW_HERMES_PLUGIN_FAIL_ON_ERROR === 'true',
    hermesPluginInstallTimeoutMs: positiveInt(envConfig.OPENCLAW_HERMES_PLUGIN_INSTALL_TIMEOUT_MS, 600_000),
    hermesPluginRetryCooldownMs: positiveInt(envConfig.OPENCLAW_HERMES_PLUGIN_RETRY_COOLDOWN_MS, 300_000),
    providerEnv: {
      OPENAI_API_KEY: envConfig.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
      OPENAI_BASE_URL: envConfig.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'http://one-api.wattman.cn:805/v1',
      BRAVE_API_KEY: envConfig.BRAVE_API_KEY || process.env.BRAVE_API_KEY || '',
      OPENCLAW_WEB_SEARCH_PROVIDER: envConfig.OPENCLAW_WEB_SEARCH_PROVIDER || '',
      OPENCLAW_WEB_SEARCH_ENABLED: envConfig.OPENCLAW_WEB_SEARCH_ENABLED || '',
      OPENCLAW_WEB_SEARCH_MAX_RESULTS: envConfig.OPENCLAW_WEB_SEARCH_MAX_RESULTS || '',
    },
    webSearchProvider: resolveWebSearchProvider(envConfig),
    webSearchEnabled: resolveWebSearchEnabled(envConfig),
    webSearchSetupScript: loadWebSearchSetupScript(),
    larkAutoInstall: envConfig.OPENCLAW_LARK_AUTO_INSTALL !== 'false',
    larkFailOnError: envConfig.OPENCLAW_LARK_FAIL_ON_ERROR === 'true',
    larkPackage: envConfig.OPENCLAW_LARK_PACKAGE || '@larksuite/openclaw-lark',
    larkPatchDir: envConfig.OPENCLAW_LARK_PATCH_DIR || '/app/openclaw-lark-patches',
    larkDistTarget: envConfig.OPENCLAW_DIST_MONITOR_TARGET || '/home/node/.npm-global/lib/node_modules/openclaw/dist/monitor-Bog7UNtj.js',
    larkInstallTimeoutMs: positiveInt(envConfig.OPENCLAW_LARK_INSTALL_TIMEOUT_MS, 300_000),
    larkRetryCooldownMs: positiveInt(envConfig.OPENCLAW_LARK_RETRY_COOLDOWN_MS, 300_000),
    wattclawTeamAutoInstall: envConfig.OPENCLAW_WATTCLAW_TEAM_AUTO_INSTALL !== 'false',
    wattclawTeamFailOnError: envConfig.OPENCLAW_WATTCLAW_TEAM_FAIL_ON_ERROR === 'true',
    wattclawTeamPluginDir: envConfig.OPENCLAW_WATTCLAW_TEAM_PLUGIN_DIR || '/app/plugins/wattclaw-team',
    wattclawTeamInstallTimeoutMs: positiveInt(envConfig.OPENCLAW_WATTCLAW_TEAM_INSTALL_TIMEOUT_MS, 300_000),
    wattclawTeamRetryCooldownMs: positiveInt(envConfig.OPENCLAW_WATTCLAW_TEAM_RETRY_COOLDOWN_MS, 300_000),
    promptCaptureAutoInstall: envConfig.OPENCLAW_PROMPT_CAPTURE_AUTO_INSTALL !== 'false',
    promptCaptureFailOnError: envConfig.OPENCLAW_PROMPT_CAPTURE_FAIL_ON_ERROR === 'true',
    promptCapturePluginDir: envConfig.OPENCLAW_PROMPT_CAPTURE_PLUGIN_DIR || '/app/plugins/wattclaw-prompt-capture',
    promptCaptureInstallTimeoutMs: positiveInt(envConfig.OPENCLAW_PROMPT_CAPTURE_INSTALL_TIMEOUT_MS, 600_000),
    promptCaptureRetryCooldownMs: positiveInt(envConfig.OPENCLAW_PROMPT_CAPTURE_RETRY_COOLDOWN_MS, 300_000),
    containerHealthTimeoutMs: positiveInt(envConfig.OPENCLAW_CONTAINER_HEALTH_TIMEOUT_MS, 600_000),
    tokenForIndex(index, tenantId) {
      return envConfig[`TENANT_${index + 1}_TOKEN`] || `${tokenPrefix}-${tenantId}-${randomBytes(12).toString('hex')}`
    },
    resolveCpuSet(index) {
      if (configuredCpuSets.length > 0) return configuredCpuSets[index % configuredCpuSets.length]
      const cpuCount = Math.max(1, os.cpus().length)
      return String(index % cpuCount)
    },
  }
}

function normalizeTenant(row) {
  if (!row) return null
  return {
    id: row.id,
    containerName: row.container_name,
    token: row.token,
    host: row.host || row.container_name,
    port: Number(row.port || 18789),
    maxUsers: Number(row.max_users || 20),
    cpusetCpus: row.cpuset_cpus || '',
    dataSource: row.data_source || '',
    status: row.status || 'active',
  }
}

function nextTenantId(ids) {
  const used = ids.map(tenantIndex).filter(index => index > 0)
  return `tenant-${Math.max(0, ...used) + 1}`
}

function tenantIndex(id) {
  const match = String(id || '').match(/^tenant-(\d+)$/)
  return match ? Number(match[1]) : 0
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function resolveWebSearchProvider(envConfig) {
  const configured = String(envConfig.OPENCLAW_WEB_SEARCH_PROVIDER || '').trim()
  if (configured) return configured
  if (envConfig.BRAVE_API_KEY || process.env.BRAVE_API_KEY) return 'brave'
  if (String(envConfig.OPENCLAW_WEB_SEARCH_ENABLED || '').trim().toLowerCase() === 'true') return 'duckduckgo'
  return ''
}

function resolveWebSearchEnabled(envConfig) {
  if (String(envConfig.OPENCLAW_WEB_SEARCH_ENABLED || '').trim().toLowerCase() === 'false') return false
  return Boolean(resolveWebSearchProvider(envConfig))
}

function isHostPathDataSource(dataSource) {
  return path.isAbsolute(dataSource) || /^[A-Za-z]:[\\/]/.test(dataSource)
}

function joinDockerHostPath(base, relativePath) {
  return `${base.replace(/[\\/]+$/g, '')}/${relativePath.replace(/\\/g, '/')}`
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function prepareOwnedPath(sourcePath, mode, uid, gid) {
  try { chownSync(sourcePath, uid, gid) } catch {}
  try { chmodSync(sourcePath, mode) } catch {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function loadWebSearchSetupScript() {
  const candidates = [
    path.join(process.cwd(), WEB_SEARCH_SETUP_SCRIPT),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../', WEB_SEARCH_SETUP_SCRIPT),
  ]
  const scriptPath = candidates.find(candidate => existsSync(candidate))
  if (!scriptPath) {
    throw new Error(`Web search setup script not found: ${WEB_SEARCH_SETUP_SCRIPT}`)
  }
  return readFileSync(scriptPath, 'utf8')
}

function buildWebSearchSetupCommand(script) {
  const encodedScript = Buffer.from(script, 'utf8').toString('base64')
  return [
    `node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' ${shellQuote(encodedScript)} > /tmp/configure-openclaw-web-search.sh`,
    'sh /tmp/configure-openclaw-web-search.sh',
    'rm -f /tmp/configure-openclaw-web-search.sh',
  ].join('\n')
}

function portBindingsMatch(actual, expected) {
  for (const [containerPort, bindings] of Object.entries(expected || {})) {
    const actualBindings = Array.isArray(actual?.[containerPort]) ? actual[containerPort] : []
    for (const binding of bindings || []) {
      const expectedHostIp = binding.HostIp || ''
      const expectedHostPort = String(binding.HostPort || '')
      const found = actualBindings.some(actualBinding => {
        const actualHostIp = actualBinding.HostIp || ''
        const actualHostPort = String(actualBinding.HostPort || '')
        return actualHostPort === expectedHostPort
          && (!expectedHostIp || actualHostIp === expectedHostIp)
      })
      if (!found) return false
    }
  }
  return true
}

// WattClaw Team 的 skill 脚本用 `openclaw gateway call ... --json | jq '{...}'`
// 裁剪输出以省 token，但 openclaw 官方镜像不带 jq，且租户容器由后端动态
// 创建（不在 compose 里、不由我们构建镜像），所以在 provision 时按需装一次。
// 已存在则跳过 apt，避免每次都跑 apt-get update。
function buildEnsureTenantToolingCommand() {
  return `
set -eu
if command -v jq >/dev/null 2>&1; then
  echo "[tenant-tooling] jq already present"
  exit 0
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "[tenant-tooling] apt-get unavailable, cannot install jq" >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends jq
echo "[tenant-tooling] jq installed: $(jq --version 2>/dev/null || echo unknown)"
`
}

function buildWattclawTeamInstallCommand() {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
src="/tmp/wattclaw-team"
if command -v openclaw >/dev/null 2>&1; then
  cli="openclaw"
elif [ -f /app/openclaw.mjs ]; then
  cli="node /app/openclaw.mjs"
elif [ -f ./openclaw.mjs ]; then
  cli="node ./openclaw.mjs"
else
  echo "Cannot find openclaw CLI or openclaw.mjs inside container" >&2
  exit 1
fi
echo "[wattclaw-team] installing from $src ..."
$cli plugins install "$src" --force
$cli config set plugins.entries.wattclaw-team.hooks.allowConversationAccess true
echo "[wattclaw-team] plugin installed"
`
}

function buildWattclawTeamInstallStateReadCommand() {
  return `
set -eu
marker=${shellQuote(WATTCLAW_TEAM_INSTALL_MARKER)}
plugin=${shellQuote('/home/node/.openclaw/extensions/wattclaw-team/dist/index.js')}
if [ -f "$marker" ] && [ -f "$plugin" ]; then
  cat "$marker"
fi
`
}

function buildWattclawTeamInstallMarkerCommand(sourceState) {
  const marker = JSON.stringify({
    schemaVersion: 1,
    sourceHash: sourceState.sourceHash,
    pluginVersion: sourceState.pluginVersion,
  })
  return `
set -eu
marker=${shellQuote(WATTCLAW_TEAM_INSTALL_MARKER)}
temporary_marker="\${marker}.$$"
mkdir -p "$(dirname "$marker")"
printf '%s\\n' ${shellQuote(marker)} > "$temporary_marker"
chmod 0644 "$temporary_marker"
mv -f "$temporary_marker" "$marker"
`
}

// Unlike wattclaw-team (esbuild-bundled, dependency-free dist), the prompt
// capture plugin ships plain source that requires the native better-sqlite3
// module. It cannot be pre-bundled, so we install dependencies inside the
// tenant container after copying the plugin so the module is compiled against
// the container's node ABI.
function buildPromptCaptureInstallCommand() {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
src="/tmp/wattclaw-prompt-capture"
if command -v openclaw >/dev/null 2>&1; then
  cli="openclaw"
elif [ -f /app/openclaw.mjs ]; then
  cli="node /app/openclaw.mjs"
elif [ -f ./openclaw.mjs ]; then
  cli="node ./openclaw.mjs"
else
  echo "Cannot find openclaw CLI or openclaw.mjs inside container" >&2
  exit 1
fi
echo "[wattclaw-prompt-capture] installing from $src ..."
$cli plugins install "$src" --force
dest="$HOME/.openclaw/extensions/wattclaw-prompt-capture"
if [ ! -d "$dest" ]; then
  echo "[wattclaw-prompt-capture] installed plugin directory not found at $dest" >&2
  exit 1
fi
cd "$dest"
echo "[wattclaw-prompt-capture] installing native dependencies (better-sqlite3) ..."
npm install --omit=dev --no-audit --no-fund --loglevel=error
for attempt in 1 2 3; do
  if (cd node_modules/better-sqlite3 && ../.bin/prebuild-install); then
    break
  fi
  if [ "$attempt" = "3" ]; then
    echo "[wattclaw-prompt-capture] failed to install better-sqlite3 native binding" >&2
    exit 1
  fi
done
node -e "require('better-sqlite3')" >/dev/null 2>&1 || { echo "[wattclaw-prompt-capture] better-sqlite3 failed to load after install" >&2; exit 1; }
$cli config set plugins.entries.wattclaw-prompt-capture.enabled true
$cli config set plugins.entries.wattclaw-prompt-capture.hooks.allowConversationAccess true
echo "[wattclaw-prompt-capture] plugin installed"
`
}

function buildPromptCaptureInstallStateReadCommand() {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
marker=${shellQuote(PROMPT_CAPTURE_INSTALL_MARKER)}
plugin="$HOME/.openclaw/extensions/wattclaw-prompt-capture/index.js"
native="$HOME/.openclaw/extensions/wattclaw-prompt-capture/node_modules/better-sqlite3"
if [ -f "$marker" ] && [ -f "$plugin" ] && [ -f "$native/build/Release/better_sqlite3.node" ]; then
  cat "$marker"
fi
`
}

function buildPromptCaptureInstallMarkerCommand(sourceState) {
  const marker = JSON.stringify({
    schemaVersion: 1,
    sourceHash: sourceState.sourceHash,
    pluginVersion: sourceState.pluginVersion,
  })
  return `
set -eu
marker=${shellQuote(PROMPT_CAPTURE_INSTALL_MARKER)}
temporary_marker="\${marker}.$$"
mkdir -p "$(dirname "$marker")"
printf '%s\\n' ${shellQuote(marker)} > "$temporary_marker"
chmod 0644 "$temporary_marker"
mv -f "$temporary_marker" "$marker"
`
}

function buildHermesPluginInstallCommand() {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
src="/tmp/openclaw-plugin-hermes"
if command -v openclaw >/dev/null 2>&1; then
  cli="openclaw"
elif [ -f /app/openclaw.mjs ]; then
  cli="node /app/openclaw.mjs"
elif [ -f ./openclaw.mjs ]; then
  cli="node ./openclaw.mjs"
else
  echo "Cannot find openclaw CLI or openclaw.mjs inside container" >&2
  exit 1
fi
echo "[openclaw-plugin-hermes] installing from $src ..."
$cli plugins install "$src" --force
dest="$HOME/.openclaw/extensions/openclaw-plugin-hermes"
if [ ! -d "$dest" ]; then
  echo "[openclaw-plugin-hermes] installed plugin directory not found at $dest" >&2
  exit 1
fi
cd "$dest"
echo "[openclaw-plugin-hermes] installing runtime dependencies ..."
npm install --omit=dev --no-audit --no-fund --loglevel=error
echo "[openclaw-plugin-hermes] plugin installed"
`
}

function buildHermesPluginInstallStateReadCommand() {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
marker=${shellQuote(HERMES_PLUGIN_INSTALL_MARKER)}
plugin="$HOME/.openclaw/extensions/openclaw-plugin-hermes/dist/index.js"
if [ -f "$marker" ] && [ -f "$plugin" ]; then
  cat "$marker"
fi
`
}

function buildHermesPluginInstallMarkerCommand(sourceState) {
  const marker = JSON.stringify({
    schemaVersion: 1,
    sourceHash: sourceState.sourceHash,
    pluginVersion: sourceState.pluginVersion,
  })
  return `
set -eu
marker=${shellQuote(HERMES_PLUGIN_INSTALL_MARKER)}
temporary_marker="\${marker}.$$"
mkdir -p "$(dirname "$marker")"
printf '%s\\n' ${shellQuote(marker)} > "$temporary_marker"
chmod 0644 "$temporary_marker"
mv -f "$temporary_marker" "$marker"
`
}

function buildLarkInstallStateReadCommand() {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
marker=${shellQuote(LARK_INSTALL_MARKER)}
${findLarkPluginSourceFunction()}
if [ -f "$marker" ] && find_plugin_src >/dev/null 2>&1; then
  cat "$marker"
fi
`
}

function buildLarkInstallMarkerCommand(sourceState) {
  const marker = JSON.stringify({
    schemaVersion: 1,
    sourceHash: sourceState.sourceHash,
  })
  return `
set -eu
marker=${shellQuote(LARK_INSTALL_MARKER)}
temporary_marker="\${marker}.$$"
mkdir -p "$(dirname "$marker")"
printf '%s\\n' ${shellQuote(marker)} > "$temporary_marker"
chmod 0644 "$temporary_marker"
mv -f "$temporary_marker" "$marker"
`
}

function buildLarkInstallCommand(pluginPackage) {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
${findLarkPluginSourceFunction()}
if plugin_src="$(find_plugin_src)"; then
  echo "[lark] plugin already installed: $plugin_src"
  exit 0
fi
echo "[lark] installing ${shellQuote(pluginPackage)} ..."
if command -v openclaw >/dev/null 2>&1; then
  openclaw plugins install ${shellQuote(pluginPackage)}
elif [ -f /app/openclaw.mjs ]; then
  node /app/openclaw.mjs plugins install ${shellQuote(pluginPackage)}
elif [ -f ./openclaw.mjs ]; then
  node ./openclaw.mjs plugins install ${shellQuote(pluginPackage)}
else
  echo "Cannot find openclaw CLI or openclaw.mjs inside container" >&2
  exit 1
fi
find_plugin_src >/dev/null
`
}

function buildLarkPatchCommand(distTarget) {
  return `
set -eu
export HOME="\${HOME:-/home/node}"
tmp_dir="/tmp/openclaw-lark-patches"
${findLarkPluginSourceFunction()}
plugin_src="$(find_plugin_src)"
echo "[lark] patch target: $plugin_src"
mkdir -p "$plugin_src/core" "$plugin_src/tools" "$plugin_src/channel"
cp "$tmp_dir/core/owner-policy.js" "$plugin_src/core/owner-policy.js"
cp "$tmp_dir/tools/oauth.js" "$plugin_src/tools/oauth.js"
cp "$tmp_dir/tools/onboarding-auth.js" "$plugin_src/tools/onboarding-auth.js"
cp "$tmp_dir/channel/monitor.js" "$plugin_src/channel/monitor.js"

dist_target=${shellQuote(distTarget)}
if [ -f "$dist_target" ]; then
  cp "$tmp_dir/monitor-Bog7UNtj.js" "$dist_target"
  echo "[lark] patched OpenClaw dist: $dist_target"
else
  found="$(find /home/node/.npm-global/lib/node_modules /usr/local/lib/node_modules /app -type f -path "*/dist/monitor-*.js" 2>/dev/null | while IFS= read -r file; do
    if grep -qE "monitorFeishuProvider|extensions/feishu/src/monitor.ts|feishu: starting" "$file"; then
      printf "%s\\n" "$file"
      break
    fi
  done)"
  if [ -n "$found" ]; then
    cp "$tmp_dir/monitor-Bog7UNtj.js" "$found"
    echo "[lark] patched OpenClaw dist: $found"
  else
    echo "[lark] warning: OpenClaw dist monitor-Bog7UNtj.js not found; plugin patches still applied" >&2
  fi
fi

grep -n "return;" "$plugin_src/core/owner-policy.js" >/dev/null
plugin_root="\${plugin_src%/src}"
chmod -R u+rwX,go-w "$plugin_root"
echo "[lark] plugin patches applied"
`
}

function findLarkPluginSourceFunction() {
  return `
find_plugin_src() {
  if [ -d "$HOME/.openclaw/extensions/openclaw-lark/src" ]; then
    printf "%s\\n" "$HOME/.openclaw/extensions/openclaw-lark/src"
    return 0
  fi

  owner_policy="$(find "$HOME/.openclaw" -type f -path "*/src/core/owner-policy.js" 2>/dev/null | grep -E "/(openclaw-lark|larksuite-openclaw-lark)[^/]*/src/core/owner-policy.js$" | head -n 1 || true)"
  if [ -n "$owner_policy" ]; then
    dirname "$(dirname "$owner_policy")"
    return 0
  fi

  return 1
}
`
}

function createLarkPatchTar(patchDir) {
  const entries = [
    ...larkPluginPatchFiles.map(file => ({
      name: `openclaw-lark-patches/${file}`,
      body: readFileSync(path.join(patchDir, file)),
    })),
    {
      name: 'openclaw-lark-patches/monitor-Bog7UNtj.js',
      body: readFileSync(path.join(patchDir, 'monitor-Bog7UNtj.js')),
    },
  ]

  return Buffer.concat(entries.flatMap(entry => tarEntry(entry.name, entry.body)).concat(tarEnd()))
}

function createDirTar(sourceDir, rootName) {
  const buffers = []
  const walk = (absDir, relDir) => {
    buffers.push(...tarDirEntry(`${relDir}/`))
    for (const name of readdirSync(absDir).sort()) {
      if (name === 'node_modules') continue
      const abs = path.join(absDir, name)
      const rel = `${relDir}/${name}`
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        walk(abs, rel)
      } else if (stat.isFile()) {
        buffers.push(...tarEntry(rel, readFileSync(abs)))
      }
    }
  }
  walk(sourceDir, rootName)
  buffers.push(...tarEnd())
  return Buffer.concat(buffers)
}

// Tar a directory with files at the archive ROOT (no wrapping dir). Used as a
// Docker build context, where the daemon expects Dockerfile at the tar root.
function createDirTarFlat(sourceDir) {
  const buffers = []
  const walk = (absDir, relPrefix) => {
    for (const name of readdirSync(absDir).sort()) {
      if (name === 'node_modules') continue
      const abs = path.join(absDir, name)
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        buffers.push(...tarDirEntry(`${rel}/`))
        walk(abs, rel)
      } else if (stat.isFile()) {
        buffers.push(...tarEntry(rel, readFileSync(abs)))
      }
    }
  }
  walk(sourceDir, '')
  buffers.push(...tarEnd())
  return Buffer.concat(buffers)
}

function tarDirEntry(name) {
  const header = Buffer.alloc(512, 0)
  writeTarString(header, 0, 100, name)
  writeTarString(header, 100, 8, '0000755')
  writeTarString(header, 108, 8, '0000000')
  writeTarString(header, 116, 8, '0000000')
  writeTarString(header, 124, 12, (0).toString(8).padStart(11, '0'))
  writeTarString(header, 136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'))
  header.fill(0x20, 148, 156)
  header[156] = '5'.charCodeAt(0)
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')

  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  writeTarString(header, 148, 8, checksum.toString(8).padStart(6, '0'))
  header[154] = 0
  header[155] = 0x20
  return [header]
}

function tarEntry(name, body) {
  const header = Buffer.alloc(512, 0)
  writeTarString(header, 0, 100, name)
  writeTarString(header, 100, 8, '0000644')
  writeTarString(header, 108, 8, '0000000')
  writeTarString(header, 116, 8, '0000000')
  writeTarString(header, 124, 12, body.length.toString(8).padStart(11, '0'))
  writeTarString(header, 136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'))
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')

  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  writeTarString(header, 148, 8, checksum.toString(8).padStart(6, '0'))
  header[154] = 0
  header[155] = 0x20

  const paddingLength = (512 - (body.length % 512)) % 512
  return [header, body, Buffer.alloc(paddingLength, 0)]
}

function tarEnd() {
  return [Buffer.alloc(1024, 0)]
}

function writeTarString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function isPairingOrScopeError(error) {
  const text = `${error?.message || ''} ${JSON.stringify(error?.details || {})}`
  return /pairing required|scope upgrade|pending approval|missing scope/i.test(text)
}

function isManagedBackendDeviceRequest(request) {
  if (!request || typeof request !== 'object') return false
  const scopes = Array.isArray(request.scopes) ? request.scopes : []
  return request.displayName === 'OpenClaw Web Backend'
    && request.clientId === 'cli'
    && request.clientMode === 'cli'
    && request.role === 'operator'
    && scopes.includes('operator.admin')
    && Boolean(request.deviceId)
    && Boolean(request.publicKey)
}

function buildApprovedBackendDevice(identity, existing, now) {
  const previous = existing && typeof existing === 'object' ? existing : {}
  const previousToken = previous.tokens && typeof previous.tokens === 'object' && previous.tokens.operator
    ? previous.tokens.operator
    : null
  const token = previousToken && typeof previousToken === 'object' && previousToken.token
    ? previousToken.token
    : randomBytes(32).toString('hex')
  const createdAtMs = Number(previous.createdAtMs || now)
  const approvedAtMs = Number(previous.approvedAtMs || now)
  const tokenCreatedAtMs = Number(previousToken?.createdAtMs || approvedAtMs || now)

  return {
    ...previous,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    platform: previous.platform || 'linux',
    clientId: 'cli',
    clientMode: 'cli',
    role: 'operator',
    roles: ['operator'],
    scopes: ['operator.admin'],
    approvedScopes: ['operator.admin'],
    displayName: 'OpenClaw Web Backend',
    tokens: {
      ...previous.tokens,
      operator: {
        ...previousToken,
        token,
        role: 'operator',
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        createdAtMs: tokenCreatedAtMs,
      },
    },
    createdAtMs,
    approvedAtMs,
  }
}

function loadWebBackendDeviceIdentity() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const devicePath = path.join(__dirname, '../../data/device-identity.json')
    if (!existsSync(devicePath)) return null
    const data = JSON.parse(readFileSync(devicePath, 'utf-8'))
    if (data.deviceId && data.publicKey) return data
    return null
  } catch {
    return null
  }
}

function readJsonObject(filePath) {
  if (!existsSync(filePath)) return {}
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writeJsonObject(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
  try { chmodSync(filePath, 0o600) } catch {}
}

async function dockerExecShell(containerName, script, timeoutMs = 30_000, options = {}) {
  const output = await dockerExecShellWithOutput(containerName, script, timeoutMs, options)
  if (String(output || '').trim()) console.log(String(output).trim())
}

async function dockerExecOpenClawCli(containerName, args, timeoutMs = 30_000) {
  const script = `
set -eu
export HOME="\${HOME:-/home/node}"
args_json=${shellQuote(JSON.stringify(args || []))}
if command -v openclaw >/dev/null 2>&1; then
  node -e 'const { spawnSync } = require("child_process"); const args = JSON.parse(process.argv[1]); const r = spawnSync("openclaw", args, { stdio: "inherit" }); process.exit(r.status === null ? 1 : r.status)' "$args_json"
elif [ -f /app/openclaw.mjs ]; then
  node -e 'const { spawnSync } = require("child_process"); const args = JSON.parse(process.argv[1]); const r = spawnSync("node", ["/app/openclaw.mjs", ...args], { stdio: "inherit" }); process.exit(r.status === null ? 1 : r.status)' "$args_json"
elif [ -f ./openclaw.mjs ]; then
  node -e 'const { spawnSync } = require("child_process"); const args = JSON.parse(process.argv[1]); const r = spawnSync("node", ["./openclaw.mjs", ...args], { stdio: "inherit" }); process.exit(r.status === null ? 1 : r.status)' "$args_json"
else
  echo "Cannot find openclaw CLI or openclaw.mjs inside container" >&2
  exit 127
fi
`
  const output = await dockerExecShellWithOutput(containerName, script, timeoutMs)
  return {
    stdout: output,
    stderr: '',
  }
}

async function dockerExecShellWithOutput(containerName, script, timeoutMs = 30_000, options = {}) {
  const execBody = {
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Cmd: ['sh', '-lc', script],
  }
  if (options.user != null && options.user !== '') execBody.User = String(options.user)
  const exec = await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/exec`, execBody)
  let timeout = null
  const start = dockerRequest('POST', `/exec/${encodeURIComponent(exec.Id)}/start`, {
    Detach: false,
    Tty: true,
  }, { raw: true })

  let output = ''
  try {
    output = await (timeoutMs > 0
      ? Promise.race([
        start,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`)
            error.stdout = ''
            error.stderr = ''
            error.exitCode = null
            reject(error)
          }, timeoutMs)
        }),
      ])
      : start)
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  const result = await dockerRequest('GET', `/exec/${encodeURIComponent(exec.Id)}/json`)
  if (result.ExitCode !== 0) {
    const error = new Error(String(output || '').trim() || `container exec failed with exit code ${result.ExitCode}`)
    error.stdout = output || ''
    error.stderr = ''
    error.exitCode = result.ExitCode
    throw error
  }
  return output || ''
}

function putDockerArchive(containerName, targetPath, archive) {
  return dockerRequest('PUT', `/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(targetPath)}`, archive, {
    contentType: 'application/x-tar',
    rawBody: true,
  })
}

function dockerRequest(method, requestPath, body, options = {}) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock'
    const headers = {}
    if (body && !options.rawBody) headers['Content-Type'] = 'application/json'
    if (body && options.rawBody && options.contentType) headers['Content-Type'] = options.contentType
    const req = http.request({
      socketPath,
      method,
      path: `/v1.43${requestPath}`,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    }, res => {
      if (options.stream) {
        res.resume()
        res.on('end', () => resolve(null))
        return
      }

      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        if ((res.statusCode >= 200 && res.statusCode < 300) || (options.allow204 && res.statusCode === 204) || (options.allow304 && res.statusCode === 304)) {
          if (!raw) return resolve(null)
          if (options.raw) return resolve(raw)
          try {
            resolve(JSON.parse(raw))
          } catch {
            resolve(raw)
          }
          return
        }
        const err = new Error(raw || `Docker API ${res.statusCode}`)
        err.statusCode = res.statusCode
        reject(err)
      })
    })
    req.on('error', reject)
    if (body) req.write(options.rawBody ? body : JSON.stringify(body))
    req.end()
  })
}
