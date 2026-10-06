// Validation-only stub: server/core/auth.js pulls the DB-backed user-manager,
// which needs the missing better-sqlite3 native module. handlers/files.js only
// uses authMiddleware as an Express middleware reference.
export function authMiddleware(_req, _res, next) {
  if (typeof next === 'function') next()
}
