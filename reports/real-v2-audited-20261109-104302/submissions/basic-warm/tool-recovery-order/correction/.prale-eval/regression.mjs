/**
 * Regression for tool-recovery-order/correction.
 *
 * Exercises the real `recoverToolInvocation` from
 * packages/agent/src/harness/runtime/drive/tools.ts through the read-only VM
 * harness in ./.prale-eval/subject.mjs. Only the checkpoint IO, the tool effect
 * and the outcome publication boundary are faked, so the assertions below pin
 * the production control flow:
 *
 *   - a declared safe/safe effect_pending call that is not cancelled is
 *     replayed exactly once: checkpoint cleared *before* invocation, outcome
 *     published *after* the invocation completes;
 *   - unsafe declarations, a missing tool declaration, an undeclared (absent)
 *     replay policy and a cancelled run all keep the conditional restriction
 *     and synthesize an interruption from the durable checkpoint instead.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRecoverySubject } from "./subject.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
// Default: the workspace that owns this .prale-eval directory. The override is
// only used to replay the regression against an isolated copy of the source.
const root = process.env.PRALE_RECOVERY_ROOT ?? path.dirname(scriptDirectory);

const INTERRUPTION_MARKER =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

/** Normalize VM-realm values into host-realm plain data before strict asserts. */
function host(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function contentOf(outcome) {
	assert.ok(outcome, "production code must publish a tool outcome");
	return host(outcome.message.content);
}

function textsOf(outcome) {
	return contentOf(outcome).map((part) => part.text);
}

function count(events, name) {
	return events.filter((event) => event === name).length;
}

/**
 * Assertions for the replayed control flow: nothing may be synthesized and the
 * old checkpoint must be dropped before the effect runs again.
 */
function assertReplayed(events, outcome) {
	assert.strictEqual(count(events, "read"), 0, "safe replay must not read the stale checkpoint as its outcome");
	assert.strictEqual(count(events, "clear"), 1, "safe replay must clear the old checkpoint exactly once");
	assert.strictEqual(count(events, "invoke"), 1, "safe replay must invoke the effect exactly once");
	assert.strictEqual(count(events, "publish"), 1, "safe replay must publish exactly one outcome");
	assert.deepStrictEqual(events, ["clear", "invoke", "effect-complete", "publish"], "safe replay order must be clear -> invoke -> publish");
	assert.ok(events.indexOf("clear") < events.indexOf("invoke"), "checkpoint must be cleared before the effect is invoked");
	assert.ok(
		events.indexOf("publish") > events.indexOf("effect-complete"),
		"outcome must be published only after the invocation completes",
	);
	assert.strictEqual(textsOf(outcome).includes(INTERRUPTION_MARKER), false, "replayed call must not be reported as interrupted");
	assert.deepStrictEqual(textsOf(outcome), ["effect-result"], "replayed call must publish the fresh effect result");
	assert.strictEqual(outcome.message.isError, false, "replayed call must not be marked as an error");
	assert.strictEqual(outcome.toolCall.id, "call-1", "replayed outcome must keep the logical call identity");
	assert.strictEqual(outcome.toolCall.name, "fixture-tool", "replayed outcome must keep the tool name");
	assert.strictEqual(outcome.terminate, false, "replayed outcome must keep the terminate flag");
	assert.strictEqual(outcome.recovery, true, "replayed invocation must run under the recovery flag");
	assert.deepStrictEqual(
		host(outcome.args),
		{ persisted: 42 },
		"replayed invocation must receive the arguments materialized while clearing the checkpoint",
	);
}

/** Assertions for every path that must keep the interruption restriction. */
function assertInterrupted(events, outcome, reason) {
	assert.strictEqual(count(events, "clear"), 0, `${reason}: the durable checkpoint must not be cleared`);
	assert.strictEqual(count(events, "invoke"), 0, `${reason}: the effect must not be re-invoked`);
	assert.strictEqual(count(events, "effect-complete"), 0, `${reason}: no effect may complete`);
	assert.deepStrictEqual(events, ["read", "publish"], `${reason}: must read the durable checkpoint and publish an interruption`);
	assert.deepStrictEqual(
		textsOf(outcome),
		["durable-progress", INTERRUPTION_MARKER],
		`${reason}: must synthesize an interruption that preserves the durable progress`,
	);
	assert.strictEqual(outcome.message.isError, true, `${reason}: interruption must be an error result`);
	assert.deepStrictEqual(host(outcome.message.details), { step: 2 }, `${reason}: unrelated checkpoint details must be preserved`);
	assert.strictEqual(outcome.terminate, false, `${reason}: interruption must not terminate the run`);
}

const recover = await createRecoverySubject(root);

{
	const { events, outcome } = await recover("safe", "safe", false);
	assertReplayed(events, outcome);
}

// Conditional restrictions that must survive the correction.
{
	const { events, outcome } = await recover("safe", "unsafe", false);
	assertInterrupted(events, outcome, "unsafe tool declaration");
}
{
	const { events, outcome } = await recover("never", "safe", false);
	assertInterrupted(events, outcome, "unsafe call declaration");
}
{
	const { events, outcome } = await recover("never", "unsafe", false);
	assertInterrupted(events, outcome, "unsafe tool and call declarations");
}
{
	// toolPolicy === undefined: the tool is no longer registered.
	const { events, outcome } = await recover("safe", undefined, false);
	assertInterrupted(events, outcome, "missing tool declaration");
}
{
	// toolPolicy === null: the tool exists but declares no replay policy.
	const { events, outcome } = await recover("safe", null, false);
	assertInterrupted(events, outcome, "absent tool replay policy");
}
{
	const { events, outcome } = await recover("safe", "safe", true);
	assertInterrupted(events, outcome, "cancelled run");
}

// The safe/safe decision must not leak into a later cancelled or unsafe replay:
// the same subject is reused so a sticky replay branch would surface here.
{
	const { events, outcome } = await recover("safe", "safe", false);
	assertReplayed(events, outcome);
}
{
	const { events, outcome } = await recover("safe", "unsafe", true);
	assertInterrupted(events, outcome, "cancelled run with unsafe declaration");
}

console.log("tool-recovery-order regression passed: safe/safe replays once (clear -> invoke -> publish); unsafe, missing and cancelled declarations stay interrupted");
