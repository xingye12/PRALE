/**
 * Focused static validator for `.prale-eval/result.json`.
 *
 * Checks, without any external dependency:
 *   - TASK.md metadata (repository key / mode) and result task_id are coherent;
 *   - every required field is present with the right shape;
 *   - each evidence entry names a real file, a valid inclusive range, and a
 *     symbol that actually occurs inside that range;
 *   - every required source path is cited in `evidence` and covered by at
 *     least one claim whose `evidence_paths` names it;
 *   - every claim's `evidence_paths` are themselves cited in `evidence`.
 *
 * Usage: node ./.prale-eval/verify-citations.mjs
 */

import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const TASK = readFileSync(new URL("TASK.md", ROOT), "utf8");
const RESULT = JSON.parse(readFileSync(new URL(".prale-eval/result.json", ROOT), "utf8"));

const REQUIRED_PATHS = [
  "MemoryCore/src/core/index.ts",
  "sdk/memory-core/typescript/src/http.ts",
];

const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const taskRepo = TASK.match(/Repository key:\s*`([^`]+)`/)?.[1];
const taskMode = TASK.match(/Task mode:\s*`([^`]+)`/)?.[1];
const taskId = Number(TASK.match(/"task_id"\s+exactly\s+`(\d+)`/) ? TASK.match(/task_id`?\s+exactly\s+`(\d+)`/)?.[1] : NaN);

check("TASK.md repository key is tdam", taskRepo === "tdam");
check("TASK.md mode is demo", taskMode === "demo");
check("result.task_id is a number", Number.isInteger(RESULT.task_id));
check("result.task_id matches TASK.md", RESULT.task_id === 30);
check("result.repository is tdam", RESULT.repository === "tdam");
check("result.mode is demo", RESULT.mode === "demo");
check("evidence is non-empty", Array.isArray(RESULT.evidence) && RESULT.evidence.length > 0);
check("claims is non-empty", Array.isArray(RESULT.claims) && RESULT.claims.length > 0);
check("conclusion present", typeof RESULT.conclusion === "string" && RESULT.conclusion.length > 0);
check("validation.command present", typeof RESULT.validation?.command === "string");
check("validation.status present", typeof RESULT.validation?.status === "string");
check("validation.notes present", typeof RESULT.validation?.notes === "string");

const lineCounts = new Map();
const readLines = (path) => {
  if (!lineCounts.has(path)) {
    const lines = readFileSync(new URL(path, ROOT), "utf8").split("\n");
    lineCounts.set(path, lines);
  }
  return lineCounts.get(path);
};

const citedPaths = new Set();

for (const entry of RESULT.evidence) {
  const tag = entry.path ?? "<missing path>";
  for (const field of ["path", "symbol", "start_line", "end_line", "observation"]) {
    check(`evidence entry has '${field}' (${tag})`, entry[field] !== undefined);
  }
  if (typeof entry.path !== "string") continue;
  check(`evidence path exists: ${entry.path}`, existsSync(new URL(entry.path, ROOT)));
  if (!existsSync(new URL(entry.path, ROOT))) continue;
  citedPaths.add(entry.path);

  const lines = readLines(entry.path);
  const start = entry.start_line;
  const end = entry.end_line;
  check(
    `range valid ${entry.path} ${start}-${end}`,
    Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length,
  );
  if (!(start >= 1 && end >= start && end <= lines.length)) continue;

  const slice = lines.slice(start - 1, end).join("\n");
  check(
    `symbol ${entry.symbol} inside ${entry.path}:${start}-${end}`,
    typeof entry.symbol === "string" && slice.includes(entry.symbol),
  );
  check(
    `substantive observation for ${entry.symbol}`,
    typeof entry.observation === "string" && entry.observation.trim().length >= 40,
  );
}

for (const path of REQUIRED_PATHS) {
  check(`required path cited in evidence: ${path}`, citedPaths.has(path));
}

for (const claim of RESULT.claims) {
  check("claim is substantive", typeof claim.claim === "string" && claim.claim.trim().length >= 40);
  const paths = Array.isArray(claim.evidence_paths) ? claim.evidence_paths : [];
  check("claim has evidence_paths", paths.length > 0);
  for (const path of paths) {
    check(`claim path exists: ${path}`, existsSync(new URL(path, ROOT)));
    check(`claim path is cited in evidence: ${path}`, citedPaths.has(path));
  }
}

for (const path of REQUIRED_PATHS) {
  check(
    `required path covered by a claim: ${path}`,
    RESULT.claims.some((claim) => (claim.evidence_paths ?? []).includes(path)),
  );
}

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? "ok  " : "FAIL"}: ${entry.name}`);
}
console.log(`\n${failed.length} CHECK(S) FAILED (${checks.length} total)`);
if (failed.length > 0) process.exitCode = 1;
