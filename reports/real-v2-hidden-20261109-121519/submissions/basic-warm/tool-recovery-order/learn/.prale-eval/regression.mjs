/**
 * Standalone regression for tool-recovery-order: replay admission of an
 * orphaned `effect_pending` tool call.
 *
 * Contract under test (from packages/agent/docs/tool-durability.md):
 * - Replay is admitted only when the persisted call policy AND the current tool
 *   declaration are both `replay: "safe"`, and the run was not cancelled.
 * - Otherwise recovery must publish an interrupted outcome carrying the durable
 *   checkpoint, without clearing the checkpoint or invoking the tool.
 *
 * Everything at the boundaries (checkpoint IO, tool invocation, outcome
 * publication) is replaced by observable fakes in the read-only subject helper;
 * the real recoverToolInvocation / interruptedOutcome code paths run.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recover = await createRecoverySubject(root);

const INTERRUPTION_MARKER =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

const DEFAULT_CHECKPOINT = {
	content: [{ type: "text", text: "durable-progress" }],
	details: { step: 2 },
};

// Values can originate in the VM realm used by the subject loader; normalize
// them before strict structural comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

function assertReplayed(result, label) {
	assert.deepEqual(
		plain(result.events),
		["clear", "invoke", "effect-complete", "publish"],
		`${label}: both safe declarations and no cancellation must clear the checkpoint and replay the tool`,
	);
	assert.ok(result.outcome, `${label}: replay must publish an outcome`);
	const message = plain(result.outcome.message);
	assert.deepEqual(
		message.content,
		[{ type: "text", text: "effect-result" }],
		`${label}: the replayed tool result must be published unchanged`,
	);
	assert.equal(message.isError, false, `${label}: a replayed effect result is not an interruption`);
	assert.equal(result.outcome.terminate, false, `${label}: replay must not terminate the run`);
}

function assertInterrupted(result, label, checkpoint = DEFAULT_CHECKPOINT) {
	assert.deepEqual(
		plain(result.events),
		["read", "publish"],
		`${label}: replay is not admitted, so recovery must read the durable checkpoint and publish an interrupted outcome without clearing or invoking`,
	);
	assert.ok(result.outcome, `${label}: interruption must publish an outcome`);
	const message = plain(result.outcome.message);
	assert.equal(message.isError, true, `${label}: interrupted outcomes are delivered as errors`);
	assert.deepEqual(
		message.content,
		[...checkpoint.content, { type: "text", text: INTERRUPTION_MARKER }],
		`${label}: interrupted outcome must preserve the durable checkpoint content and append the interruption marker`,
	);
	assert.equal(message.toolCallId, "call-1", `${label}: interrupted outcome must keep the tool call identity`);
	assert.equal(message.toolName, "fixture-tool", `${label}: interrupted outcome must keep the tool name`);
	assert.equal(result.outcome.terminate, false, `${label}: interruption must not terminate the run`);
	if (checkpoint.details === undefined) {
		assert.equal(message.details, undefined, `${label}: absent checkpoint details must stay absent`);
	} else {
		assert.deepEqual(message.details, checkpoint.details, `${label}: checkpoint details must be preserved`);
	}
	if (checkpoint.usage !== undefined) {
		assert.deepEqual(message.usage, checkpoint.usage, `${label}: checkpoint usage must be preserved`);
	}
}

// --- Replay is admitted only when both declarations are safe. -----------------

assertReplayed(await recover("safe", "safe", false), "stored safe + current safe, not cancelled");

// The original fault admitted replay when EITHER declaration was safe. Each of
// these cases has exactly one safe side and must not replay.
assertInterrupted(
	await recover("safe", undefined, false),
	"stored safe + tool absent (original fault: replayed because the stored policy was safe)",
);
assertInterrupted(
	await recover("safe", null, false),
	"stored safe + current declaration without a policy (original fault: replayed because the stored policy was safe)",
);
assertInterrupted(
	await recover("safe", "never", false),
	"stored safe + current never (original fault: replayed because the stored policy was safe)",
);
assertInterrupted(
	await recover("never", "safe", false),
	"stored never + current safe (original fault: replayed because the current declaration was safe)",
);
assertInterrupted(await recover("never", null, false), "stored never + current without a policy");
assertInterrupted(await recover("never", undefined, false), "stored never + tool absent");
assertInterrupted(await recover("never", "never", false), "stored never + current never");

// --- Cancellation always interrupts, never replays. --------------------------

assertInterrupted(await recover("safe", "safe", true), "both safe but the run was cancelled");

// --- The durable checkpoint is carried through interruption untouched. -------

const partialCheckpoint = {
	content: [
		{ type: "text", text: "partial-line-1" },
		{ type: "text", text: "partial-line-2" },
	],
	details: { step: 7, note: "latest durable progress" },
	usage: { input: 11, output: 5 },
};
assertInterrupted(
	await recover("never", "safe", false, { checkpoint: partialCheckpoint }),
	"interruption preserves a multi-chunk checkpoint with details and usage",
	partialCheckpoint,
);

console.log("tool-recovery-order regression: all replay admission assertions passed");
