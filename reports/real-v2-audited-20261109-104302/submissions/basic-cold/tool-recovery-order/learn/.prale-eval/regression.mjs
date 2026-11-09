/**
 * Regression for the interrupted-tool recovery policy in
 * packages/agent/src/harness/runtime/drive/tools.ts (recoverToolInvocation).
 *
 * Required policy: replay an interrupted (effect_pending) tool call ONLY when
 * the persisted call policy AND the current tool declaration are both "safe",
 * and the batch was not cancelled. Every other combination must publish an
 * interrupted outcome carrying the durable checkpoint, without clearing that
 * checkpoint and without invoking the tool.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const recover = await createRecoverySubject(root);

// Stable fragment of the production interruption marker sentence.
const MARKER = "external outcome is unknown";
const DEFAULT_CHECKPOINT = {
	content: [{ type: "text", text: "durable-progress" }],
	details: { step: 2 },
};
const REPLAY_EVENTS = ["clear", "invoke", "effect-complete", "publish"];
const INTERRUPTED_EVENTS = ["read", "publish"];

/** Replay means the checkpoint was cleared and the tool was actually invoked. */
const replayed = (events) => events.includes("clear") || events.includes("invoke");

/** The subject evaluates production code in a separate VM realm, so compare by
 * value with locally owned plain data instead of by prototype identity. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function replayCase(label, callPolicy, toolPolicy) {
	const { events, outcome } = await recover(callPolicy, toolPolicy, false);
	assert.deepEqual(
		events,
		REPLAY_EVENTS,
		`${label}: both-safe recovery must clear the checkpoint, invoke once and publish once, got ${JSON.stringify(events)}`,
	);
	assert.ok(outcome, `${label}: replay path published no outcome`);
	assert.deepEqual(
		plain(outcome.args),
		{ persisted: 42 },
		`${label}: replay must re-run with the cleared persisted arguments`,
	);
	assert.equal(outcome.recovery, true, `${label}: replay must be flagged as recovery`);
	assert.equal(
		outcome.message.content.at(-1)?.text,
		"effect-result",
		`${label}: replay must publish the tool result rather than an interruption`,
	);
}

async function interruptedCase(label, callPolicy, toolPolicy, cancelled, checkpoint) {
	const { events, outcome } = await recover(
		callPolicy,
		toolPolicy,
		cancelled,
		checkpoint === undefined ? {} : { checkpoint },
	);
	assert.equal(
		replayed(events),
		false,
		`${label}: unsafe recovery replayed the interrupted tool (events ${JSON.stringify(events)})`,
	);
	assert.deepEqual(
		events,
		INTERRUPTED_EVENTS,
		`${label}: expected checkpoint read then one published outcome, got ${JSON.stringify(events)}`,
	);
	assert.ok(outcome, `${label}: interrupted path published no outcome`);
	assert.equal(outcome.terminate, false, `${label}: interrupted outcome must not terminate the run`);
	assert.equal(outcome.toolCall.id, "call-1", `${label}: interrupted outcome must target the interrupted call`);
	assert.equal(outcome.message.role, "toolResult", `${label}: interrupted outcome must be a tool result message`);
	assert.equal(outcome.message.toolCallId, "call-1", `${label}: interrupted outcome must answer the interrupted call`);
	assert.equal(outcome.message.isError, true, `${label}: interrupted outcome must be an error result`);
	const durable = checkpoint ?? DEFAULT_CHECKPOINT;
	assert.deepEqual(
		plain(outcome.message.content.slice(0, durable.content.length)),
		durable.content,
		`${label}: interrupted outcome must carry the durable checkpoint content`,
	);
	assert.equal(
		outcome.message.content.length,
		durable.content.length + 1,
		`${label}: interrupted outcome must append exactly one interruption marker`,
	);
	const marker = outcome.message.content.at(-1);
	assert.ok(marker && marker.type === "text", `${label}: interruption marker must be a text part`);
	assert.ok(
		marker.text.includes(MARKER),
		`${label}: interruption marker must explain the unknown external outcome, got ${JSON.stringify(marker)}`,
	);
	assert.deepEqual(
		plain(outcome.message.details),
		durable.details,
		`${label}: interrupted outcome must carry the durable checkpoint details`,
	);
	return outcome;
}

// 1. The only replaying combination: both declarations safe, no cancellation.
await replayCase("persisted=safe tool=safe", "safe", "safe");

// 2. Persisted policy safe but the current declaration is unsafe ("never").
await interruptedCase("persisted=safe tool=never", "safe", "never");

// 3. Persisted policy unsafe ("never") but the current declaration is safe.
//    This is the original fault: an either/or safety check replays this effect.
await interruptedCase("persisted=never tool=safe", "never", "safe");

// 4. Neither declaration is safe.
await interruptedCase("persisted=never tool=never", "never", "never");

// 5. Tool exists but declares no replay policy (defaults to unsafe).
await interruptedCase("persisted=safe tool=no-policy", "safe", null);
await interruptedCase("persisted=never tool=no-policy", "never", null);

// 6. Tool is absent from the live tool map: never replay, never execute.
await interruptedCase("persisted=safe tool=absent", "safe", undefined);
await interruptedCase("persisted=never tool=absent", "never", undefined);

// 7. Cancellation vetoes replay even when both declarations are safe.
await interruptedCase("persisted=safe tool=safe cancelled", "safe", "safe", true);
await interruptedCase("persisted=never tool=safe cancelled", "never", "safe", true);
await interruptedCase("persisted=safe tool=never cancelled", "safe", "never", true);

// 8. A checkpoint without details must not invent details on the outcome.
const lean = await interruptedCase(
	"checkpoint without details",
	"safe",
	"never",
	false,
	{ content: [{ type: "text", text: "partial output" }] },
);
assert.equal(
	"details" in lean.message,
	false,
	"checkpoint without details must not invent details on the interrupted outcome",
);

// 9. Empty checkpoint still publishes exactly the interruption marker.
await interruptedCase("empty checkpoint", "never", "safe", false, { content: [] });

// 10. Exhaustive matrix: replay iff both declarations are safe and not cancelled.
for (const callPolicy of ["safe", "never"]) {
	for (const toolPolicy of ["safe", "never", null, undefined]) {
		for (const cancelled of [false, true]) {
			const { events } = await recover(callPolicy, toolPolicy, cancelled);
			const label = `matrix persisted=${callPolicy} tool=${String(toolPolicy)} cancelled=${cancelled}`;
			const bothSafe = callPolicy === "safe" && toolPolicy === "safe";
			assert.equal(
				replayed(events),
				bothSafe && !cancelled,
				`${label}: replay decision must equal (both safe && not cancelled), got ${JSON.stringify(events)}`,
			);
			if (bothSafe !== !cancelled) {
				assert.equal(
					events.includes("invoke"),
					false,
					`${label}: recovery that is not both-safe-and-live must never invoke the tool (events ${JSON.stringify(events)})`,
				);
			}
		}
	}
}

console.log("interrupted tool recovery policy: all assertions passed");
