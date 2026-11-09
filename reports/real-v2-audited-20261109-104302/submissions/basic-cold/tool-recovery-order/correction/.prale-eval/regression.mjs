/**
 * Regression for tool-recovery-order/correction.
 *
 * Exercises the real `recoverToolInvocation` in
 * packages/agent/src/harness/runtime/drive/tools.ts through the boundary fakes
 * provided by ./subject.mjs (checkpoint IO, tool execution, outcome publication).
 *
 * Contract under test:
 *  - a call whose persisted policy is "safe" AND whose tool declares replay
 *    "safe" is replayed exactly once when the run is not cancelled;
 *  - the stale checkpoint is cleared BEFORE the tool is invoked;
 *  - the invocation outcome is published only AFTER the invocation completes;
 *  - unsafe ("never"), missing (no tool) and undeclared tools are interrupted
 *    from the durable checkpoint instead of replayed, and a cancelled run never
 *    replays even a safe/safe call.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createRecoverySubject } from "./subject.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const recover = await createRecoverySubject(root);

const INTERRUPTION_MARKER = "external outcome is unknown";
const checkpoint = {
	content: [{ type: "text", text: "durable-progress" }],
	details: { step: 2 },
};

function textOf(message) {
	return (message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function assertInterrupted(label, { events, outcome }) {
	assert.ok(outcome, `${label}: an outcome must be published`);
	assert.equal(outcome.message.isError, true, `${label}: interrupted outcome must be an error result`);
	assert.match(textOf(outcome.message), new RegExp(INTERRUPTION_MARKER), `${label}: must explain the unknown effect`);
	assert.match(textOf(outcome.message), /durable-progress/, `${label}: must keep the durable checkpoint content`);
	assert.deepEqual(outcome.message.details, checkpoint.details, `${label}: must keep the checkpoint details`);
	assert.equal(events.includes("invoke"), false, `${label}: must not re-run the tool`);
	assert.equal(events.includes("clear"), false, `${label}: must not clear the checkpoint`);
	assert.deepEqual(events, ["read", "publish"], `${label}: must read the checkpoint then publish the outcome`);
}

// --- 1. Safe call policy + safe tool declaration, not cancelled: replay once.
{
	const result = await recover("safe", "safe", false, { checkpoint });
	const { events, outcome } = result;

	assert.ok(outcome, "safe replay: an outcome must be published");
	assert.equal(events.includes("clear"), true, "safe replay: old checkpoint must be cleared");
	assert.equal(events.includes("invoke"), true, "safe replay: tool must be re-invoked");
	assert.equal(events.includes("read"), false, "safe replay: the cleared checkpoint must not be read");

	const cleared = events.indexOf("clear");
	const invoked = events.indexOf("invoke");
	const completed = events.indexOf("effect-complete");
	const published = events.indexOf("publish");
	assert.notEqual(cleared, -1, "safe replay: checkpoint clear missing");
	assert.notEqual(invoked, -1, "safe replay: invocation missing");
	assert.notEqual(completed, -1, "safe replay: invocation did not complete");
	assert.notEqual(published, -1, "safe replay: outcome publication missing");
	assert.ok(cleared < invoked, "safe replay: checkpoint must be cleared before invocation");
	assert.ok(completed < published, "safe replay: outcome must be published after invocation completes");
	assert.deepEqual(
		events,
		["clear", "invoke", "effect-complete", "publish"],
		"safe replay: cleared exactly once, invoked exactly once, then published",
	);

	assert.equal(outcome.message.isError, false, "safe replay: published outcome must be the tool result, not an interruption");
	assert.equal(textOf(outcome.message), "effect-result", "safe replay: published the invocation result");
	assert.doesNotMatch(textOf(outcome.message), new RegExp(INTERRUPTION_MARKER), "safe replay: no interruption marker");
	assert.deepEqual(outcome.args, { persisted: 42 }, "safe replay: replayed the persisted arguments");
	assert.equal(outcome.recovery, true, "safe replay: the invocation is recovery-tagged");
}

// --- 2. Unsafe persisted call policy: never replay.
assertInterrupted("unsafe call policy", await recover("never", "safe", false, { checkpoint }));

// --- 3. Tool declared "never" while the call policy is safe: never replay.
assertInterrupted("unsafe tool declaration", await recover("safe", "never", false, { checkpoint }));

// --- 4. Persisted call policy safe, but the tool is absent: never replay.
assertInterrupted("missing tool", await recover("safe", undefined, false, { checkpoint }));

// --- 5. Tool present without a replay declaration (defaults to never): never replay.
assertInterrupted("undeclared tool policy", await recover("safe", null, false, { checkpoint }));

// --- 6. Cancelled run: even a safe/safe call is interrupted, not replayed.
assertInterrupted("cancelled run", await recover("safe", "safe", true, { checkpoint }));

// --- 7. Cancelled run with an unsafe call: still interrupted (restriction retained).
assertInterrupted("cancelled unsafe run", await recover("never", "safe", true, { checkpoint }));

console.log("regression: safe replay ordering and conditional restrictions hold");
