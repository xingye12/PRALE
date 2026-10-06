/**
 * Supporting citation check for .prale-eval/result.json (T06 / tdam / contract).
 *
 * Verifies, against the real workspace files, that:
 *   - task_id / repository / mode are exactly T06 / tdam / contract;
 *   - every evidence path exists and each cited symbol really occurs inside the
 *     inclusive [start_line, end_line] range (1-based, range inside the file);
 *   - the cross-repo evidence contract's required path is cited at least once;
 *   - every claim is non-empty and names evidence paths that are all cited.
 *
 * Run:  node .prale-eval/validate-evidence.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const HERE = new URL("./", import.meta.url);
const ROOT = new URL("../", HERE);
const REQUIRED_PATH = "sdk/memory-core/typescript/src/v3/metadata-client.ts";

const result = JSON.parse(readFileSync(new URL("result.json", HERE), "utf8"));

assert.equal(result.task_id, "T06", "task_id must be T06");
assert.equal(result.repository, "tdam", "repository must be tdam");
assert.equal(result.mode, "contract", "mode must be contract");

const read = (path) => {
  const url = new URL(path, ROOT);
  assert.ok(existsSync(url), `evidence path does not exist: ${path}`);
  return readFileSync(url, "utf8").split(/\r?\n/);
};

const problems = [];
const citedPaths = new Set();

for (const [i, entry] of result.evidence.entries()) {
  const label = `evidence[${i}] ${entry.path} :: ${entry.symbol}`;
  const { path, symbol, start_line: start, end_line: end, observation } = entry;
  for (const key of ["path", "symbol", "start_line", "end_line", "observation"]) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === "") {
      problems.push(`${label}: missing ${key}`);
    }
  }
  if (typeof observation !== "string" || observation.trim().length < 40) {
    problems.push(`${label}: observation is not substantive`);
  }
  const lines = read(path);
  citedPaths.add(path);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    problems.push(`${label}: invalid range ${start}-${end} (file has ${lines.length} lines)`);
    continue;
  }
  const window = lines.slice(start - 1, end).join("\n");
  if (!window.includes(symbol)) {
    problems.push(`${label}: symbol not found in lines ${start}-${end}`);
  }
}

assert.ok(citedPaths.has(REQUIRED_PATH), `required path not cited: ${REQUIRED_PATH}`);

for (const [i, claim] of result.claims.entries()) {
  const label = `claims[${i}]`;
  if (typeof claim.claim !== "string" || claim.claim.trim().length < 40) {
    problems.push(`${label}: claim is not substantive`);
  }
  const paths = claim.evidence_paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    problems.push(`${label}: evidence_paths is empty`);
    continue;
  }
  if (!paths.includes(REQUIRED_PATH)) {
    problems.push(`${label}: does not cite the required path ${REQUIRED_PATH}`);
  }
  for (const p of paths) {
    if (!citedPaths.has(p)) problems.push(`${label}: uncited evidence path ${p}`);
    if (!existsSync(new URL(p, ROOT))) problems.push(`${label}: evidence path does not exist ${p}`);
  }
}

for (const key of ["conclusion", "validation"]) {
  if (!result[key]) problems.push(`missing top-level ${key}`);
}
for (const key of ["command", "status", "notes"]) {
  if (!result.validation?.[key]) problems.push(`validation.${key} missing`);
}

if (problems.length) {
  console.error("EVIDENCE CONTRACT FAILED:");
  for (const p of problems) console.error(" -", p);
  process.exit(1);
}

console.log(
  `EVIDENCE CONTRACT OK: task_id=${result.task_id} repository=${result.repository} mode=${result.mode} ` +
    `evidence=${result.evidence.length} claims=${result.claims.length} required_path_cited=${citedPaths.has(REQUIRED_PATH)}`,
);
