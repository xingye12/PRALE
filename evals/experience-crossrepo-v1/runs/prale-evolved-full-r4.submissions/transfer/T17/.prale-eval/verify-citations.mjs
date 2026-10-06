#!/usr/bin/env node
/**
 * Focused static validator for the T17 contract artifacts.
 *
 *   node .prale-eval/verify-citations.mjs
 *
 * Checks (against the CURRENT TASK.md, which is authoritative):
 *   - result.json task_id / repository / mode exactly match TASK.md.
 *   - evidence entries are well-formed, their file exists, and the named
 *     symbol textually occurs inside the cited inclusive line range.
 *   - every required_source path from TASK.md is cited and covered by a claim.
 *   - claims are substantive, name existing paths, and every path a claim
 *     names is itself cited in evidence.
 *   - validation.command / validation.status / validation.notes present.
 *   - the required deliverable markdown exists.
 *
 * Exit code 0 iff all checks pass.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RESULT = resolve(__dirname, "result.json");

let failures = 0;
const check = (cond, label) => {
  if (cond) {
    console.log(`ok  : ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}`);
  }
};

const taskText = readFileSync(resolve(ROOT, "TASK.md"), "utf-8");
const taskId = (taskText.match(/task_id\s+exactly\s+`([^`]+)`/) || taskText.match(/`task_id` exactly `([^`]+)`/) || [])[1];
const mode = (taskText.match(/Task mode:\s*`([^`]+)`/) || [])[1];
const repository = (taskText.match(/Repository key:\s*`([^`]+)`/) || [])[1];

console.log(`TASK.md: task_id=${taskId} repository=${repository} mode=${mode}`);

const required = [...taskText.matchAll(/^- `([^`]+\.ts)`$/gm)].map((m) => m[1]);
console.log(`required source paths: ${JSON.stringify(required)}`);

check(existsSync(RESULT), "result.json exists");
const result = JSON.parse(readFileSync(RESULT, "utf-8"));

check(result.task_id === taskId, `result.task_id === ${taskId}`);
check(result.repository === repository, `result.repository === ${repository}`);
check(result.mode === mode, `result.mode === ${mode}`);
check(Array.isArray(result.evidence) && result.evidence.length > 0, "evidence is a non-empty list");
check(Array.isArray(result.claims) && result.claims.length > 0, "claims is a non-empty list");
check(typeof result.conclusion === "string" && result.conclusion.trim().length > 0, "conclusion is a non-empty string");
check(result.validation && typeof result.validation === "object", "validation object present");
check(typeof result.validation?.command === "string" && result.validation.command.length > 0, "validation.command present");
check(typeof result.validation?.status === "string" && result.validation.status.length > 0, "validation.status present");
check(typeof result.validation?.notes === "string" && result.validation.notes.length > 0, "validation.notes present");

const citedPaths = new Set();

for (const [i, ev] of result.evidence.entries()) {
  const tag = `evidence[${i}] ${ev?.path ?? "?"}#${ev?.symbol ?? "?"}`;
  check(typeof ev?.path === "string" && ev.path.length > 0, `${tag} has path`);
  check(typeof ev?.symbol === "string" && ev.symbol.length > 0, `${tag} has symbol`);
  check(Number.isInteger(ev?.start_line) && ev.start_line >= 1, `${tag} has start_line`);
  check(Number.isInteger(ev?.end_line) && ev.end_line >= ev.start_line, `${tag} has end_line`);
  check(typeof ev?.observation === "string" && ev.observation.trim().length >= 20, `${tag} has substantive observation`);

  const abs = resolve(ROOT, ev.path);
  check(existsSync(abs), `evidence path exists: ${ev.path}`);
  if (!existsSync(abs)) continue;
  citedPaths.add(ev.path);

  const lines = readFileSync(abs, "utf-8").split("\n");
  check(ev.end_line <= lines.length, `range within file (${ev.path}:${ev.start_line}-${ev.end_line})`);
  const window = lines.slice(ev.start_line - 1, ev.end_line).join("\n");
  check(window.includes(ev.symbol), `symbol "${ev.symbol}" occurs inside ${ev.path}:${ev.start_line}-${ev.end_line}`);
}

for (const path of required) {
  check(citedPaths.has(path), `required path cited in evidence: ${path}`);
}

const claimedPaths = new Set();
for (const [i, claim] of result.claims.entries()) {
  const tag = `claims[${i}]`;
  check(typeof claim?.claim === "string" && claim.claim.trim().length >= 20, `${tag} is substantive`);
  check(Array.isArray(claim?.evidence_paths) && claim.evidence_paths.length > 0, `${tag} names evidence_paths`);
  for (const p of claim?.evidence_paths ?? []) {
    claimedPaths.add(p);
    check(existsSync(resolve(ROOT, p)), `claim path exists: ${p}`);
    check(citedPaths.has(p), `claim path is cited in evidence: ${p}`);
  }
}

for (const path of required) {
  check(claimedPaths.has(path), `required path covered by a claim: ${path}`);
}

const deliverable = resolve(__dirname, "contract-deliverable.md");
check(existsSync(deliverable), "contract-deliverable.md exists");
if (existsSync(deliverable)) {
  const md = readFileSync(deliverable, "utf-8");
  for (const path of required) {
    check(md.includes(path), `contract-deliverable.md references required path: ${path}`);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
