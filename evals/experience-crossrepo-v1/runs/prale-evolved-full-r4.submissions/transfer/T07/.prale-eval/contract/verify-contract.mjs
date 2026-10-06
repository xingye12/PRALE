#!/usr/bin/env node
/**
 * T07 focused validation — static citation + delivery contract checker.
 *
 * Verifies that .prale-eval/result.json matches the CURRENT TASK.md metadata
 * (authoritative) and that every evidence citation names a real file and a real
 * symbol inside its inclusive line range, with the required source path covered
 * by at least one claim. Pure static checks: no dependency on the `yaml` package.
 *
 * Run: node .prale-eval/contract/verify-contract.mjs
 * Exit: 0 when every check passes, 1 otherwise.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // .prale-eval/contract
const ROOT = join(HERE, "..", "..");                  // workspace root

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

const taskPath = join(ROOT, "TASK.md");
const resultPath = join(ROOT, ".prale-eval", "result.json");
const deliverablePath = join(ROOT, ".prale-eval", "contract-deliverable.md");

const task = readFileSync(taskPath, "utf8");
const result = JSON.parse(readFileSync(resultPath, "utf8"));

// --- TASK.md is authoritative: parse expected metadata from it --------------
const taskId = (task.match(/`task_id`\s+exactly\s+`([^`]+)`/) || [])[1];
const repoKey = (task.match(/Repository key:\s*`([^`]+)`/) || [])[1];
const modeKey = (task.match(/Task mode:\s*`([^`]+)`/) || [])[1];
const requiredPaths = [...task.matchAll(/required source evidence|^-\s+`([^`]+)`\s*$/gm)]
  .map((m) => m[1])
  .filter((p) => p && p.includes("/"));

check("TASK.md task_id parsed", Boolean(taskId), String(taskId));
check("TASK.md repository key parsed", Boolean(repoKey), String(repoKey));
check("TASK.md mode parsed", Boolean(modeKey), String(modeKey));

check("result.task_id matches TASK.md", result.task_id === taskId, `result=${JSON.stringify(result.task_id)} task=${taskId}`);
check("result.repository matches TASK.md", result.repository === repoKey, `result=${JSON.stringify(result.repository)} task=${repoKey}`);
check("result.mode matches TASK.md", result.mode === modeKey, `result=${JSON.stringify(result.mode)} task=${modeKey}`);

// --- Shape ------------------------------------------------------------------
check("evidence is a non-empty array", Array.isArray(result.evidence) && result.evidence.length > 0, `len=${result.evidence?.length}`);
check("claims is a non-empty array", Array.isArray(result.claims) && result.claims.length > 0, `len=${result.claims?.length}`);
check("conclusion is a non-empty string", typeof result.conclusion === "string" && result.conclusion.trim().length > 0);
check("validation.command present", typeof result.validation?.command === "string" && result.validation.command.length > 0);
check("validation.status present", typeof result.validation?.status === "string" && result.validation.status.length > 0);
check("validation.notes present", typeof result.validation?.notes === "string" && result.validation.notes.length > 0);
check("contract-deliverable.md exists", existsSync(deliverablePath));

// --- Evidence grounding -----------------------------------------------------
const citedPaths = new Set();
for (const ev of result.evidence ?? []) {
  const tag = ev.path ?? "<missing path>";
  check(`evidence has path/symbol/start_line/end_line/observation (${tag})`,
    typeof ev.path === "string" && typeof ev.symbol === "string" &&
    Number.isInteger(ev.start_line) && Number.isInteger(ev.end_line) &&
    typeof ev.observation === "string" && ev.observation.trim().length >= 20);
  const abs = join(ROOT, ev.path);
  const exists = typeof ev.path === "string" && existsSync(abs);
  check(`evidence path exists: ${tag}`, exists);
  if (!exists) continue;
  citedPaths.add(ev.path);

  const lines = readFileSync(abs, "utf8").split("\n");
  check(`range valid: ${tag} ${ev.start_line}-${ev.end_line}`,
    ev.start_line >= 1 && ev.end_line >= ev.start_line && ev.end_line <= lines.length);
  const slice = lines.slice(ev.start_line - 1, ev.end_line).join("\n");
  check(`symbol '${ev.symbol}' occurs inside ${tag}:${ev.start_line}-${ev.end_line}`, slice.includes(ev.symbol));
}

// --- Required paths cited ---------------------------------------------------
for (const p of requiredPaths) {
  check(`required path cited in evidence: ${p}`, citedPaths.has(p));
}

// --- Claims grounded in cited evidence -------------------------------------
const claimCovered = new Set();
for (const [i, c] of (result.claims ?? []).entries()) {
  check(`claim[${i}] is substantive`, typeof c.claim === "string" && c.claim.trim().length >= 40, (c.claim ?? "").slice(0, 60));
  const paths = Array.isArray(c.evidence_paths) ? c.evidence_paths : [];
  check(`claim[${i}] has evidence_paths`, paths.length > 0);
  for (const p of paths) {
    check(`claim[${i}] path exists: ${p}`, existsSync(join(ROOT, p)));
    check(`claim[${i}] path is cited in evidence: ${p}`, citedPaths.has(p));
    claimCovered.add(p);
  }
}
for (const p of requiredPaths) {
  check(`required path covered by a claim: ${p}`, claimCovered.has(p));
}

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
for (const c of checks) process.stdout.write(`${c.pass ? "ok  " : "FAIL"}: ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`);
process.stdout.write(`\n${failed === 0 ? "ALL STATIC CHECKS PASSED" : "STATIC CHECKS FAILED"} (${passed}/${checks.length})\n`);
process.exit(failed === 0 ? 0 : 1);
