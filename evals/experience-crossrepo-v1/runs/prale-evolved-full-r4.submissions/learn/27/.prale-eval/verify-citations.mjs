#!/usr/bin/env node
/**
 * verify-citations.mjs — focused static validation for task learn/27.
 *
 * Confirms that .prale-eval/result.json matches the current TASK.md contract and
 * that every cited symbol really appears inside its inclusive line range.
 *
 * Run: node .prale-eval/verify-citations.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url); // workspace root (file:// .../workspace/)
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const checks = [];
const check = (ok, label) => {
  checks.push({ ok, label });
  console.log(`${ok ? "ok  " : "FAIL"}: ${label}`);
};

const result = JSON.parse(read(".prale-eval/result.json"));
const task = read("TASK.md");

check(task.includes("`tdam`"), "TASK.md repository key is tdam");
check(task.includes("Task mode: `demo`"), "TASK.md mode is demo");
check(result.task_id === 27, "result.task_id === 27");
check(result.repository === "tdam", "result.repository === tdam");
check(result.mode === "demo", "result.mode === demo");

check(Array.isArray(result.evidence) && result.evidence.length > 0, "evidence is non-empty");
check(Array.isArray(result.claims) && result.claims.length > 0, "claims is non-empty");
check(typeof result.conclusion === "string" && result.conclusion.length > 0, "conclusion present");
check(result.validation && typeof result.validation.command === "string", "validation.command present");
check(result.validation && typeof result.validation.status === "string", "validation.status present");
check(result.validation && typeof result.validation.notes === "string", "validation.notes present");

const REQUIRED = [
  "MemoryKnowledge/src/engines/code/normalize.ts",
  "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts",
];

const citedPaths = new Set();
for (const ev of result.evidence) {
  for (const key of ["path", "symbol", "start_line", "end_line", "observation"]) {
    check(key in ev, `evidence entry has '${key}' (${ev.path ?? "?"})`);
  }
  const filePath = new URL(ev.path, root);
  check(existsSync(filePath), `evidence path exists: ${ev.path}`);
  if (!existsSync(filePath)) continue;
  const allLines = readFileSync(filePath, "utf8").split(/\r?\n/);
  check(
    Number.isInteger(ev.start_line) && Number.isInteger(ev.end_line) &&
      ev.start_line >= 1 && ev.end_line >= ev.start_line && ev.end_line <= allLines.length,
    `range valid ${ev.path} ${ev.start_line}-${ev.end_line}`,
  );
  const slice = allLines.slice(ev.start_line - 1, ev.end_line).join("\n");
  check(slice.includes(ev.symbol), `symbol ${ev.symbol} inside ${ev.path}:${ev.start_line}-${ev.end_line}`);
  check(typeof ev.observation === "string" && ev.observation.length >= 40, `substantive observation for ${ev.symbol}`);
  citedPaths.add(ev.path);
}

for (const req of REQUIRED) {
  check(citedPaths.has(req), `required path cited in evidence: ${req}`);
}

const claimCovered = new Set();
for (const claim of result.claims) {
  check(typeof claim.claim === "string" && claim.claim.length >= 40, "claim is substantive");
  check(Array.isArray(claim.evidence_paths) && claim.evidence_paths.length > 0, "claim has evidence_paths");
  for (const p of claim.evidence_paths ?? []) {
    check(existsSync(new URL(p, root)), `claim path exists: ${p}`);
    check(citedPaths.has(p), `claim path is cited in evidence: ${p}`);
    claimCovered.add(p);
  }
}
for (const req of REQUIRED) {
  check(claimCovered.has(req), `required path covered by a claim: ${req}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? "ALL STATIC CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${checks.length} total)`);
process.exitCode = failed.length === 0 ? 0 : 1;
