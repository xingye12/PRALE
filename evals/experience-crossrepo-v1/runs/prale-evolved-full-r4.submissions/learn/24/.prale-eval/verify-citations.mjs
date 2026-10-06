#!/usr/bin/env node
/**
 * Focused validation for .prale-eval/result.json (task learn/24, mode contract).
 *
 * Checks, without any third-party dependency:
 *   1. task_id / repository / mode are exactly the current TASK.md values;
 *   2. every evidence entry names a file that exists in the workspace, has an
 *      inclusive start_line <= end_line range that is within the file, and the
 *      named symbol text actually occurs inside that range;
 *   3. the required path server/core/session-sync.js has at least one
 *      substantive evidence entry with a non-trivial observation;
 *   4. every claim is non-empty, cites at least one path, and every cited path
 *      is covered by an evidence entry;
 *   5. validation.command / status / notes and conclusion are present.
 *
 * Run: node .prale-eval/verify-citations.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const REQUIRED_PATH = 'server/core/session-sync.js'

const problems = []
const result = JSON.parse(readFileSync(join(here, 'result.json'), 'utf8'))
const task = readFileSync(join(root, 'TASK.md'), 'utf8')

// 1. metadata
const wantedTaskId = Number((task.match(/task learn\/(\d+)/i) || [])[1])
const wantedRepo = (task.match(/Repository key: `([^`]+)`/) || [])[1]
const wantedMode = (task.match(/Task mode: `([^`]+)`/) || [])[1]
if (result.task_id !== wantedTaskId) problems.push(`task_id ${result.task_id} !== TASK.md ${wantedTaskId}`)
if (result.repository !== wantedRepo) problems.push(`repository ${result.repository} !== TASK.md ${wantedRepo}`)
if (result.mode !== wantedMode) problems.push(`mode ${result.mode} !== TASK.md ${wantedMode}`)

// 2. evidence citations
const evidence = Array.isArray(result.evidence) ? result.evidence : []
if (evidence.length === 0) problems.push('evidence is empty')
const coveredPaths = new Set()
for (const [i, entry] of evidence.entries()) {
  const label = `evidence[${i}] ${entry.path}#${entry.symbol}`
  if (typeof entry.path !== 'string' || !entry.path.trim()) { problems.push(`${label}: missing path`); continue }
  if (typeof entry.symbol !== 'string' || !entry.symbol.trim()) { problems.push(`${label}: missing symbol`); continue }
  if (!Number.isInteger(entry.start_line) || !Number.isInteger(entry.end_line)) { problems.push(`${label}: lines must be integers`); continue }
  if (entry.start_line < 1 || entry.end_line < entry.start_line) { problems.push(`${label}: invalid range ${entry.start_line}-${entry.end_line}`); continue }
  if (typeof entry.observation !== 'string' || entry.observation.trim().length < 20) { problems.push(`${label}: observation too thin`); continue }
  let text
  try {
    text = readFileSync(join(root, entry.path), 'utf8')
  } catch {
    problems.push(`${label}: file not readable in workspace`)
    continue
  }
  const lines = text.split('\n')
  if (entry.end_line > lines.length) { problems.push(`${label}: end_line ${entry.end_line} exceeds ${lines.length} lines`); continue }
  const slice = lines.slice(entry.start_line - 1, entry.end_line).join('\n')
  const needle = entry.symbol.includes('(') ? entry.symbol : entry.symbol.replace(/\.$/, '')
  if (!slice.includes(needle)) problems.push(`${label}: symbol text not found within lines ${entry.start_line}-${entry.end_line}`)
  coveredPaths.add(entry.path)
}

// 3. required path coverage
const requiredEntries = evidence.filter(e => e.path === REQUIRED_PATH)
if (requiredEntries.length === 0) problems.push(`no evidence entry for required path ${REQUIRED_PATH}`)

// 4. claims
const claims = Array.isArray(result.claims) ? result.claims : []
if (claims.length === 0) problems.push('claims is empty')
const requiredClaims = claims.filter(c => (c.evidence_paths || []).includes(REQUIRED_PATH))
if (requiredClaims.length === 0) problems.push(`no claim cites required path ${REQUIRED_PATH}`)
for (const [i, claim] of claims.entries()) {
  const label = `claims[${i}]`
  if (typeof claim.claim !== 'string' || claim.claim.trim().length < 20) { problems.push(`${label}: claim text too thin`); continue }
  const paths = Array.isArray(claim.evidence_paths) ? claim.evidence_paths : []
  if (paths.length === 0) { problems.push(`${label}: no evidence_paths`); continue }
  for (const p of paths) {
    if (!coveredPaths.has(p)) problems.push(`${label}: evidence_paths cites ${p} which has no evidence entry`)
    try { readFileSync(join(root, p), 'utf8') } catch { problems.push(`${label}: evidence_paths ${p} not readable in workspace`) }
  }
}

// 5. conclusion + validation
if (typeof result.conclusion !== 'string' || result.conclusion.trim().length < 20) problems.push('conclusion missing or too thin')
const validation = result.validation || {}
for (const key of ['command', 'status', 'notes']) {
  if (typeof validation[key] !== 'string' || !validation[key].trim()) problems.push(`validation.${key} missing`)
}
if (!/pass/i.test(validation.status || '')) problems.push(`validation.status not passing: ${validation.status}`)

const report = {
  checked: {
    task_id: result.task_id,
    repository: result.repository,
    mode: result.mode,
    evidence: evidence.length,
    claims: claims.length,
    requiredPath: REQUIRED_PATH,
  },
  problems,
  status: problems.length === 0 ? 'PASS' : 'FAIL',
}
console.log(JSON.stringify(report, null, 2))
if (problems.length) process.exit(1)
