/**
 * Focused static validator for .prale-eval/result.json against the current TASK.md.
 *
 * Checks (no third-party deps, plain Node):
 *   1. TASK.md metadata (task_id / repository / mode) matches result.json.
 *   2. Every required evidence path from the crossrepo contract is cited.
 *   3. Every evidence entry names a REAL symbol that literally occurs inside its
 *      inclusive start_line/end_line range in the on-disk file.
 *   4. Each required path is covered by at least one substantive claim whose
 *      evidence_paths cite it.
 *   5. Required top-level fields exist (evidence, claims, conclusion, validation).
 *
 * Run: node .prale-eval/fixture/verify-citations.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const checks = [];
const check = (name, cond, detail) => checks.push({ name, pass: Boolean(cond), detail });

const taskText = readFileSync(join(repoRoot, "TASK.md"), "utf8");
const result = JSON.parse(readFileSync(join(repoRoot, ".prale-eval", "result.json"), "utf8"));

// ── 1. TASK.md metadata is authoritative ────────────────────────────────────
const taskId = taskText.match(/task_id`?\s*exactly\s*`([^`]+)`/i)?.[1]
  ?? taskText.match(/task_id[^\n]*?`([^`]+)`/i)?.[1];
const repoKey = taskText.match(/Repository key:\s*`([^`]+)`/i)?.[1];
const modeKey = taskText.match(/Task mode:\s*`([^`]+)`/i)?.[1];

check("TASK.md task_id parsed", Boolean(taskId), `task_id=${taskId}`);
check("TASK.md repository key parsed", Boolean(repoKey), `repository=${repoKey}`);
check("TASK.md mode parsed", Boolean(modeKey), `mode=${modeKey}`);
check("result.task_id matches TASK.md", result.task_id === taskId, `${result.task_id} vs ${taskId}`);
check("result.repository matches TASK.md", result.repository === repoKey, `${result.repository} vs ${repoKey}`);
check("result.mode matches TASK.md", result.mode === modeKey, `${result.mode} vs ${modeKey}`);

// ── 2. Required source evidence paths ───────────────────────────────────────
const requiredPaths = [...taskText.matchAll(/^-\s+`([^`]+)`\s*$/gm)].map((m) => m[1]);
check("required evidence paths parsed from TASK.md", requiredPaths.length > 0, requiredPaths.join(", "));

const evidence = Array.isArray(result.evidence) ? result.evidence : [];
const claims = Array.isArray(result.claims) ? result.claims : [];

check("evidence is a non-empty list", evidence.length > 0, `n=${evidence.length}`);
check("claims is a non-empty list", claims.length > 0, `n=${claims.length}`);
check("conclusion is a substantive string", typeof result.conclusion === "string" && result.conclusion.length > 40, `len=${(result.conclusion ?? "").length}`);
check("validation.command present", typeof result.validation?.command === "string" && result.validation.command.length > 0, result.validation?.command);
check("validation.status present", typeof result.validation?.status === "string" && result.validation.status.length > 0, result.validation?.status);
check("validation.notes present", typeof result.validation?.notes === "string" && result.validation.notes.length > 0, `len=${(result.validation?.notes ?? "").length}`);

const citedPaths = new Set(evidence.map((e) => e.path));
for (const p of requiredPaths) {
  check(`required path cited in evidence: ${p}`, citedPaths.has(p), citedPaths.has(p) ? "present" : "MISSING");
}

// ── 3. Symbols literally occur inside their inclusive ranges ────────────────
for (const e of evidence) {
  const label = `${e.path} [${e.symbol}]`;
  check(`evidence has all fields: ${label}`, typeof e.path === "string" && typeof e.symbol === "string" &&
    Number.isInteger(e.start_line) && Number.isInteger(e.end_line) && e.start_line >= 1 && e.end_line >= e.start_line &&
    typeof e.observation === "string" && e.observation.length > 30, JSON.stringify({ s: e.start_line, en: e.end_line }));
  const abs = join(repoRoot, e.path);
  check(`evidence path exists on disk: ${e.path}`, existsSync(abs), abs);
  if (!existsSync(abs)) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  check(`range in bounds: ${label}`, e.end_line <= lines.length, `${e.start_line}-${e.end_line} of ${lines.length}`);
  const slice = lines.slice(Math.max(0, e.start_line - 1), e.end_line).join("\n");
  const symbolToken = e.symbol.split(".")[0].replace(/\(\)$/, "");
  check(`symbol occurs inside cited range: ${label}`, slice.includes(symbolToken), `looking for "${symbolToken}"`);
}

// ── 4. Each required path covered by >= 1 substantive claim ─────────────────
for (const p of requiredPaths) {
  const covering = claims.filter((c) => Array.isArray(c.evidence_paths) && c.evidence_paths.includes(p));
  check(`required path covered by a claim: ${p}`, covering.length > 0, `covering claims=${covering.length}`);
}

for (const c of claims) {
  check("claim is substantive", typeof c.claim === "string" && c.claim.length > 40, `len=${(c.claim ?? "").length}`);
  check("claim has evidence_paths", Array.isArray(c.evidence_paths) && c.evidence_paths.length > 0, JSON.stringify(c.evidence_paths));
  for (const p of c.evidence_paths ?? []) {
    check(`claim path exists: ${p}`, existsSync(join(repoRoot, p)), p);
    check(`claim path is cited in evidence: ${p}`, citedPaths.has(p), citedPaths.has(p) ? "cited" : "NOT CITED");
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
for (const c of checks) {
  console.log(`${c.pass ? "ok  " : "FAIL"}: ${c.name}${c.pass ? "" : `  -> ${c.detail}`}`);
}
const failed = checks.filter((c) => !c.pass);
console.log(`\n${failed.length} CHECK(S) FAILED (${checks.length} total)`);
process.exit(failed.length > 0 ? 1 : 0);
