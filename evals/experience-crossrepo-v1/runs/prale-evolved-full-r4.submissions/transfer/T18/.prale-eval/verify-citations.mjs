/**
 * verify-citations.mjs — focused structural validator for this task's contract.
 *
 * Checks (no dependencies):
 *   - TASK.md metadata (repository key / mode / task_id) is authoritative;
 *   - .prale-eval/result.json declares the exact task_id / repository / mode;
 *   - every required evidence path from TASK.md is cited;
 *   - each evidence entry names a real symbol that actually occurs inside its
 *     inclusive line range in the cited file;
 *   - at least one substantive claim covers every required path, and every claim
 *     evidence_path is itself cited in evidence;
 *   - the required validation block is present.
 *
 * Run: node .prale-eval/verify-citations.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASK = resolve(ROOT, 'TASK.md');
const RESULT = resolve(ROOT, '.prale-eval/result.json');
const DELIVERABLE = resolve(ROOT, '.prale-eval/contract-deliverable.md');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ── doctrine: verify citations programmatically (symbol inside cited range) ── */
const taskText = readFileSync(TASK, 'utf8');
const repoKey = (taskText.match(/Repository key:\s*`([^`]+)`/) || [])[1] || '';
const mode = (taskText.match(/Task mode:\s*`([^`]+)`/) || [])[1] || '';
const taskId = (taskText.match(/task_id`?\s*exactly\s*`?([A-Za-z0-9_.-]+)`?/) || [])[1] || '';
const requiredPaths = [...taskText.matchAll(/^- `([^`]+)`\s*$/gm)]
  .map((m) => m[1])
  .filter((p) => p.includes('/') || p.endsWith('.ts'));

check('TASK.md repository key parsed', repoKey.length > 0, repoKey);
check('TASK.md mode parsed', mode.length > 0, mode);
check('TASK.md task_id parsed', taskId.length > 0, taskId);
check('required evidence paths found in TASK.md', requiredPaths.length > 0, requiredPaths.join(', '));

if (!existsSync(RESULT)) {
  check('result.json exists', false, RESULT);
  process.exit(1);
}
check('result.json exists', true);
check('contract-deliverable.md exists', existsSync(DELIVERABLE));

const result = JSON.parse(readFileSync(RESULT, 'utf8'));

check('result.task_id matches TASK.md', String(result.task_id) === taskId, String(result.task_id));
check('result.repository matches TASK.md', result.repository === repoKey, String(result.repository));
check('result.mode matches TASK.md', result.mode === mode, String(result.mode));
check('evidence is a non-empty list', Array.isArray(result.evidence) && result.evidence.length > 0);
check('claims is a non-empty list', Array.isArray(result.claims) && result.claims.length > 0);
check('conclusion present', typeof result.conclusion === 'string' && result.conclusion.trim().length > 0);
check(
  'validation.command/status/notes present',
  !!result.validation &&
    typeof result.validation.command === 'string' &&
    typeof result.validation.status === 'string' &&
    typeof result.validation.notes === 'string',
);

/* ── per-entry verification ── */
const citedPaths = new Set();
for (const [i, ev] of (result.evidence || []).entries()) {
  const tag = `evidence[${i}] ${ev.path ?? '<missing path>'}`;
  const hasAll =
    typeof ev.path === 'string' &&
    typeof ev.symbol === 'string' &&
    Number.isInteger(ev.start_line) &&
    Number.isInteger(ev.end_line) &&
    typeof ev.observation === 'string' &&
    ev.observation.trim().length >= 20;
  check(`${tag}: has path/symbol/start_line/end_line/substantive observation`, hasAll);
  if (!hasAll) continue;

  const abs = resolve(ROOT, ev.path);
  const exists = existsSync(abs);
  check(`${tag}: file exists`, exists);
  if (!exists) continue;
  citedPaths.add(ev.path);

  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  check(`${tag}: range ${ev.start_line}-${ev.end_line} valid`, ev.start_line >= 1 && ev.end_line >= ev.start_line && ev.end_line <= lines.length);
  const slice = lines.slice(Math.max(0, ev.start_line - 1), ev.end_line).join('\n');
  const symbolTok = ev.symbol.split(/[.():#]|\s+/).filter(Boolean)[0] || ev.symbol;
  check(`${tag}: symbol "${ev.symbol}" occurs inside cited range`, slice.includes(symbolTok));
}

for (const p of requiredPaths) {
  check(`required path cited: ${p}`, citedPaths.has(p));
}

/* ── claims ── */
for (const [i, cl] of (result.claims || []).entries()) {
  const tag = `claims[${i}]`;
  const substantive = typeof cl.claim === 'string' && cl.claim.trim().length >= 30;
  check(`${tag}: substantive claim`, substantive, substantive ? '' : JSON.stringify(cl.claim));
  const paths = Array.isArray(cl.evidence_paths) ? cl.evidence_paths : [];
  check(`${tag}: has evidence_paths`, paths.length > 0);
  for (const p of paths) {
    check(`${tag}: path exists (${p})`, existsSync(resolve(ROOT, p)));
    check(`${tag}: path cited in evidence (${p})`, citedPaths.has(p));
  }
}

for (const p of requiredPaths) {
  check(
    `required path covered by a claim: ${p}`,
    (result.claims || []).some((c) => Array.isArray(c.evidence_paths) && c.evidence_paths.includes(p)),
  );
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`} (${checks.length} total)`);
process.exit(failed === 0 ? 0 : 1);
