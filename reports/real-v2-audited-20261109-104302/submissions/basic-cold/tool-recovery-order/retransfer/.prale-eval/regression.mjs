/**
 * Standalone regression for tool-recovery-order/retransfer.
 *
 * Exercises the real `recoverToolInvocation` implementation in
 * packages/agent/src/harness/runtime/drive/tools.ts through the read-only
 * subject helper (checkpoint IO, tool execution and outcome publication are
 * observable boundary fakes).
 *
 * Fault: a cancelled recovered batch still clears the replay checkpoint and
 * re-invokes a safe/safe tool call. The interrupted evidence publication path
 * must be used instead. Non-cancelled safe/safe calls must still replay exactly
 * once and settle with their real outcome.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { createRecoverySubject } from "./subject.mjs";

const root = process.cwd();
const recover = await createRecoverySubject(root);

const INTERRUPTION_MARKER = "external outcome is unknown";
const DURABLE_TEXT = "durable-progress";

// Cross-realm (VM) values carry foreign prototypes; compare plain JSON shapes.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const lastText = (message) => {
	const content = message?.content;
	assert.ok(Array.isArray(content) && content.length > 0, "outcome message must carry content");
	const last = content.at(-1);
	assert.equal(last?.type, "text", "final content block must be text");
	return last.text;
};

// 1. Cancelled safe/safe recovery: interrupt instead of replaying.
//    This is the stage's original fault: the checkpoint was cleared and the
//    tool effect was re-invoked despite durable cancellation.
{
	const { events, outcome } = await recover("safe", "safe", true);
	assert.deepEqual(
		events,
		["read", "publish"],
		"cancelled safe/safe recovery must read the checkpoint and publish interrupted evidence only",
	);
	assert.ok(!events.includes("clear"), "cancelled recovery must not clear the replay checkpoint");
	assert.ok(!events.includes("invoke"), "cancelled recovery must not invoke the tool");
	assert.ok(!events.includes("effect-complete"), "cancelled recovery must not run the tool effect");
	assert.ok(outcome, "cancelled recovery must publish an outcome");
	assert.equal(outcome.toolCall?.id, "call-1", "published outcome must target the recovered tool call");
	assert.equal(outcome.message?.role, "toolResult", "published outcome must be a tool result message");
	assert.equal(outcome.message?.toolCallId, "call-1");
	assert.equal(outcome.message?.toolName, "fixture-tool");
	assert.equal(outcome.message?.isError, true, "interrupted evidence must be an error result");
	assert.equal(outcome.terminate, false, "interrupted recovery must not terminate");
	assert.match(lastText(outcome.message), new RegExp(INTERRUPTION_MARKER.replace(/ /g, "\\s")));
	assert.deepEqual(
		plain(outcome.message.content.slice(0, -1)),
		[{ type: "text", text: DURABLE_TEXT }],
		"interrupted evidence must publish the durable checkpoint content",
	);
	assert.deepEqual(plain(outcome.message.details), { step: 2 }, "interrupted evidence must preserve checkpoint details");
}

// 2. Cancelled recovery with the same result even when the tool is absent.
{
	const { events, outcome } = await recover("safe", undefined, true);
	assert.deepEqual(events, ["read", "publish"], "cancelled recovery of an absent tool must publish interrupted evidence");
	assert.ok(!events.includes("invoke"), "absent tool must never be invoked after cancellation");
	assert.match(lastText(outcome.message), /external outcome is unknown/);
	assert.deepEqual(plain(outcome.message.details), { step: 2 });
}

// 3. Cancelled recovery when the call itself is not replay-safe.
{
	const { events, outcome } = await recover("never", "safe", true);
	assert.deepEqual(events, ["read", "publish"], "cancelled non-replayable call must publish interrupted evidence");
	assert.ok(!events.includes("clear"), "cancelled recovery must not clear the checkpoint");
	assert.equal(outcome.message?.isError, true);
	assert.match(lastText(outcome.message), /external outcome is unknown/);
}

// 4. Non-cancelled safe/safe recovery: replay exactly once, settle after completion.
{
	const { events, outcome } = await recover("safe", "safe", false);
	assert.deepEqual(
		events,
		["clear", "invoke", "effect-complete", "publish"],
		"non-cancelled safe/safe recovery must clear the checkpoint, invoke once, and publish the settled outcome",
	);
	assert.equal(events.filter((event) => event === "invoke").length, 1, "safe/safe replay must invoke exactly once");
	assert.equal(events.filter((event) => event === "publish").length, 1, "safe/safe replay must publish exactly once");
	assert.ok(
		events.indexOf("clear") < events.indexOf("invoke"),
		"checkpoint clearing must happen before replaying the tool",
	);
	assert.ok(
		events.indexOf("effect-complete") < events.indexOf("publish"),
		"the outcome must be published only after the effect completed",
	);
	assert.ok(outcome, "non-cancelled replay must publish an outcome");
	assert.equal(outcome.message?.isError, false, "replayed safe/safe call must settle with its real result");
	assert.equal(outcome.terminate, false);
	assert.deepEqual(
		plain(outcome.message.content),
		[{ type: "text", text: "effect-result" }],
		"replayed safe/safe call must publish the executed tool result, not interrupted evidence",
	);
}

// 5. Non-cancelled recovery of a non-replayable call still interrupts.
{
	const { events, outcome } = await recover("never", "safe", false);
	assert.deepEqual(events, ["read", "publish"], "non-replayable recovery must publish interrupted evidence");
	assert.ok(!events.includes("invoke"), "non-replayable call must not be invoked");
	assert.equal(outcome.message?.isError, true);
	assert.deepEqual(
		plain(outcome.message.content.slice(0, -1)),
		[{ type: "text", text: DURABLE_TEXT }],
		"interrupted evidence must keep the durable checkpoint content",
	);
}

console.log("regression passed: cancelled safe/safe recovery interrupts; non-cancelled safe/safe recovery replays once");
