// System-level helpers: network stats, disk space, process execution
import os from 'os'
import { execSync, exec, spawn } from 'child_process'
import checkDiskSpace from 'check-disk-space'
import { readFileSync } from 'fs'

let _networkStatsCache = null
let _networkStatsTime = 0
const NETWORK_STATS_TTL = 5_000

export function getNetworkStatsSync() {
  const platform = os.platform()
  let bytesReceived = 0
  let bytesSent = 0

  try {
    if (platform === 'win32') {
      const output = execSync(
        'powershell -NoProfile -Command "Get-NetAdapterStatistics | ConvertTo-Json"',
        { encoding: 'utf8', timeout: 5000 }
      )
      const stats = JSON.parse(output || '[]')
      const adapters = Array.isArray(stats) ? stats : [stats]
      for (const adapter of adapters) {
        if (adapter) {
          bytesReceived += Number(adapter.ReceivedBytes) || 0
          bytesSent += Number(adapter.SentBytes) || 0
        }
      }
    } else {
      const netDev = readFileSync('/proc/net/dev', 'utf8')
      const lines = netDev.trim().split('\n').slice(2)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 10) {
          const iface = parts[0].replace(':', '')
          if (iface === 'lo') continue
          bytesReceived += parseInt(parts[1], 10) || 0
          bytesSent += parseInt(parts[9], 10) || 0
        }
      }
    }
  } catch {
    bytesReceived = 0
    bytesSent = 0
  }

  return { bytesReceived, bytesSent }
}

export function getNetworkStatsAsync() {
  return new Promise((resolve) => {
    const platform = os.platform()
    if (platform === 'win32') {
      exec(
        'powershell -NoProfile -Command "Get-NetAdapterStatistics | ConvertTo-Json"',
        { encoding: 'utf8', timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve({ bytesReceived: 0, bytesSent: 0 })
          try {
            const stats = JSON.parse(stdout || '[]')
            const adapters = Array.isArray(stats) ? stats : [stats]
            let bytesReceived = 0, bytesSent = 0
            for (const adapter of adapters) {
              if (adapter) {
                bytesReceived += Number(adapter.ReceivedBytes) || 0
                bytesSent += Number(adapter.SentBytes) || 0
              }
            }
            resolve({ bytesReceived, bytesSent })
          } catch {
            resolve({ bytesReceived: 0, bytesSent: 0 })
          }
        }
      )
    } else {
      resolve(getNetworkStatsSync())
    }
  })
}

export async function getNetworkStats() {
  const now = Date.now()
  if (_networkStatsCache && now - _networkStatsTime < NETWORK_STATS_TTL) {
    return _networkStatsCache
  }
  const stats = await getNetworkStatsAsync()
  _networkStatsCache = stats
  _networkStatsTime = now
  return stats
}

export async function getDiskSpace() {
  try {
    const platform = os.platform()
    let checkPath = '/'
    if (platform === 'win32') {
      checkPath = process.env.SystemDrive || 'C:\\'
    }
    const diskSpace = await checkDiskSpace(checkPath)
    return {
      total: diskSpace.size,
      free: diskSpace.free,
      used: diskSpace.size - diskSpace.free,
    }
  } catch {
    return { total: 0, free: 0, used: 0 }
  }
}

export function localExec(cmd, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { stdio: 'pipe', shell: true })
    let stdout = ''
    let stderr = ''
    let timer = null
    let killTimer = null
    let timedOut = false

    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (code === 0 || code === undefined || code === null) {
        resolve(stdout)
        return
      }
      const err = new Error((stderr || stdout || `Command failed with exit code ${code}`).trim())
      // Attach structured diagnostics so callers can normalize without re-parsing.
      err.diagnostics = { command: cmd, exitCode: code, signal: signal || null, stdout, stderr, timedOut }
      reject(err)
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      err.diagnostics = { command: cmd, exitCode: null, signal: null, stdout, stderr, timedOut: false, spawnError: err.code || null }
      reject(err)
    })

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          child.kill('SIGKILL')
        }, 5000)
        const err = new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`)
        err.diagnostics = { command: cmd, exitCode: null, signal: 'SIGTERM', stdout, stderr, timedOut: true }
        reject(err)
      }, timeoutMs)
    }
  })
}

/**
 * Normalize any child-process failure into a stable, serializable server result.
 * Mirrors the `{ ok: false, error }` contract used by gateway-client.js so callers
 * can branch on `.ok` instead of catching exceptions, while keeping the raw
 * stdout/stderr/exitCode/signal/timeout diagnostics attached.
 */
export function normalizeExecFailure(err, meta = {}) {
  const diagnostics = (err && err.diagnostics) ? err.diagnostics : {}
  const message = (err && err.message) ? String(err.message) : String(err || 'Command failed')
  return {
    ok: false,
    error: message,
    command: meta.command ?? diagnostics.command ?? null,
    exitCode: diagnostics.exitCode ?? meta.exitCode ?? null,
    signal: diagnostics.signal ?? meta.signal ?? null,
    stdout: diagnostics.stdout ?? meta.stdout ?? '',
    stderr: diagnostics.stderr ?? meta.stderr ?? '',
    timedOut: Boolean(diagnostics.timedOut ?? meta.timedOut),
    spawnError: diagnostics.spawnError ?? meta.spawnError ?? null,
  }
}

/**
 * Non-throwing variant of localExec. Always resolves to a structured result:
 *   success -> { ok: true, command, stdout, stderr, exitCode: 0, signal: null, timedOut: false }
 *   failure -> { ok: false, error, command, exitCode, signal, stdout, stderr, timedOut, spawnError }
 */
export async function localExecResult(cmd, timeoutMs = 0) {
  try {
    const stdout = await localExec(cmd, timeoutMs)
    return { ok: true, error: null, command: cmd, exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, spawnError: null }
  } catch (err) {
    return normalizeExecFailure(err, { command: cmd })
  }
}

export function gatewayExec(cmd, timeoutMs = 0) {
  return localExec(cmd, timeoutMs)
}
