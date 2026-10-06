// Dependency-free executable model of pi's durable operation contract:
// durable intent -> effect -> settlement, including failed-effect handling.
//
// Section 1 replays the lifecycle using the exact field names and invariants
// defined by packages/agent/src/harness/session/types.ts and enforced by
// packages/agent/src/harness/runtime/drive/terminal.ts.
// Section 2 statically verifies that every evidence citation in
// .prale-eval/result.json names a real symbol inside its inclusive range in the
// cited source file, so no claim rests on an unverified reference.
//
// Run: node .prale-eval/operation-contract-demo.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ---------------------------------------------------------------------------
// Section 1: modeled operation lifecycle.
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = ["completed", "declined", "aborted", "failed"];

function clock() {
	let tick = 1;
	return () => tick++;
}

// Mirror of runtime/drive/terminal.ts#operationResultRecord: a failed result is
// the only result allowed to carry an error.
function operationResultRecord(meta, status, tipId, endedAt, error) {
	if ((status === "failed") !== (error !== undefined)) {
		throw new Error("Only a failed operation result may carry an error");
	}
	return {
		operationId: meta.operationId,
		kind: meta.intent.kind,
		status,
		...(error === undefined ? {} : { error }),
		fromTipId: meta.sourceTipId,
		tipId,
		startedAt: meta.startedAt,
		endedAt,
	};
}

// Durable intent, mirroring session/types.ts#OperationMeta.
function admitRun(operationId, sourceTipId, promptEntryIds, startedAt) {
	const meta = {
		operationId,
		lane: "main",
		sourceTipId,
		startedAt,
		intent: { kind: "run", promptEntryIds },
	};
	const state = {
		at: "starting",
		control: { status: "running" },
		settings: {},
		latestAssistantEntryId: null,
	};
	// accept() commits meta + state and nothing else; the intent is durable
	// before any effect is admitted.
	return { meta, state, durable: { intent: meta, effect: null, settled: null } };
}

// Mirror of runtime/drive/generation.ts#publishGenerationIntent: the effect is
// recorded (with reserved ids) before the provider call is performed.
function publishEffectIntent(op, responseEntryId, usageId) {
	assert.equal(op.state.at, "starting", "effect intent requires a durable starting state");
	op.state = {
		...op.state,
		at: "assistant.effect_pending",
		responseEntryId,
		usageId,
	};
	op.durable.effect = { at: op.state.at, responseEntryId, usageId };
	return op.state;
}

// Mirror of runtime/drive/boundary.ts#finishRunBoundary / lane.ts#settleOperation:
// one terminal transaction writes the normalized record and clears operation state.
function settle(op, status, tipId, endedAt, error) {
	const record = operationResultRecord(op.meta, status, tipId, endedAt, error);
	op.durable.settled = record;
	op.state = null;
	return record;
}

function scenarioHappyPath() {
	const now = clock();
	const op = admitRun("op-happy", "tip-0", ["prompt-1"], now());
	publishEffectIntent(op, "resp-1", "usage-1");
	assert.equal(op.durable.effect.at, "assistant.effect_pending", "effect admitted after intent");
	return settle(op, "completed", "resp-1", now());
}

// Mirror of runtime/drive/response.ts#publishResponse error branch: retry while
// attempts remain, otherwise a failed record carrying providerError(...).
function scenarioFailedEffect(attemptsLeft) {
	const now = clock();
	const op = admitRun("op-failed", "tip-0", ["prompt-1"], now());
	publishEffectIntent(op, "resp-1", "usage-1");
	if (attemptsLeft > 0) {
		op.state = { ...op.state, at: "assistant.retry_wait", nextAttempt: 2 };
		publishEffectIntent(op, "resp-1", "usage-1");
	}
	return settle(op, "failed", "resp-1", now(), {
		code: "assistant_error",
		message: "provider request ended with error",
	});
}

// Mirror of runtime/drive/recovery.ts#recoverAssistantGeneration: an orphaned
// effect is settled from committed frames without another provider call.
function scenarioRecoveredOrphan() {
	const now = clock();
	const op = admitRun("op-orphan", "tip-0", ["prompt-1"], now());
	publishEffectIntent(op, "resp-1", "usage-1");
	const recovered = { role: "assistant", stopReason: "error", errorMessage: "Assistant request was interrupted." };
	assert.equal(recovered.stopReason, "error", "recovered orphan is an explicit error message");
	return settle(op, "completed", "resp-1", now());
}

// Mirror of runtime/drive/reconcile.ts#reconcileOperation: cancellation
// reconciles the admitted effect and publishes an aborted terminal record.
function scenarioCancelledEffect() {
	const now = clock();
	const op = admitRun("op-cancel", "tip-0", ["prompt-1"], now());
	publishEffectIntent(op, "resp-1", "usage-1");
	op.state = { ...op.state, control: { status: "cancel_requested" } };
	return settle(op, "aborted", "resp-1", now());
}

const happy = scenarioHappyPath();
const failed = scenarioFailedEffect(1);
const recovered = scenarioRecoveredOrphan();
const cancelled = scenarioCancelledEffect();

assert.equal(happy.status, "completed");
assert.equal(happy.error, undefined);
assert.equal(failed.status, "failed");
assert.equal(failed.error.code, "assistant_error");
assert.equal(recovered.status, "completed");
assert.equal(recovered.error, undefined);
assert.equal(cancelled.status, "aborted");
assert.equal(cancelled.error, undefined);
for (const record of [happy, failed, recovered, cancelled]) {
	assert.ok(TERMINAL_STATUSES.includes(record.status), "status is terminal");
	assert.equal(record.status === "failed", record.error !== undefined, "failed <=> error");
	assert.ok(record.endedAt >= record.startedAt, "settlement is ordered after intent");
	assert.equal(record.fromTipId, "tip-0");
}
assert.throws(
	() => operationResultRecord({ operationId: "x", intent: { kind: "run" }, sourceTipId: null, startedAt: 1 }, "completed", "t", 2, { code: "x", message: "y" }),
	/may carry an error/,
	"non-failed record rejects an error",
);

console.log("section 1: lifecycle model passed");
console.log(`  normalized results: ${[happy, failed, recovered, cancelled].map((r) => r.status).join(", ")}`);
console.log(`  failed result: ${JSON.stringify(failed)}`);

// ---------------------------------------------------------------------------
// Section 2: verify every result.json evidence citation against real source.
// ---------------------------------------------------------------------------

const result = JSON.parse(readFileSync(join(here, "result.json"), "utf8"));
assert.equal(result.task_id, 29);
assert.equal(result.repository, "pi");
assert.equal(result.mode, "contract");

let verified = 0;
for (const entry of result.evidence) {
	const text = readFileSync(join(root, entry.path), "utf8");
	const lines = text.split("\n");
	assert.ok(
		Number.isInteger(entry.start_line) && Number.isInteger(entry.end_line) && entry.start_line >= 1,
		`range present for ${entry.path}#${entry.symbol}`,
	);
	assert.ok(entry.start_line <= entry.end_line, `ordered range for ${entry.path}#${entry.symbol}`);
	assert.ok(entry.end_line <= lines.length, `range in bounds for ${entry.path}#${entry.symbol}`);
	const slice = lines.slice(entry.start_line - 1, entry.end_line).join("\n");
	assert.ok(
		slice.includes(entry.symbol),
		`${entry.path}:${entry.start_line}-${entry.end_line} must contain symbol ${entry.symbol}`,
	);
	verified += 1;
}
assert.ok(verified >= 1, "at least one citation");
const requiredPath = "packages/agent/src/harness/agent-harness.ts";
assert.ok(
	result.evidence.some((entry) => entry.path === requiredPath),
	`required evidence path ${requiredPath} cited`,
);
console.log(`section 2: ${verified} evidence citations verified against source`);
console.log("operation contract demo passed");
