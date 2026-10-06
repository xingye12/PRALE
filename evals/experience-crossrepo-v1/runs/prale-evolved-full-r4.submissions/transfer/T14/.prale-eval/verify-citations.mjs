#!/usr/bin/env node
/**
 * Focused validator for the T14 / tdam / contract deliverable.
 *
 * Checks (all against the live checkout, no dependencies):
 *  1. TASK.md metadata is authoritative: task_id/repository/mode in result.json match it.
 *  2. result.json has every required top-level field, with the required shapes.
 *  3. Every repository-relative file listed in TASK.md's evidence contract has a
 *     substantive evidence entry.
 *  4. Each evidence entry names a real symbol that occurs INSIDE its inclusive
 *     [start_line, end_line] range in the cited file.
 *  5. Each claim names at least one evidence path, and the paths exist in `evidence`.
 *  6. The `.prale-eval/contract-deliverable.md` deliverable exists.
 *
 * Usage: node .prale-eval/verify-citations.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let checks = 0;
const failures = [];

function check(label, condition) {
  checks += 1;
  if (!condition) failures.push(label);
  return condition;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readText = (p) => readFileSync(p, "utf8");

// ── Load task + result ──────────────────────────────────────
const taskText = readText(path.join(root, "TASK.md"));
const resultPath = path.join(here, "result.json");
check("result.json exists", existsSync(resultPath));
const result = readJson(resultPath);

const taskId = (taskText.match(/task_id`?\s*(?:exactly)?\s*`?([A-Za-z0-9_-]+)`?/) || [])[1]
  ?? (taskText.match(/task_id[^A-Za-z0-9]+([A-Za-z0-9_-]+)/) || [])[1];
const repoKey = (taskText.match(/Repository key:\s*`([^`]+)`/) || [])[1];
const modeKey = (taskText.match(/Task mode:\s*`([^`]+)`/) || [])[1];

check(`result.task_id matches TASK.md (${taskId})`, result.task_id === taskId);
check(`result.repository matches TASK.md (${repoKey})`, result.repository === repoKey);
check(`result.mode matches TASK.md (${modeKey})`, result.mode === modeKey);

// ── Required top-level fields ───────────────────────────────
for (const field of ["evidence", "claims", "conclusion", "validation"]) {
  check(`result has field '${field}'`, Object.prototype.hasOwnProperty.call(result, field));
}
check("evidence is a non-empty array", Array.isArray(result.evidence) && result.evidence.length > 0);
check("claims is a non-empty array", Array.isArray(result.claims) && result.claims.length > 0);
check("validation.command is a string", typeof result.validation?.command === "string" && result.validation.command.length > 0);
check("validation.status is a string", typeof result.validation?.status === "string" && result.validation.status.length > 0);
check("validation.notes is a string", typeof result.validation?.notes === "string" && result.validation.notes.length > 0);
check("conclusion is a non-empty string", typeof result.conclusion === "string" && result.conclusion.trim().length > 0);

// ── Required source-evidence paths from TASK.md ─────────────
const contractBlock = (taskText.match(/crossrepo-evidence-contract:start[\s\S]*?crossrepo-evidence-contract:end/) || [""])[0];
const requiredPaths = [...contractBlock.matchAll(/`([^`]+\.[A-Za-z0-9]+)`/g)].map((m) => m[1]);
check("parsed at least one required evidence path from TASK.md", requiredPaths.length > 0);

const evidencePaths = new Set(result.evidence.map((e) => e.path));
for (const req of requiredPaths) {
  check(`required path cited in evidence: ${req}`, evidencePaths.has(req));
}

// ── Symbols occur inside their inclusive ranges ─────────────
for (const ev of result.evidence) {
  const label = `${ev.path} :: ${ev.symbol}`;
  const abs = path.join(root, ev.path);
  if (!existsSync(abs)) {
    check(`${label} -> file exists`, false);
    continue;
  }
  const lines = readText(abs).split(/\r?\n/);
  const { start_line: s, end_line: e } = ev;
  check(
    `${label} -> range is positive integers (${s}..${e})`,
    Number.isInteger(s) && Number.isInteger(e) && s >= 1 && e >= s && e <= lines.length,
  );
  const window = lines.slice(Math.max(0, s - 1), e).join("\n");
  check(`${label} -> symbol occurs inside [${s}, ${e}]`, window.includes(ev.symbol));
  check(`${label} -> observation is substantive`, typeof ev.observation === "string" && ev.observation.length >= 40);
}

// ── Claims reference existing evidence paths ────────────────
for (const [i, c] of result.claims.entries()) {
  const paths = Array.isArray(c.evidence_paths) ? c.evidence_paths : [];
  check(`claim[${i}] has non-empty claim text`, typeof c.claim === "string" && c.claim.length >= 20);
  check(`claim[${i}] names at least one evidence path`, paths.length > 0);
  for (const p of paths) {
    check(`claim[${i}] path exists in evidence: ${p}`, evidencePaths.has(p));
  }
}

// ── Deliverable file ────────────────────────────────────────
check(
  "contract deliverable exists: .prale-eval/contract-deliverable.md",
  existsSync(path.join(root, ".prale-eval", "contract-deliverable.md")),
);

// ── Report ──────────────────────────────────────────────────
console.log(
  JSON.stringify(
    {
      task_id: result.task_id,
      repository: result.repository,
      mode: result.mode,
      required_paths: requiredPaths,
      evidence_entries: result.evidence.length,
      claims: result.claims.length,
      checks,
      failed: failures.length,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length}/${checks} checks`);
  process.exit(1);
}
console.log(`\nOK: ${checks}/${checks} citation/contract checks passed`);
