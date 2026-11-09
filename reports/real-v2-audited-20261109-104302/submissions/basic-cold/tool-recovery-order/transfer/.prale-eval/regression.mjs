/**
 * Standalone regression for recovery replay policy.
 *
 * Fault under test: recovery replayed a persisted `effect_pending` call whenever
 * the *persisted* policy was "safe", ignoring the current tool declaration. A tool
 * whose policy changed to "never" (or that is now missing entirely) was therefore
 * re-executed, and a missing tool was handed to the effect boundary instead of
 * settling as an interrupted outcome.
 *
 * Expected rule: replay only when the call was persisted safe AND the current
 * declaration is still safe AND the batch is not cancelled. Otherwise settle the
 * call as interrupted (checkpoint + interruption marker), never invoking the tool.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const run = await createRecoverySubject(root);

const CHECKPOINT = {
	content: [{ type: "text", text: "durable-progress" }],
	details: { step: 2 },
};
const MARKER = /external outcome is unknown/;
const REPLAY_EVENTS = ["clear", "invoke", "effect-complete", "publish"];
const INTERRUPTED_EVENTS = ["read", "publish"];

/** Assert the call settled as an interrupted outcome carrying the durable checkpoint. */
function assertInterrupted(result, label) {
	const { events, outcome } = result;
	assert.deepEqual(events, INTERRUPTED_EVENTS, `${label}: recovery must not replay or execute the effect`);
	assert.ok(outcome !== undefined, `${label}: an outcome must be published`);
	assert.equal(outcome.toolCall.id, "call-1", `${label}: outcome must target the same tool call`);
	assert.equal(outcome.message.role, "toolResult", `${label}: outcome must be a tool result message`);
	assert.equal(outcome.message.isError, true, `${label}: interrupted outcome must be flagged as an error`);
	assert.equal(outcome.terminate, false, `${label}: interrupted outcome must not terminate the turn`);
	const content = outcome.message.content;
	assert.ok(Array.isArray(content) && content.length === 2, `${label}: checkpoint text plus marker expected`);
	assert.deepEqual(content[0], { type: "text", text: "durable-progress" }, `${label}: durable checkpoint preserved`);
	assert.equal(content[1].type, "text", `${label}: interruption marker must be text`);
	assert.match(content[1].text, MARKER, `${label}: interruption marker must explain the unknown outcome`);
	assert.deepEqual(outcome.message.details, { step: 2 }, `${label}: durable checkpoint details preserved`);
}

/** Assert the call replayed its durable effect with the persisted arguments. */
function assertReplayed(result, label) {
	const { events, outcome } = result;
	assert.deepEqual(events, REPLAY_EVENTS, `${label}: both-safe, non-cancelled call must clear and replay`);
	assert.ok(outcome !== undefined, `${label}: an outcome must be published`);
	assert.equal(outcome.recovery, true, `${label}: replay must be published as a recovery invocation`);
	assert.deepEqual(outcome.args, { persisted: 42 }, `${label}: replay must reuse persisted arguments`);
	assert.equal(outcome.message.isError, false, `${label}: replayed effect succeeded`);
	assert.deepEqual(
		outcome.message.content,
		[{ type: "text", text: "effect-result" }],
		`${label}: replayed effect result expected`,
	);
}

// 1. Original fault: persisted intent was safe, but the current declaration is no longer safe.
let effects = 0;
const changed = await run("safe", "never", false, {
	checkpoint: CHECKPOINT,
	effect: async () => {
		effects += 1;
	},
});
assert.equal(effects, 0, "changed declaration: the tool effect must not run");
assertInterrupted(changed, "changed declaration safe -> never");

// 2. Original fault: the tool is gone entirely; recovery must not execute or throw.
effects = 0;
const missing = await run("safe", undefined, false, {
	checkpoint: CHECKPOINT,
	effect: async () => {
		effects += 1;
	},
});
assert.equal(effects, 0, "missing tool: the tool effect must not run");
assertInterrupted(missing, "missing tool");

// 3. A tool that never declared a replay policy cannot replay a persisted safe call.
effects = 0;
const undeclared = await run("safe", null, false, {
	checkpoint: CHECKPOINT,
	effect: async () => {
		effects += 1;
	},
});
assert.equal(effects, 0, "declaration without policy: the tool effect must not run");
assertInterrupted(undeclared, "declaration without policy");

// 4. Persisted intent was unsafe even though the current declaration is safe: still interrupted.
effects = 0;
const persistedUnsafe = await run("never", "safe", false, {
	checkpoint: CHECKPOINT,
	effect: async () => {
		effects += 1;
	},
});
assert.equal(effects, 0, "persisted never: the tool effect must not run");
assertInterrupted(persistedUnsafe, "persisted never / declared safe");

// 5. Both policies safe but the batch is cancelled: interrupted, never replayed.
effects = 0;
const cancelled = await run("safe", "safe", true, {
	checkpoint: CHECKPOINT,
	effect: async () => {
		effects += 1;
	},
});
assert.equal(effects, 0, "cancelled: the tool effect must not run");
assertInterrupted(cancelled, "cancelled batch");

// 6. Both policies safe and the batch is live: the durable effect still replays.
effects = 0;
const replayed = await run("safe", "safe", false, {
	checkpoint: CHECKPOINT,
	effect: async () => {
		effects += 1;
	},
});
assert.equal(effects, 1, "both safe: the durable effect must replay exactly once");
assertReplayed(replayed, "both safe");

console.log("recovery replay policy regression: all assertions passed");
