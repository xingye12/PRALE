/**
 * Regression: cancellation must suppress safe/safe replay of an interrupted tool call.
 *
 * Drives the real recoverToolInvocation from
 * packages/agent/src/harness/runtime/drive/tools.ts through the subject helper,
 * which replaces only checkpoint IO, tool execution and outcome publication.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { createRecoverySubject } from "./subject.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PARTIAL_TEXT = "durable-progress";
const DETAILS = { step: 2 };

const run = await createRecoverySubject(root);

function texts(outcome) {
	return outcome.message.content.filter((part) => part.type === "text").map((part) => part.text);
}

function effectText(outcome) {
	return texts(outcome).join("\n");
}

async function scenario(callPolicy, toolPolicy, cancelled, options = {}) {
	const { events, outcome } = await run(callPolicy, toolPolicy, cancelled, options);
	assert.ok(outcome !== undefined, `${callPolicy}/${toolPolicy} cancelled=${cancelled}: outcome was not published`);
	return { events, outcome };
}

function assertInterruptedEvidence({ events, outcome }, label) {
	const text = effectText(outcome);
	assert.deepEqual(
		events.filter((event) => event === "clear"),
		[],
		`${label}: cancellation must not clear the replay checkpoint (events: ${events.join(",")})`,
	);
	assert.deepEqual(
		events.filter((event) => event === "invoke" || event === "effect-complete"),
		[],
		`${label}: cancellation must not invoke the tool (events: ${events.join(",")})`,
	);
	assert.ok(events.includes("read"), `${label}: interrupted evidence must read the durable checkpoint (events: ${events.join(",")})`);
	assert.deepEqual(
		events.slice(-1),
		["publish"],
		`${label}: the interrupted outcome must settle last (events: ${events.join(",")})`,
	);
	assert.equal(outcome.message.isError, true, `${label}: interrupted evidence must be an error result`);
	assert.ok(
		text.includes(PARTIAL_TEXT),
		`${label}: interrupted evidence must carry the durable progress snapshot, got ${JSON.stringify(text)}`,
	);
	assert.ok(
		/invocation was interrupted|was interrupted/i.test(text),
		`${label}: interrupted evidence must be marked as an interruption, got ${JSON.stringify(text)}`,
	);
	assert.deepEqual(outcome.message.details, DETAILS, `${label}: interrupted evidence must preserve checkpoint details`);
	assert.equal(outcome.terminate, false, `${label}: interrupted evidence must not terminate the turn`);
	assert.ok(
		!text.includes("effect-result"),
		`${label}: an interrupted call must not surface the replayed effect result, got ${JSON.stringify(text)}`,
	);
}

function assertReplayedOnce({ events, outcome }, label) {
	assert.deepEqual(
		events,
		["clear", "invoke", "effect-complete", "publish"],
		`${label}: a non-cancelled safe/safe call must clear once, replay once and settle (events: ${events.join(",")})`,
	);
	assert.equal(outcome.message.isError, false, `${label}: a successful replay must not be reported as an error`);
	assert.ok(
		effectText(outcome).includes("effect-result"),
		`${label}: the replayed tool result must be published, got ${JSON.stringify(effectText(outcome))}`,
	);
}

// 1. The fault: a newly interrupted batch recovers a safe/safe call while the
//    cancellation flag is set. Cancellation must win over the replay policy.
assertInterruptedEvidence(await scenario("safe", "safe", true), "cancelled safe/safe");

// 2. Same guarantee when the cancellation flag is set but the tool policy is
//    not replay-safe (guards against re-coupling cancellation to the policy).
assertInterruptedEvidence(await scenario("safe", "never", true), "cancelled safe/never");

// 3. Cancelled call whose tool is no longer registered.
assertInterruptedEvidence(await scenario("safe", undefined, true), "cancelled safe/missing-tool");

// 4. Non-cancelled safe/safe calls must still replay exactly once and settle.
assertReplayedOnce(await scenario("safe", "safe", false), "resumed safe/safe");

// 5. Non-cancelled non-replayable calls still publish interrupted evidence.
assertInterruptedEvidence(await scenario("never", "safe", false), "resumed never/safe");

// 6. A cancelled call that is already mid-effect must not re-run the effect.
const cancelledLate = await scenario("safe", "safe", true, {
	effect: async () => {
		throw new Error("cancelled replay must not run the tool effect");
	},
});
assertInterruptedEvidence(cancelledLate, "cancelled safe/safe with effect probe");

console.log("recovery retransfer regression: all assertions passed");
