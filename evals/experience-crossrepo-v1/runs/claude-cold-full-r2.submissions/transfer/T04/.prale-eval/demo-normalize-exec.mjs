// Executable demo: normalize a fake backend command / child-process failure
// into a structured server result without losing diagnostics.
//
// Run with the resolution hook that stubs the uninstalled `check-disk-space`:
//   node --import ./.prale-eval/harness/register.mjs .prale-eval/demo-normalize-exec.mjs
//
// It exercises the REAL helpers exported by server/core/system.js:
//   - localExec            (throws a plain Error today, now carrying err.diagnostics)
//   - normalizeExecFailure (maps any failure -> { ok:false, ...diagnostics })
//   - localExecResult      (non-throwing wrapper; the "normalized operation result")
// The contract matches the repo's existing { ok:false, error } shape from
// server/core/gateway-client.js (gatewayAdminRpcForTarget / gatewayHttpGet).

import {
  localExec,
  normalizeExecFailure,
  localExecResult,
} from '../server/core/system.js'

const results = []
let failures = 0

function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

function record(name, value) {
  results.push({ case: name, result: value })
  console.log(`\n[${name}] normalized result:`)
  console.log(JSON.stringify(value, null, 2))
}

// --- Case 1: fake backend command fails with non-zero exit + stderr ---------
console.log('Case 1: fake command fails (exit 7, writes stdout + stderr)')
const failingCmd =
  `node -e "process.stdout.write('partial-out'); process.stderr.write('boom: db locked'); process.exit(7)"`
const c1 = await localExecResult(failingCmd)
record('nonzero-exit', c1)
check('ok is false', c1.ok === false, JSON.stringify(c1.ok))
check('exitCode preserved', c1.exitCode === 7, String(c1.exitCode))
check('stderr diagnostic preserved', c1.stderr.includes('boom: db locked'), JSON.stringify(c1.stderr))
check('stdout diagnostic preserved', c1.stdout.includes('partial-out'), JSON.stringify(c1.stdout))
check('error message carries diagnostics', c1.error.includes('boom: db locked'), JSON.stringify(c1.error))
check('command preserved', c1.command === failingCmd)
check('json-serializable', typeof JSON.stringify(c1) === 'string')

// --- Case 2: missing command (shell exits 127) ------------------------------
console.log('\nCase 2: command not found (shell exit 127)')
const c2 = await localExecResult('definitely-not-a-real-binary-xyz --version')
record('missing-command', c2)
check('ok is false', c2.ok === false)
check('exitCode is 127', c2.exitCode === 127, String(c2.exitCode))
// Shell wording varies by environment ("not found" vs shell-shim "Permission
// denied"); the structured contract just needs non-empty stderr + exit 127.
check('stderr diagnostic preserved', c2.stderr.length > 0, JSON.stringify(c2.stderr))

// --- Case 3: timeout is normalized, not thrown ------------------------------
console.log('\nCase 3: timeout (500ms limit on a sleeping child)')
const c3 = await localExecResult(`node -e "setTimeout(()=>{}, 5000)"`, 500)
record('timeout', c3)
check('ok is false', c3.ok === false)
check('timedOut flag set', c3.timedOut === true)
check('signal recorded', c3.signal === 'SIGTERM', String(c3.signal))
check('error mentions timeout', /timed out after/i.test(c3.error), JSON.stringify(c3.error))

// --- Case 4: success stays on the same structured contract ------------------
console.log('\nCase 4: success returns the same shape')
const c4 = await localExecResult(`node -e "process.stdout.write('ok-payload')"`)
record('success', c4)
check('ok is true', c4.ok === true)
check('exitCode is 0', c4.exitCode === 0)
check('stdout captured', c4.stdout === 'ok-payload', JSON.stringify(c4.stdout))
check('error is null', c4.error === null)

// --- Case 5: normalizeExecFailure accepts a raw Error + explicit meta -------
console.log('\nCase 5: normalizeExecFailure on a raw error object')
const c5 = normalizeExecFailure(new Error('spawn ENOENT'), {
  command: 'fake-bin',
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  spawnError: 'ENOENT',
  timedOut: false,
})
record('raw-error', c5)
check('ok is false', c5.ok === false)
check('spawnError surfaced', c5.spawnError === 'ENOENT')
check('error message preserved', c5.error === 'spawn ENOENT')

// --- Case 6: localExec still rejects (back-compat) but attaches diagnostics --
console.log('\nCase 6: localExec keeps its throwing contract for existing callers')
let threw = false
let attached = null
try {
  await localExec(failingCmd)
} catch (err) {
  threw = true
  attached = err.diagnostics || null
}
check('still throws', threw === true)
check('err.diagnostics attached', attached !== null && attached.exitCode === 7, JSON.stringify(attached))

console.log('\n=== summary ===')
console.log(JSON.stringify({ cases: results.length, failures }, null, 2))
process.exit(failures === 0 ? 0 : 1)
