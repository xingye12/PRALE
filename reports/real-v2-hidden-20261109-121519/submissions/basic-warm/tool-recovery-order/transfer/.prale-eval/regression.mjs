import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

// Load the real recoverToolInvocation implementation. Only checkpoint IO,
// tool execution, and outcome publication are replaced by observable fakes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recover = await createRecoverySubject(root);

const INTERRUPTION_MARKER = "external outcome is unknown";

function contentTexts(outcome) {
	assert.ok(outcome, "recovery must publish an outcome");
	assert.ok(Array.isArray(outcome.message.content), "outcome message content must be an array");
	return outcome.message.content.map((part) => {
		assert.equal(part?.type, "text", "synthetic content must be text parts");
		assert.equal(typeof part.text, "string", "text part must carry a string body");
		return part.text;
	});
}

function assertInterrupted(outcome, label) {
	assert.equal(outcome.message.isError, true, `${label}: interruption must be an error result`);
	const texts = contentTexts(outcome);
	assert.match(
		texts.at(-1),
		new RegExp(INTERRUPTION_MARKER),
		`${label}: interruption marker must be the final content part`,
	);
	assert.equal(texts[0], "durable-progress", `${label}: durable checkpoint content must be preserved`);
	assert.equal(outcome.message.details?.step, 2, `${label}: checkpoint details must be preserved`);
	assert.equal(outcome.message.role, "toolResult", `${label}: outcome must be a tool result message`);
	assert.equal(outcome.toolCall.id, "call-1", `${label}: outcome must reference the recovered call`);
}

// 1. Both the persisted call policy and the current tool declaration are safe
//    and the call was not cancelled: the effect replays with persisted args.
{
	let effects = 0;
	const { events, outcome } = await recover("safe", "safe", false, {
		effect: () => {
			effects += 1;
		},
	});
	assert.deepEqual(
		events,
		["clear", "invoke", "effect-complete", "publish"],
		"both-safe non-cancelled recovery must clear the checkpoint, replay, and publish exactly once",
	);
	assert.equal(effects, 1, "both-safe recovery must execute the effect exactly once");
	assert.equal(outcome.message.isError, false, "both-safe replay must publish a successful result");
	assert.equal(contentTexts(outcome).at(-1), "effect-result", "both-safe replay must publish the replayed effect result");
}

// 2. The current tool declaration changed from safe to never after the crash:
//    the persisted safe policy alone must not allow a replay.
{
	let effects = 0;
	const { events, outcome } = await recover("safe", "never", false, {
		effect: () => {
			effects += 1;
		},
	});
	assert.deepEqual(
		events,
		["read", "publish"],
		"a tool whose current declaration is no longer safe must be interrupted without replaying",
	);
	assert.equal(effects, 0, "a no-longer-safe tool must not execute its effect");
	assertInterrupted(outcome, "changed declaration");
}

// 3. The current tool declaration is missing entirely after the crash: settle
//    as an interruption instead of throwing, replaying, or executing.
{
	let effects = 0;
	const { events, outcome } = await recover("safe", undefined, false, {
		effect: () => {
			effects += 1;
		},
	});
	assert.deepEqual(
		events,
		["read", "publish"],
		"a missing current tool declaration must be interrupted without replaying",
	);
	assert.equal(effects, 0, "a missing tool must not execute its effect");
	assertInterrupted(outcome, "missing declaration");
}

// 4. A tool declared without a replay policy is unsafe by default.
{
	let effects = 0;
	const { events, outcome } = await recover("safe", null, false, {
		effect: () => {
			effects += 1;
		},
	});
	assert.deepEqual(
		events,
		["read", "publish"],
		"a tool without an explicit safe replay policy must be interrupted",
	);
	assert.equal(effects, 0, "a tool without a safe policy must not execute its effect");
	assertInterrupted(outcome, "implicitly unsafe declaration");
}

// 5. Cancellation always wins over an otherwise replayable call.
{
	let effects = 0;
	const { events, outcome } = await recover("safe", "safe", true, {
		effect: () => {
			effects += 1;
		},
	});
	assert.deepEqual(events, ["read", "publish"], "a cancelled call must be interrupted even when both sides are safe");
	assert.equal(effects, 0, "a cancelled call must not execute its effect");
	assertInterrupted(outcome, "cancelled call");
}

// 6. A persisted unsafe call never replays, even if the tool now declares safe.
{
	let effects = 0;
	const { events, outcome } = await recover("never", "safe", false, {
		effect: () => {
			effects += 1;
		},
	});
	assert.deepEqual(events, ["read", "publish"], "a persisted unsafe call must be interrupted without replaying");
	assert.equal(effects, 0, "a persisted unsafe call must not execute its effect");
	assertInterrupted(outcome, "persisted unsafe call");
}

console.log("recovery regression passed: only both-safe, non-cancelled calls replay; changed/missing tools interrupt");
