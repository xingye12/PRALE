// Regression for tool-recovery-order/correction.
//
// Fault: recoverToolInvocation carried a blanket "never replay" guard
// (`if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe")`),
// so a verified safe call on a verified safe tool never replayed; it was always
// reported as interrupted, and its durable checkpoint was published as the
// outcome of an effect that in fact never ran.
//
// Required behavior:
//   * safe call + safe tool + not cancelled -> replay exactly once: clear the old
//     checkpoint FIRST, then invoke, then publish the invocation outcome,
//   * safe call + safe tool + cancelled -> conditional restriction retained: no
//     replay, checkpoint surfaced with the interruption marker,
//   * unsafe / missing / undeclared tool policy, or a non-safe call -> no replay.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recover = await createRecoverySubject(root);

const INTERRUPTION = "external outcome is unknown";
const CHECKPOINT_TEXT = "durable-progress";
const EFFECT_TEXT = "effect-result";

// Normalize VM-realm arrays into host arrays so assertions compare values.
const texts = (outcome) => Array.from(outcome?.message?.content ?? []).map((part) => part.text);

function assertInterrupted(result, label) {
	assert.equal(result.events.includes("clear"), false, `${label}: checkpoint must not be cleared without a replay`);
	assert.equal(result.events.includes("invoke"), false, `${label}: tool must not be invoked`);
	assert.deepEqual(result.events, ["read", "publish"], `${label}: must read the checkpoint then publish it once`);
	const outcome = result.outcome;
	assert.ok(outcome, `${label}: an outcome must be published`);
	assert.equal(outcome.message.isError, true, `${label}: interrupted outcome must be an error result`);
	const content = texts(outcome);
	assert.equal(content.at(-1)?.includes(INTERRUPTION), true, `${label}: interrupted outcome must state the external outcome is unknown`);
	assert.deepEqual(content.slice(0, -1), [CHECKPOINT_TEXT], `${label}: durable checkpoint content must be preserved`);
	assert.equal(outcome.message.details?.step, 2, `${label}: durable checkpoint details must be preserved`);
}

function assertReplayed(result, label) {
	const outcome = result.outcome;
	assert.ok(outcome, `${label}: an outcome must be published`);
	assert.equal(outcome.message.isError, false, `${label}: a replayed safe call must publish the real invocation outcome`);
	assert.deepEqual(texts(outcome), [EFFECT_TEXT], `${label}: published outcome must come from the invocation, not the stale checkpoint`);
	assert.equal(texts(outcome).join(" ").includes(INTERRUPTION), false, `${label}: a replayed call must not be reported as interrupted`);
	assert.deepEqual(outcome.toolCall, { id: "call-1", name: "fixture-tool", arguments: {} });
}

// 1. The corrected core: verified safe call on a verified safe tool, not cancelled.
{
	const result = await recover("safe", "safe", false);
	assert.deepEqual(
		result.events,
		["clear", "invoke", "effect-complete", "publish"],
		"safe/safe replay must clear the old checkpoint before invocation and publish only after the invocation completes",
	);
	assertReplayed(result, "safe/safe replay");
}

// 2. Cancellation keeps the conditional restriction even for safe/safe.
{
	const result = await recover("safe", "safe", true);
	assertInterrupted(result, "cancelled safe/safe");
}

// 3. Unsafe tool declaration: never replay, keep the checkpoint.
{
	const result = await recover("safe", "never", false);
	assertInterrupted(result, "unsafe tool declaration");
}

// 4. Missing tool declaration: never replay.
{
	const result = await recover("safe", undefined, false);
	assertInterrupted(result, "missing tool");
}

// 5. Tool present without a replay policy: defaults to never replay.
{
	const result = await recover("safe", null, false);
	assertInterrupted(result, "tool without replay policy");
}

// 6. Non-safe persisted call state: never replay even when the tool is safe.
{
	const result = await recover("never", "safe", false);
	assertInterrupted(result, "nonsafe call state");
}

console.log("regression: safe/safe replay, ordering, and conditional restrictions verified");
