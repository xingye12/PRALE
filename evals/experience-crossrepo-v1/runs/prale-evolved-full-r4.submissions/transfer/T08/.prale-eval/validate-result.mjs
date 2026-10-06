#!/usr/bin/env node
// Focused validation for this contract task: re-open .prale-eval/result.json and
// assert it exactly matches the authoritative metadata in TASK.md, that every
// evidence citation is real (file exists, inclusive range valid, named symbol
// literally present inside the range), that every claim names existing evidence
// paths, that the required contract path is covered, and that the deliverable
// markdown exists. Exits non-zero on any failure.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -> ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const task = readFileSync(path.join(WORKSPACE, 'TASK.md'), 'utf8')
const literal = (field) => task.match(new RegExp('`' + field + '` exactly `([^`]+)`'))?.[1]
const expected = {
  task_id: literal('task_id'),
  repository: literal('repository'),
  mode: literal('mode'),
}
const requiredPath = task.match(/^- `(server\/core\/config-queue\.js)`$/m)?.[1]

const resultPath = path.join(WORKSPACE, '.prale-eval/result.json')
const result = JSON.parse(readFileSync(resultPath, 'utf8'))

check('task_id matches TASK.md', result.task_id === expected.task_id, `${result.task_id} vs ${expected.task_id}`)
check('repository matches TASK.md', result.repository === expected.repository, `${result.repository} vs ${expected.repository}`)
check('mode matches TASK.md', result.mode === expected.mode, `${result.mode} vs ${expected.mode}`)
check('required evidence path parsed', Boolean(requiredPath), String(requiredPath))

check('evidence is a non-empty array', Array.isArray(result.evidence) && result.evidence.length > 0)
check('claims is a non-empty array', Array.isArray(result.claims) && result.claims.length > 0)
check('conclusion is non-empty string', typeof result.conclusion === 'string' && result.conclusion.length > 0)
check('validation has command/status/notes',
  Boolean(result.validation?.command) && result.validation?.status === 'pass' && Boolean(result.validation?.notes))

const evidencePaths = new Set()
for (const entry of result.evidence) {
  const label = `${entry.path}:${entry.symbol}`
  const abs = path.join(WORKSPACE, entry.path)
  if (!existsSync(abs)) { check(`evidence file exists ${label}`, false); continue }
  evidencePaths.add(entry.path)
  const lines = readFileSync(abs, 'utf8').split('\n')
  const inRange = Number.isInteger(entry.start_line) && Number.isInteger(entry.end_line) &&
    entry.start_line >= 1 && entry.end_line >= entry.start_line && entry.end_line <= lines.length
  check(`evidence range valid ${label}`, inRange, `${entry.start_line}-${entry.end_line}`)
  if (!inRange) continue
  const slice = lines.slice(entry.start_line - 1, entry.end_line).join('\n')
  check(`symbol in range ${label}`, slice.includes(entry.symbol))
  check(`observation substantive ${label}`, typeof entry.observation === 'string' && entry.observation.length > 40)
}

check('required path cited', requiredPath && evidencePaths.has(requiredPath), String(requiredPath))

for (const [i, claim] of result.claims.entries()) {
  check(`claim ${i + 1} text`, typeof claim.claim === 'string' && claim.claim.length > 40)
  check(`claim ${i + 1} evidence_paths`,
    Array.isArray(claim.evidence_paths) && claim.evidence_paths.length > 0 &&
    claim.evidence_paths.every(p => evidencePaths.has(p)), JSON.stringify(claim.evidence_paths))
}
check('required path has claim coverage',
  result.claims.some(c => Array.isArray(c.evidence_paths) && c.evidence_paths.includes(requiredPath)))

check('contract-deliverable.md exists', existsSync(path.join(WORKSPACE, '.prale-eval/contract-deliverable.md')))
check('deliverable names the fixture',
  existsSync(path.join(WORKSPACE, '.prale-eval/contract-deliverable.md')) &&
  readFileSync(path.join(WORKSPACE, '.prale-eval/contract-deliverable.md'), 'utf8').includes('config-queue-failure-fixture.mjs'))

console.log(failures.length === 0 ? 'ALL RESULT CHECKS PASSED' : `RESULT CHECKS FAILED: ${failures.length}`)
process.exitCode = failures.length === 0 ? 0 : 1
