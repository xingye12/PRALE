// Auth middleware and helpers
import { validateToken } from '../user-manager.js'
import { ensureTenantForUser } from './multi-tenant-gateway.js'
import { runWithRequestContext } from './request-context.js'

export function isAuthEnabled() {
  return true
}

export function checkAuth(req) {
  let token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.session
  if (!token && req.query && req.query.token) {
    token = req.query.token
  }
  if (!token) return false

  const result = validateToken(token)
  if (!result) return false

  req.currentUser = result.user
  req.authToken = result.token
  return true
}

export async function authMiddleware(req, res, next) {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const tenant = await ensureTenantForUser(req.currentUser)
    req.currentTenant = tenant
    return runWithRequestContext({ user: req.currentUser, tenant }, () => next())
  } catch (err) {
    return res.status(503).json({ ok: false, error: { message: err.message || 'OpenClaw tenant unavailable' } })
  }
}

export function adminMiddleware(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}
