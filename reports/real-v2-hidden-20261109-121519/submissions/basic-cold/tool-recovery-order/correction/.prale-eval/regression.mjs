/**
 * Regression: a recovered tool call whose stored call policy and live tool
 * declaration are both "safe" must replay exactly once when the operation was
 * not cancelled. The old checkpoint must be cleared before the invocation and
 * the resulting outcome published only after the invocation completes.
 * Unsafe, missing, and cancelled declarations must still only produce the
 * interrupted outcome without touching the tool.
 *
 * Standalone: `node --experimental-vm-modules .prale-eval/regression.mjs`
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRecoverySubject } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");
const recover = await createRecoverySubject(root);

const INTERRUPTION_MARKER =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

// Message/content objects are created inside the loaded VM context, so normalize
// them before strict deep comparison (structure matters, realm-local prototypes do not).
const plain = (value) => JSON.parse(JSON.stringify(value));

const REPLAY_EVENTS = ["clear", "invoke", "effect-complete", "publish"];
const INTERRUPTED_EVENTS = ["read", "publish"];

function assertReplayed(result, label) {
	const { events, outcome } = result;
	assert.deepEqual(events, REPLAY_EVENTS, `${label}: expected clear -> invoke -> publish exactly once, got ${events}`);
	assert.ok(outcome, `${label}: expected a published outcome`);
	assert.equal(outcome.message.isError, false, `${label}: replayed tool result must not be a synthetic error`);
	assert.deepEqual(
		plain(outcome.message.content),
		[{ type: "text", text: "effect-result" }],
		`${label}: expected the real invocation result to be published`,
	);
	assert.equal(
		outcome.message.content.some(
			(part) => typeof part.text === "string" && part.text.includes(INTERRUPTION_MARKER),
		),
		false,
		`${label}: replayed outcome must not carry the interruption marker`,
	);
	// The cleared call (arguments restored by clearing the checkpoint) is what got invoked.
	assert.deepEqual(outcome.args, { persisted: 42 }, `${label}: invocation must receive the cleared checkpoint args`);
	assert.equal(outcome.recovery, true, `${label}: replay must remain a recovery invocation`);
}

function assertInterrupted(result, label) {
	const { events, outcome } = result;
	assert.deepEqual(
		events,
		INTERRUPTED_EVENTS,
		`${label}: must not clear the checkpoint or re-invoke the tool, got ${events}`,
	);
	assert.ok(outcome, `${label}: expected a published outcome`);
	assert.equal(outcome.message.isError, true, `${label}: interrupted outcome must be a synthetic error result`);
	assert.deepEqual(
		plain(outcome.message.content),
		[{ type: "text", text: "durable-progress" }, { type: "text", text: INTERRUPTION_MARKER }],
		`${label}: expected the durable checkpoint plus the interruption marker`,
	);
	assert.deepEqual(
		plain(outcome.message.details),
		{ step: 2 },
		`${label}: checkpoint details must be preserved`,
	);
}

// The fault of this stage: a blanket "never replay" rule suppressed every replay.
assertReplayed(await recover("safe", "safe", false), "safe/safe replay");

// Replay must happen only once, and clearing must precede the invocation while
// publishing must wait for it to finish (checked with a real async effect).
{
	const order = [];
	const result = await recover("safe", "safe", false, {
		effect: async () => {
			order.push("effect");
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
	});
	assertReplayed(result, "safe/safe replay with async effect");
	assert.deepEqual(order, ["effect"], "safe/safe replay: tool effect must run exactly once");
	assert.equal(result.events.at(-1), "publish", "safe/safe replay: publish must be the last step");
	assert.equal(
		result.events.indexOf("clear") < result.events.indexOf("invoke"),
		true,
		"safe/safe replay: the old checkpoint must be cleared before invocation",
	);
}

// Cancelled operations keep the conditional restriction even for safe/safe.
assertInterrupted(await recover("safe", "safe", true), "cancelled safe/safe");
assertInterrupted(await recover("safe", "safe", true, {
	effect: async () => {
		throw new Error("cancelled replay must never execute the tool");
	},
}), "cancelled safe/safe with guarded effect");

// Unsafe declarations keep the conditional restriction.
assertInterrupted(await recover("safe", "unsafe", false), "safe call, unsafe tool");
assertInterrupted(await recover("never", "safe", false), "unsafe call, safe tool");
assertInterrupted(await recover("never", "unsafe", false), "unsafe/unsafe");

// Missing declarations keep the conditional restriction.
assertInterrupted(await recover("safe", undefined, false), "safe call, absent tool");
assertInterrupted(await recover(undefined, "safe", false), "missing call policy, safe tool");
assertInterrupted(await recover("safe", null, false), "safe call, tool without replay declaration");

console.log("regression: safe/safe replay and conditional restrictions verified");
