#!/usr/bin/env node
// Executable demo / contract for T04 (wattclaw, mode=operate):
// normalize a fake backend command / child-process failure into a structured
// server result WITHOUT losing diagnostics.
//
// Why this lives at the server boundary:
//   - server/core/system.js -> localExec() drives child processes and, on any
//     non-zero exit / spawn error / timeout, rejects with a plain `Error` whose
//     message is only `stderr || stdout || "Command failed with exit code N"`.
//     Distinct failure modes therefore collapse into one opaque string: the exit
//     code is dropped whenever stderr is non-empty, stdout is dropped whenever
//     stderr exists, `signal` and `timedOut` are never surfaced, and callers that
//     catch it (e.g. server/handlers/files.js) can only forward `err.message`.
//   - server/core/gateway-client.js -> gatewayAdminRpcForTarget() already models
//     the desired contract: it never rejects, it returns
//     `{ ok: true, payload }` on success and `{ ok: false, error }` on failure.
//
// This module applies that same structured-result contract to command failures
// and keeps every diagnostic field (exitCode, signal, stdout, stderr, timedOut,
// durationMs, command, cause) instead of throwing a lossy Error.
//
// Run:  node scripts/normalize-command-failure.mjs
// Exit: 0 when every self-check passes, 1 otherwise. No external dependencies.

/** Stable machine-readable discriminants for command failures. */
export const CommandFailureCode = Object.freeze({
  EXIT: 'COMMAND_EXITED_NONZERO',
  SPAWN: 'COMMAND_SPAWN_FAILED',
  TIMEOUT: 'COMMAND_TIMED_OUT',
})

const MAX_DIAGNOSTIC_CHARS = 8_000

function cap(text) {
  if (typeof text !== 'string') return ''
  return text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…[truncated]` : text
}

const KNOWN_CODES = new Set(Object.values(CommandFailureCode))

function classify(failure) {
  if (KNOWN_CODES.has(failure?.code)) return failure.code
  if (failure?.timedOut) return CommandFailureCode.TIMEOUT
  if (Number.isInteger(failure?.exitCode)) return CommandFailureCode.EXIT
  return CommandFailureCode.SPAWN
}

function buildMessage({ code, command, exitCode, signal, stdout, stderr, timedOut, timeoutMs, cause, causeCode }) {
  // Prefer the most specific human signal available, and never lose raw output.
  if (cause) return String(cause)
  if (timedOut) return `Command timed out after ${Math.round((timeoutMs || 0) / 1000)}s`
  if (stderr.trim()) return stderr.trim()
  if (stdout.trim()) return stdout.trim()
  if (code === CommandFailureCode.SPAWN) {
    const codeSuffix = causeCode ? ` (${causeCode})` : ''
    return `Failed to spawn command: ${command || '<unknown>'}${codeSuffix}`
  }
  const signalSuffix = signal ? ` (signal ${signal})` : ''
  return `Command failed with exit code ${exitCode}${signalSuffix}`
}

/**
 * Normalize a raw child-process failure into the repo's server result envelope.
 * Never throws: unrecognized/partial failure objects still yield a valid result.
 *
 * @param {object} failure  raw failure: { exitCode?, signal?, stdout?, stderr?, timedOut?, code?, cause? }
 * @param {object} [context] { command?, durationMs?, timeoutMs? }
 * @returns {{ ok: false, error: object }} structured, diagnostics-preserving result
 */
export function normalizeCommandFailure(failure = {}, context = {}) {
  const stdout = cap(failure.stdout)
  const stderr = cap(failure.stderr)
  const exitCode = Number.isInteger(failure.exitCode) ? failure.exitCode : null
  const signal = failure.signal ?? null
  const timedOut = Boolean(failure.timedOut)
  const command = context.command ?? failure.command ?? null
  const code = classify(failure)
  const cause = failure.cause instanceof Error ? failure.cause.message : (failure.cause ?? null)
  // Native OS error code (e.g. ENOENT) is kept alongside the classification.
  const causeCode = typeof failure.code === 'string' && !KNOWN_CODES.has(failure.code) ? failure.code : null
  const durationMs = Number.isFinite(context.durationMs) ? context.durationMs : (failure.durationMs ?? null)

  return {
    ok: false,
    error: {
      code,
      message: buildMessage({
        code, command, exitCode, signal, stdout, stderr, timedOut,
        timeoutMs: context.timeoutMs, cause, causeCode,
      }),
      command,
      causeCode,
      exitCode,
      signal,
      stdout,
      stderr,
      timedOut,
      durationMs,
    },
  }
}

/** Normalize a successful child-process run into the same envelope. */
export function normalizeCommandSuccess(run = {}, context = {}) {
  return {
    ok: true,
    stdout: cap(run.stdout),
    stderr: cap(run.stderr),
    exitCode: Number.isInteger(run.exitCode) ? run.exitCode : 0,
    durationMs: Number.isFinite(context.durationMs) ? context.durationMs : (run.durationMs ?? null),
  }
}

/**
 * Run an injectable command runner and always resolve to the structured result.
 * The runner is the seam used to fake a backend/child-process failure in tests;
 * in production it would delegate to system.js localExec()/gatewayExec().
 *
 * @param {(command: string, timeoutMs: number) => Promise<object>} runner
 * @param {string} command
 * @param {object} [options] { timeoutMs? }
 */
export async function runCommand(runner, command, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0
  const started = Date.now()
  try {
    const run = await runner(command, timeoutMs)
    const durationMs = Date.now() - started
    const rawExit = run?.exitCode
    // Absent exit code means "assume success"; an explicit null (killed) stays null.
    const exitCode = Number.isInteger(rawExit) ? rawExit : (rawExit === undefined ? 0 : null)
    const timedOut = Boolean(run?.timedOut)
    const signal = run?.signal ?? null
    if (exitCode === 0 && !timedOut) {
      return normalizeCommandSuccess({ ...run, exitCode }, { durationMs })
    }
    return normalizeCommandFailure({ ...run, exitCode, timedOut, signal }, { command, durationMs, timeoutMs })
  } catch (err) {
    // Defensive: a runner that throws (mirrors localExec's rejection) is still normalized.
    const durationMs = Date.now() - started
    return normalizeCommandFailure(
      {
        code: err?.code,
        exitCode: Number.isInteger(err?.exitCode) ? err.exitCode : null,
        signal: err?.signal ?? null,
        stdout: err?.stdout ?? '',
        stderr: err?.stderr ?? '',
        timedOut: Boolean(err?.timedOut),
        cause: err?.message ?? String(err),
      },
      { command, durationMs, timeoutMs },
    )
  }
}

// --- Fake backend command runners (deterministic, no external binaries) ------

/** Simulates a shell command that exits non-zero and writes both streams. */
export const fakeExitFailure = async (command) => ({
  command,
  exitCode: 3,
  signal: null,
  stdout: 'partial-work-completed\n',
  stderr: 'fake-backend: no such workspace\n',
  timedOut: false,
})

/** Simulates the child never spawning (spawn error). */
export const fakeSpawnFailure = async () => {
  const err = new Error('spawn fake-backend ENOENT')
  err.code = 'ENOENT'
  throw err
}

/** Simulates a command killed after exceeding its timeout. */
export const fakeTimeoutFailure = async (command) => ({
  command,
  exitCode: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true,
})

/** Simulates a clean run. */
export const fakeSuccess = async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false })

// --- Self-check --------------------------------------------------------------

function assert(cond, label, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`)
    return true
  }
  console.error(`  FAIL  ${label}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`)
  return false
}

async function main() {
  console.log('normalize-command-failure: fake child-process failure -> structured server result\n')
  let ok = true

  const exited = await runCommand(fakeExitFailure, 'fake-backend list-workspaces', { timeoutMs: 5_000 })
  console.log('non-zero exit result:', JSON.stringify(exited))
  ok = assert(exited.ok === false, 'exit failure normalizes to ok:false') && ok
  ok = assert(exited.error.code === CommandFailureCode.EXIT, 'exit failure keeps code') && ok
  ok = assert(exited.error.exitCode === 3, 'exit failure keeps exitCode', exited.error) && ok
  ok = assert(exited.error.stderr === 'fake-backend: no such workspace\n', 'exit failure keeps stderr') && ok
  ok = assert(exited.error.stdout === 'partial-work-completed\n', 'exit failure keeps stdout (would be lost by localExec)', exited.error) && ok
  ok = assert(exited.error.message === 'fake-backend: no such workspace', 'exit failure keeps readable message') && ok

  const spawned = await runCommand(fakeSpawnFailure, 'fake-backend missing-binary')
  console.log('spawn failure result:', JSON.stringify(spawned))
  ok = assert(spawned.ok === false && spawned.error.code === CommandFailureCode.SPAWN, 'spawn error classified') && ok
  ok = assert(spawned.error.message.includes('ENOENT'), 'spawn error keeps cause message') && ok
  ok = assert(spawned.error.causeCode === 'ENOENT', 'spawn error keeps native causeCode') && ok

  const timedOut = await runCommand(fakeTimeoutFailure, 'fake-backend slow', { timeoutMs: 2_000 })
  console.log('timeout result:', JSON.stringify(timedOut))
  ok = assert(timedOut.ok === false && timedOut.error.timedOut === true, 'timeout flag preserved') && ok
  ok = assert(timedOut.error.code === CommandFailureCode.TIMEOUT, 'timeout classified') && ok
  ok = assert(timedOut.error.signal === 'SIGTERM', 'timeout keeps signal') && ok
  ok = assert(timedOut.error.message === 'Command timed out after 2s', 'timeout message preserved') && ok

  const good = await runCommand(fakeSuccess, 'fake-backend health')
  console.log('success result:', JSON.stringify(good))
  ok = assert(good.ok === true && good.stdout === 'ok\n', 'clean run normalizes to ok:true') && ok

  console.log(`\n${ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`)
  process.exit(ok ? 0 : 1)
}

// Only self-run when invoked directly, so the module can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('unexpected demo error:', err)
    process.exit(1)
  })
}
