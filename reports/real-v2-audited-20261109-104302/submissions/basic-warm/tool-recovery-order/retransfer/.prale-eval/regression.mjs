/**
 * Regression for tool-recovery-order/retransfer.
 *
 * Drives the real `recoverToolInvocation` from
 * packages/agent/src/harness/runtime/drive/tools.ts through .prale-eval/subject.mjs.
 * Only checkpoint IO, tool execution and outcome publication are boundary fakes,
 * so every assertion below is about production control flow.
 *
 * Invariants under test:
 *  1. A cancelled drive must not clear the replay checkpoint or invoke the tool,
 *     even when both the durable call and the tool are declared replay: "safe".
 *     It must publish interrupted evidence built from the durable checkpoint.
 *  2. A non-cancelled replay-safe call must still clear its checkpoint, invoke the
 *     tool exactly once, and settle the outcome after that effect completes.
 */
import assert from "node:assert/strict";
import { createRecoverySubject } from "./subject.mjs";

const INTERRUPTION_PREFIX = "[Tool execution was interrupted.";
const ABORTED_TEXT = "Tool execution was cancelled before completion.";

/** Cross-realm values (message objects built inside the VM) are normalized to this realm. */
const host = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const texts = (message) => host(message.content).map((part) => part.text);
const countOf = (events, name) => events.filter((event) => event === name).length;

/** Publish order proves the outcome settles only after the recovered effect completed. */
function assertSettledAfterEffect(events) {
	assert.deepEqual(events, ["clear", "invoke", "effect-complete", "publish"], "replay must run once and settle after completion");
}

function assertInterruptedEvidence(outcome) {
	assert.ok(outcome, "a cancelled recovery must publish an outcome instead of running the tool");
	const message = host(outcome.message);
	assert.equal(message.role, "toolResult", "interrupted evidence must be a tool result message");
	assert.equal(message.toolCallId, "call-1", "interrupted evidence must answer the same tool call");
	assert.equal(message.toolName, "fixture-tool", "interrupted evidence must name the same tool");
	assert.equal(outcome.terminate, false, "an interrupted tool must not terminate the run");

	const parts = texts(outcome.message);
	assert.equal(parts.length, 2, "interrupted evidence must keep the durable snapshot and append one marker");
	assert.equal(parts[0], "durable-progress", "the durable checkpoint snapshot must be preserved as evidence");
	assert.ok(parts[1].startsWith(INTERRUPTION_PREFIX), `expected interruption marker, received ${JSON.stringify(parts[1])}`);
	assert.equal(message.isError, true, "interrupted evidence must be marked as an error result");
	assert.notDeepEqual(parts, [ABORTED_TEXT], "cancelled recovery must publish interrupted evidence, not a bare abort");
	assert.deepEqual(host(message.details), { step: 2 }, "checkpoint details must survive into the interrupted evidence");
	return message;
}

const root = process.cwd();
const recover = await createRecoverySubject(root);
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("cancelled replay-safe call neither clears nor invokes", async () => {
	const { events, outcome } = await recover("safe", "safe", true);
	assert.equal(countOf(events, "clear"), 0, "cancelled recovery must not clear the replay checkpoint");
	assert.equal(countOf(events, "invoke"), 0, "cancelled recovery must not invoke the tool");
	assert.equal(countOf(events, "effect-complete"), 0, "cancelled recovery must not run the tool effect");
	assert.equal(countOf(events, "publish"), 1, "cancelled recovery must still publish exactly one outcome");
	assert.deepEqual(events, ["read", "publish"], "cancelled recovery must only read the checkpoint and publish evidence");
	assertInterruptedEvidence(outcome);
});

check("cancelled replay-safe call publishes interrupted evidence repeatedly", async () => {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const { events, outcome } = await recover("safe", "safe", true);
		assert.deepEqual(events, ["read", "publish"], `attempt ${attempt + 1} must not retransfer a cancelled effect`);
		assertInterruptedEvidence(outcome);
	}
});

check("cancelled recovery with one-sided replay safety stays interrupted", async () => {
	for (const [callPolicy, toolPolicy, label] of [
		["safe", "never", "safe call / unsafe tool"],
		["never", "safe", "unsafe call / safe tool"],
		["safe", null, "safe call / tool without policy"],
		["safe", undefined, "safe call / absent tool"],
	]) {
		const { events, outcome } = await recover(callPolicy, toolPolicy, true);
		assert.equal(countOf(events, "clear"), 0, `${label}: cancelled recovery must not clear the checkpoint`);
		assert.equal(countOf(events, "invoke"), 0, `${label}: cancelled recovery must not invoke the tool`);
		assert.deepEqual(events, ["read", "publish"], `${label}: cancelled recovery must publish interrupted evidence`);
		assertInterruptedEvidence(outcome);
	}
});

check("non-cancelled replay-safe call clears, invokes once and settles", async () => {
	const { events, outcome } = await recover("safe", "safe", false);
	assertSettledAfterEffect(events);
	assert.equal(countOf(events, "invoke"), 1, "a live replay-safe call must replay exactly once");
	assert.equal(countOf(events, "publish"), 1, "a live replay-safe call must settle exactly one outcome");
	assert.ok(outcome, "a live replay-safe call must settle an outcome after completion");

	const message = host(outcome.message);
	assert.equal(message.isError, false, "a successful replay must settle as a non-error result");
	assert.equal(outcome.terminate, false, "a successful replay must not terminate the run");
	assert.deepEqual(texts(outcome.message), ["effect-result"], "the replayed effect result must be the settled outcome");
	assert.equal(message.details, undefined, "a live replay must not invent checkpoint details");
});

check("non-cancelled unsafe call keeps checkpoint as interrupted evidence", async () => {
	const { events, outcome } = await recover("never", "never", false);
	assert.deepEqual(events, ["read", "publish"], "a non-replayable call must not be retransferred");
	assertInterruptedEvidence(outcome);
});

let failures = 0;
for (const { name, fn } of checks) {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}
assert.equal(failures, 0, `${failures} regression check(s) failed`);
console.log(`\n${checks.length} recovery-order checks passed`);
