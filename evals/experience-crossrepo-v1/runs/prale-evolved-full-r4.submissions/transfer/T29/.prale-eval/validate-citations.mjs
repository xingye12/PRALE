#!/usr/bin/env node
/**
 * Focused validation for T29's `.prale-eval/result.json`.
 *
 * Programmatically verifies the evidence contract:
 *  - required top-level fields exist with the expected values,
 *  - every evidence object has path/symbol/start_line/end_line/observation,
 *  - the inclusive [start_line, end_line] slice of the cited file actually contains
 *    the named symbol,
 *  - every claim names at least one evidence path that exists in `evidence`.
 *
 * This runs with the plain Node.js runtime (no dependencies) so it works even when the
 * repository's node_modules are unavailable.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..");

const failures = [];
const check = (condition, message) => {
	if (!condition) failures.push(message);
};

const resultPath = join(workspace, ".prale-eval", "result.json");
const result = JSON.parse(readFileSync(resultPath, "utf-8"));

check(result.task_id === "T29", `task_id must be "T29", got ${JSON.stringify(result.task_id)}`);
check(result.repository === "pi", `repository must be "pi", got ${JSON.stringify(result.repository)}`);
check(result.mode === "demo", `mode must be "demo", got ${JSON.stringify(result.mode)}`);
check(Array.isArray(result.evidence) && result.evidence.length > 0, "evidence must be a non-empty array");
check(Array.isArray(result.claims) && result.claims.length > 0, "claims must be a non-empty array");
check(typeof result.conclusion === "string" && result.conclusion.length > 0, "conclusion must be a non-empty string");
check(result.validation && typeof result.validation.command === "string", "validation.command must be a string");
check(result.validation && typeof result.validation.status === "string", "validation.status must be a string");
check(result.validation && typeof result.validation.notes === "string", "validation.notes must be a string");

const requiredPaths = ["packages/coding-agent/src/core/resource-loader.ts"];
const evidencePaths = new Set();

for (const [index, entry] of (result.evidence ?? []).entries()) {
	const label = `evidence[${index}]`;
	for (const field of ["path", "symbol", "start_line", "end_line", "observation"]) {
		check(entry[field] !== undefined && entry[field] !== null, `${label} is missing ${field}`);
	}
	if (entry.path === undefined || entry.symbol === undefined) continue;

	evidencePaths.add(entry.path);

	const absolute = join(workspace, entry.path);
	let lines;
	try {
		lines = readFileSync(absolute, "utf-8").split(/\r?\n/);
	} catch (error) {
		failures.push(`${label} cannot read ${entry.path}: ${error.message}`);
		continue;
	}

	const start = entry.start_line;
	const end = entry.end_line;
	check(
		Number.isInteger(start) && Number.isInteger(end),
		`${label} start_line/end_line must be integers`,
	);
	check(start >= 1 && end >= start, `${label} invalid range ${start}-${end}`);
	check(end <= lines.length, `${label} end_line ${end} exceeds file length ${lines.length}`);

	const slice = lines.slice(Math.max(start - 1, 0), end).join("\n");
	// Accept a bare identifier or a dotted qualified name whose final segment appears.
	const leaf = String(entry.symbol).split(".").pop() ?? String(entry.symbol);
	check(
		slice.includes(entry.symbol) || slice.includes(leaf),
		`${label} range ${start}-${end} in ${entry.path} does not contain symbol ${JSON.stringify(entry.symbol)}`,
	);
}

for (const required of requiredPaths) {
	check(evidencePaths.has(required), `missing required evidence entry for ${required}`);
}

for (const [index, claim] of (result.claims ?? []).entries()) {
	const label = `claims[${index}]`;
	check(typeof claim.claim === "string" && claim.claim.length > 0, `${label}.claim must be a non-empty string`);
	check(Array.isArray(claim.evidence_paths) && claim.evidence_paths.length > 0, `${label}.evidence_paths must be non-empty`);
	for (const path of claim.evidence_paths ?? []) {
		check(evidencePaths.has(path), `${label} references evidence path ${path} that is not cited in evidence[]`);
	}
}

if (failures.length > 0) {
	console.error("VALIDATION FAILED");
	for (const failure of failures) console.error(` - ${failure}`);
	process.exit(1);
}

console.log("VALIDATION PASSED");
console.log(` - task_id/repository/mode: ${result.task_id}/${result.repository}/${result.mode}`);
console.log(` - evidence entries: ${result.evidence.length} (verified ranges contain their symbols)`);
console.log(` - claims: ${result.claims.length} (all evidence_paths resolve)`);
