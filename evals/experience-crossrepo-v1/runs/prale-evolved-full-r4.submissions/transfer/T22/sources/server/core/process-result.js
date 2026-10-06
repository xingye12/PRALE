// Normalized process-execution results for server handlers.
//
// `system.js#localExec` / `system.js#gatewayExec` reject with a bare Error whose
// message is a single collapsed string (`stderr || stdout || exit code`). The
// exit code, signal and the partial stdout/stderr that were captured while the
// fake backend was running are discarded before any `{ ok: false, error }`
// handler can observe them (see `gateway-client.js#gatewayAdminRpcForTarget`,
// which already normalizes remote gateway failures into `{ ok, error }` but has
// no equivalent for local child processes).
//
// This module keeps the same spawn semantics (shell: true, piped stdio, SIGTERM
// then SIGKILL on timeout) but always RESOLVES with the repository's structured
// server-result envelope and carries the raw diagnostics through it instead of
// flattening them into one string.

import { spawn } from 'child_process'

export const PROCESS_FAILURE_KIND = Object.freeze({
  SPAWN_ERROR: 'spawn_error',
  NONZERO_EXIT: 'nonzero_exit',
  TIMEOUT: 'timeout',
})

export const PROCESS_FAILURE_CODE = Object.freeze({
  [PROCESS_FAILURE_KIND.SPAWN_ERROR]: 'PROCESS_SPAWN_ERROR',
  [PROCESS_FAILURE_KIND.NONZERO_EXIT]: 'PROCESS_NONZERO_EXIT',
  [PROCESS_FAILURE_KIND.TIMEOUT]: 'PROCESS_TIMEOUT',
})

function asText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

function pick(source, key) {
  return source && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined
}

/**
 * Build the lossless diagnostic bundle for a child-process failure.
 * Values are taken from the explicit `context` first (captured live by
 * `runCommandResult`) and fall back to fields carried on the Error object
 * itself, so wrapping code cannot silently drop them.
 */
export function buildProcessDiagnostics(error = {}, context = {}) {
  const diagnostics = {
    command: pick(context, 'command') ?? pick(error, 'command') ?? null,
    cwd: pick(context, 'cwd') ?? pick(error, 'cwd') ?? null,
    exitCode: pick(context, 'exitCode') ?? pick(error, 'exitCode') ?? null,
    signal: pick(context, 'signal') ?? pick(error, 'signal') ?? null,
    stdout: asText(pick(context, 'stdout') ?? pick(error, 'stdout')),
    stderr: asText(pick(context, 'stderr') ?? pick(error, 'stderr')),
    timedOut: Boolean(pick(context, 'timedOut') ?? pick(error, 'timedOut')),
    timeoutMs: pick(context, 'timeoutMs') ?? pick(error, 'timeoutMs') ?? null,
    durationMs: pick(context, 'durationMs') ?? pick(error, 'durationMs') ?? null,
    spawnCode: pick(error, 'code') ?? null,
    errno: pick(error, 'errno') ?? null,
    syscall: pick(error, 'syscall') ?? null,
  }
  return diagnostics
}

/**
 * Normalize any child-process / fake-backend failure into a structured
 * `{ ok: false, error: { code, kind, message, diagnostics } }` server result.
 * Never throws and never discards stdout/stderr/exit code.
 */
export function normalizeProcessFailure(error = {}, context = {}) {
  const diagnostics = buildProcessDiagnostics(error, context)

  let kind
  if (diagnostics.timedOut) {
    kind = PROCESS_FAILURE_KIND.TIMEOUT
  } else if (diagnostics.exitCode !== null && diagnostics.exitCode !== undefined) {
    kind = PROCESS_FAILURE_KIND.NONZERO_EXIT
  } else {
    kind = PROCESS_FAILURE_KIND.SPAWN_ERROR
  }

  const rawMessage = asText(pick(error, 'message')).trim()
  let message = rawMessage
  if (!message) {
    if (kind === PROCESS_FAILURE_KIND.TIMEOUT) {
      const seconds = diagnostics.timeoutMs ? Math.round(diagnostics.timeoutMs / 1000) : null
      message = seconds ? `Command timed out after ${seconds}s` : 'Command timed out'
    } else if (kind === PROCESS_FAILURE_KIND.NONZERO_EXIT) {
      message = `Command failed with exit code ${diagnostics.exitCode}`
    } else {
      message = 'Failed to spawn command'
    }
  }

  return {
    ok: false,
    error: {
      code: PROCESS_FAILURE_CODE[kind],
      kind,
      message,
      diagnostics,
    },
  }
}

/**
 * Run a (possibly fake) backend command and always resolve with a structured
 * server result instead of rejecting:
 *   success -> { ok: true,  payload: { command, exitCode, signal, stdout, stderr, durationMs } }
 *   failure -> { ok: false, error:   { code, kind, message, diagnostics } }
 *
 * `options.spawnImpl` lets callers/tests inject a fake child process (e.g. one
 * that emits an `error` event) without touching the real shell.
 */
export function runCommandResult(cmd, options = {}) {
  const {
    timeoutMs = 0,
    cwd = undefined,
    env = undefined,
    spawnImpl = spawn,
  } = options

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const context = {
      command: cmd,
      cwd: cwd ?? null,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      timeoutMs: timeoutMs || null,
      durationMs: null,
    }

    let child
    try {
      child = spawnImpl(cmd, { stdio: 'pipe', shell: true, cwd, env })
    } catch (err) {
      context.durationMs = Date.now() - startedAt
      resolve(normalizeProcessFailure(err, context))
      return
    }

    let timer = null
    let killTimer = null

    const finishFailure = (err) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      context.durationMs = Date.now() - startedAt
      resolve(normalizeProcessFailure(err || {}, context))
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (data) => { context.stdout += data.toString() })
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (data) => { context.stderr += data.toString() })
    }

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      context.exitCode = code
      context.signal = signal ?? null
      context.durationMs = Date.now() - startedAt

      if (code === 0 || code === undefined || code === null) {
        resolve({
          ok: true,
          payload: {
            command: cmd,
            exitCode: code ?? 0,
            signal: context.signal,
            stdout: context.stdout,
            stderr: context.stderr,
            durationMs: context.durationMs,
          },
        })
        return
      }

      resolve(normalizeProcessFailure(
        new Error((context.stderr || context.stdout || `Command failed with exit code ${code}`).trim()),
        context
      ))
    })

    child.on('error', (err) => finishFailure(err))

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        context.timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }, 5000)
        finishFailure(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
    }
  })
}
