// Focused validation for .prale-eval/result.json:
//  - metadata matches the current TASK.md
//  - every evidence entry names a real symbol that really lives inside the
//    cited inclusive line range of a real repository file
//  - every claim cites at least one declared evidence path
//  - the required delivery keys are present
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = JSON.parse(readFileSync(path.join(root, '.prale-eval', 'result.json'), 'utf8'))

assert.equal(result.task_id, 18, 'task_id must be the number 18')
assert.equal(result.repository, 'wattclaw', 'repository must be wattclaw')
assert.equal(result.mode, 'contract', 'mode must be contract')
for (const key of ['evidence', 'claims', 'conclusion', 'validation']) {
  assert.ok(key in result, `result.json must contain ${key}`)
}
assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0, 'evidence must be a non-empty list')
assert.ok(Array.isArray(result.claims) && result.claims.length > 0, 'claims must be a non-empty list')

const requiredPaths = ['server/core/config-queue.js']
const declared = new Set()

for (const ev of result.evidence) {
  for (const key of ['path', 'symbol', 'start_line', 'end_line', 'observation']) {
    assert.ok(key in ev, `evidence entry missing ${key}: ${JSON.stringify(ev)}`)
  }
  assert.ok(Number.isInteger(ev.start_line) && Number.isInteger(ev.end_line), `line range must be integers: ${ev.path}`)
  assert.ok(ev.start_line >= 1 && ev.end_line >= ev.start_line, `invalid line range: ${ev.path}`)
  const abs = path.join(root, ev.path)
  assert.ok(existsSync(abs), `evidence path does not exist: ${ev.path}`)
  const lines = readFileSync(abs, 'utf8').split('\n')
  assert.ok(ev.end_line <= lines.length, `end_line ${ev.end_line} beyond EOF of ${ev.path}`)
  const window = lines.slice(ev.start_line - 1, ev.end_line).join('\n')
  // The symbol may be written as "Class.member"; the source text only contains "member".
  const token = ev.symbol.split('.').pop()
  assert.ok(window.includes(token), `symbol "${ev.symbol}" (token "${token}") not found in ${ev.path}:${ev.start_line}-${ev.end_line}`)
  assert.ok(typeof ev.observation === 'string' && ev.observation.length >= 40, `observation too thin for ${ev.path}:${ev.symbol}`)
  declared.add(ev.path)
}

for (const p of requiredPaths) {
  assert.ok(declared.has(p), `required evidence path missing: ${p}`)
}

for (const claim of result.claims) {
  assert.ok(typeof claim.claim === 'string' && claim.claim.length >= 20, `claim too thin: ${JSON.stringify(claim)}`)
  assert.ok(Array.isArray(claim.evidence_paths) && claim.evidence_paths.length > 0, `claim missing evidence_paths: ${claim.claim}`)
  for (const p of claim.evidence_paths) {
    assert.ok(declared.has(p), `claim cites a path with no evidence entry: ${p}`)
  }
}
for (const p of requiredPaths) {
  assert.ok(result.claims.some(c => c.evidence_paths.includes(p)), `no claim cites required path ${p}`)
}

for (const key of ['command', 'status', 'notes']) {
  assert.ok(key in result.validation, `validation missing ${key}`)
}
assert.ok(['pass', 'fail', 'skipped'].includes(result.validation.status), 'validation.status must be pass|fail|skipped')
assert.ok(typeof result.conclusion === 'string' && result.conclusion.length >= 20, 'conclusion too thin')

console.log(`OK: result.json valid — ${result.evidence.length} evidence entries, ${result.claims.length} claims, required paths cited`)
for (const ev of result.evidence) console.log(`  - ${ev.path}:${ev.start_line}-${ev.end_line} ${ev.symbol}`)
