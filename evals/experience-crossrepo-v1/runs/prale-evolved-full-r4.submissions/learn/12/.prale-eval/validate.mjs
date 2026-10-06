#!/usr/bin/env node
/**
 * Focused validator for the task-12 contract deliverable.
 *
 * Checks, without any third-party dependency:
 *   - result.json metadata (task_id/repository/mode) and required keys,
 *   - every `evidence` citation: the file exists, start<=end, and the named
 *     symbol literally occurs inside the cited inclusive line range,
 *   - the two cross-repo contract paths have at least one evidence entry,
 *   - every `claim` names the paths in its `evidence_paths`, those paths exist,
 *     and each contract path appears in at least one claim,
 *   - the fixture is valid JSON encoding a *malformed* error envelope,
 *   - the requested deliverable files exist.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const resultPath = join(repoRoot, ".prale-eval", "result.json");

const REQUIRED_PATHS = [
  "sdk/memory-core/typescript/src/v3/http.ts",
  "sdk/memory-core/typescript/src/errors.ts",
];
const FIXTURE = "sdk/memory-core/typescript/tests/fixtures/malformed-error-envelope.json";
const DEMO = "sdk/memory-core/typescript/tests/run-malformed-envelope-demo.mjs";

const failures = [];
const ok = (msg) => console.log(`  ok  - ${msg}`);
const bad = (msg) => {
  failures.push(msg);
  console.log(`  FAIL- ${msg}`);
};

const raw = readFileSync(resultPath, "utf8");
const result = JSON.parse(raw);

// --- metadata -------------------------------------------------------------
if (result.task_id === 12) ok("task_id === 12"); else bad(`task_id is ${JSON.stringify(result.task_id)}`);
if (result.repository === "tdam") ok("repository === tdam"); else bad(`repository is ${JSON.stringify(result.repository)}`);
if (result.mode === "contract") ok("mode === contract"); else bad(`mode is ${JSON.stringify(result.mode)}`);

for (const key of ["evidence", "claims", "conclusion", "validation"]) {
  if (result[key] === undefined) bad(`missing key: ${key}`);
}
if (typeof result.conclusion !== "string" || !result.conclusion.trim()) bad("conclusion must be a non-empty string");
if (typeof result.validation !== "object" || result.validation === null) bad("validation must be an object");
else for (const k of ["command", "status", "notes"]) {
  if (!(k in result.validation)) bad(`validation missing ${k}`);
}

// --- evidence citations ---------------------------------------------------
const lineCache = new Map();
const linesOf = (rel) => {
  if (!lineCache.has(rel)) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return null;
    lineCache.set(rel, readFileSync(abs, "utf8").split(/\r?\n/));
  }
  return lineCache.get(rel);
};

const evidencePaths = new Set();
if (Array.isArray(result.evidence)) {
  result.evidence.forEach((ev, i) => {
    const tag = `evidence[${i}]`;
    for (const k of ["path", "symbol", "start_line", "end_line", "observation"]) {
      if (!(k in ev)) bad(`${tag} missing ${k}`);
    }
    const lines = linesOf(ev.path);
    if (!lines) {
      bad(`${tag} path not found: ${ev.path}`);
      return;
    }
    evidencePaths.add(ev.path);
    if (!(Number.isInteger(ev.start_line) && Number.isInteger(ev.end_line))) {
      bad(`${tag} start/end must be integers`);
      return;
    }
    if (ev.start_line < 1 || ev.end_line < ev.start_line || ev.end_line > lines.length) {
      bad(`${tag} invalid range ${ev.start_line}-${ev.end_line} for ${ev.path} (${lines.length} lines)`);
      return;
    }
    const slice = lines.slice(ev.start_line - 1, ev.end_line).join("\n");
    if (!slice.includes(ev.symbol)) {
      bad(`${tag} symbol ${JSON.stringify(ev.symbol)} not found in ${ev.path}:${ev.start_line}-${ev.end_line}`);
    } else {
      ok(`${tag} ${ev.path} :: ${ev.symbol} [${ev.start_line}-${ev.end_line}]`);
    }
    if (!String(ev.observation ?? "").trim()) bad(`${tag} observation is empty`);
  });
} else {
  bad("evidence must be an array");
}

for (const p of REQUIRED_PATHS) {
  if (evidencePaths.has(p)) ok(`contract path cited in evidence: ${p}`);
  else bad(`contract path missing from evidence: ${p}`);
}

// --- claims ---------------------------------------------------------------
const claimedPaths = new Set();
if (Array.isArray(result.claims)) {
  result.claims.forEach((c, i) => {
    const tag = `claims[${i}]`;
    if (typeof c.claim !== "string" || !c.claim.trim()) bad(`${tag} claim must be a non-empty string`);
    if (!Array.isArray(c.evidence_paths) || c.evidence_paths.length === 0) {
      bad(`${tag} evidence_paths must be a non-empty array`);
      return;
    }
    for (const p of c.evidence_paths) {
      if (!existsSync(join(repoRoot, p))) bad(`${tag} evidence_path does not exist: ${p}`);
      claimedPaths.add(p);
    }
    ok(`${tag} claim grounded in ${c.evidence_paths.length} path(s)`);
  });
} else {
  bad("claims must be an array");
}

for (const p of REQUIRED_PATHS) {
  if (claimedPaths.has(p)) ok(`contract path named by >=1 claim: ${p}`);
  else bad(`no claim names contract path: ${p}`);
}

// --- fixture sanity -------------------------------------------------------
if (existsSync(join(repoRoot, FIXTURE))) {
  const fixture = JSON.parse(readFileSync(join(repoRoot, FIXTURE), "utf8"));
  const body = JSON.parse(fixture.body);
  const malformed = typeof body.code !== "number" || !body.message || typeof body.data !== "object";
  if (malformed) ok("fixture body is a malformed error envelope (code/message/data off-spec)");
  else bad("fixture body does not look malformed");
  if (fixture.http?.status >= 400) ok(`fixture carries an HTTP error status (${fixture.http.status})`);
  else bad("fixture must carry an HTTP error status");
  if (fixture.expected_error?.name === "TDAMError") ok("fixture pins the TDAMError contract");
  else bad("fixture expected_error must name TDAMError");
} else {
  bad(`fixture missing: ${FIXTURE}`);
}

// --- requested deliverables ----------------------------------------------
for (const rel of [".prale-eval/contract-deliverable.md", DEMO]) {
  if (existsSync(join(repoRoot, rel))) ok(`deliverable present: ${rel}`);
  else bad(`deliverable missing: ${rel}`);
}

console.log("");
if (failures.length) {
  console.log(`FAILED (${failures.length})`);
  process.exit(1);
}
console.log(`PASSED: ${result.evidence.length} evidence entries, ${result.claims.length} claims`);
