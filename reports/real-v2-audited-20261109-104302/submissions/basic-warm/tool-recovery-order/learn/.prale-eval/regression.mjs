/**
 * Standalone regression for interrupted tool recovery ordering.
 *
 * Invariant under test (packages/agent/src/harness/runtime/drive/tools.ts,
 * recoverToolInvocation): a restored `effect_pending` call may only be replayed
 * when the persisted call policy AND the current tool declaration both declare
 * `replay: "safe"` and the batch is not cancelled. Every other combination must
 * publish an interrupted outcome that carries the durable checkpoint, without
 * clearing the checkpoint and without invoking the tool.
 *
 * The real production module is loaded through the read-only
 * `.prale-eval/subject.mjs` helper; only checkpoint IO, tool execution and
 * outcome publication are replaced by observable boundary fakes.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recover = await createRecoverySubject(root);

const DURABLE_TEXT = "durable-progress";
const DURABLE_DETAILS = { step: 2 };
const INTERRUPTED_MARKER_FRAGMENT = "external outcome is unknown";
const REPLAY_EVENTS = ["clear", "invoke", "effect-complete", "publish"];
const INTERRUPTED_EVENTS = ["read", "publish"];

/** Rebuild VM-realm values as host-realm plain data before strict comparison. */
function normalize(value) {
	if (Array.isArray(value)) return Array.from(value, normalize);
	if (value !== null && typeof value === "object") {
		const copy = {};
		for (const key of Object.keys(value)) copy[key] = normalize(value[key]);
		return copy;
	}
	return value;
}

function label(policy, declaration, cancelled) {
	return `callPolicy=${String(policy)} toolDeclaration=${stringifyDeclaration(declaration)}${
		cancelled ? " cancelled" : ""
	}`;
}

function stringifyDeclaration(declaration) {
	if (declaration === undefined) return "absent";
	if (declaration === null) return "no-policy";
	return JSON.stringify(declaration);
}

function assertInterrupted(bundle, context) {
	const { events, outcome } = bundle;
	const observed = Array.from(events);
	assert.deepEqual(
		observed,
		INTERRUPTED_EVENTS,
		`${context}: replay must require BOTH policies safe and no cancellation, so the checkpoint must only be read ` +
			`and published (never cleared, never invoked); observed events ${JSON.stringify(observed)}`,
	);
	assert.ok(outcome !== undefined, `${context}: interrupted recovery must publish an outcome`);
	const message = normalize(outcome.message);
	assert.equal(message.role, "toolResult", `${context}: interrupted outcome must be a tool result message`);
	assert.equal(message.toolCallId, "call-1", `${context}: interrupted outcome must target the restored call`);
	assert.equal(message.toolName, "fixture-tool", `${context}: interrupted outcome must keep the tool name`);
	assert.equal(message.isError, true, `${context}: interrupted outcome must be reported as an error`);
	assert.equal(outcome.terminate, false, `${context}: interrupted outcome must not terminate the run`);
	const content = normalize(message.content);
	assert.equal(
		content.length,
		2,
		`${context}: interrupted outcome must keep the durable checkpoint content and append the interruption marker`,
	);
	assert.deepEqual(
		content[0],
		{ type: "text", text: DURABLE_TEXT },
		`${context}: the durable checkpoint content must be published, not dropped`,
	);
	assert.equal(content[1].type, "text", `${context}: interruption marker must be a text block`);
	assert.ok(
		content[1].text.includes(INTERRUPTED_MARKER_FRAGMENT),
		`${context}: interruption marker must state that the external outcome is unknown, got ${JSON.stringify(content[1].text)}`,
	);
	assert.deepEqual(
		normalize(message.details),
		DURABLE_DETAILS,
		`${context}: durable checkpoint details must be preserved in the interrupted outcome`,
	);
}

function assertReplayed(bundle, context) {
	const { events, outcome } = bundle;
	const observed = Array.from(events);
	assert.deepEqual(
		observed,
		REPLAY_EVENTS,
		`${context}: both policies are safe and the batch is live, so the durable checkpoint must be cleared before ` +
			`the tool is invoked; observed events ${JSON.stringify(observed)}`,
	);
	assert.ok(outcome !== undefined, `${context}: replay must publish the tool outcome`);
	assert.equal(
		events.indexOf("clear") < events.indexOf("invoke"),
		true,
		`${context}: the replay checkpoint must be cleared before invoking the tool`,
	);
	const message = normalize(outcome.message);
	assert.equal(message.isError, false, `${context}: replayed tool outcome must not be an error`);
	assert.equal(outcome.recovery, true, `${context}: replayed invocation must be flagged as recovery`);
	assert.equal(outcome.terminate, false, `${context}: replayed invocation must not terminate the run`);
	const content = normalize(message.content);
	assert.deepEqual(
		content,
		[{ type: "text", text: "effect-result" }],
		`${context}: replay must publish the tool result`,
	);
	assert.deepEqual(
		normalize(outcome.args),
		{ persisted: 42 },
		`${context}: replay must re-run with the persisted arguments recovered from the durable checkpoint`,
	);
}

const failures = [];

async function scenario(context, body) {
	try {
		await body();
	} catch (error) {
		if (error instanceof assert.AssertionError) {
			failures.push(error.message);
			return;
		}
		throw error;
	}
}

await scenario("both policies safe", async () => {
	const bundle = await recover("safe", "safe", false);
	assertReplayed(bundle, "both policies safe");
});

await scenario("persisted safe, declaration never", async () => {
	const bundle = await recover("safe", "never", false);
	assertInterrupted(bundle, label("safe", "never", false));
});

await scenario("persisted never, declaration safe", async () => {
	const bundle = await recover("never", "safe", false);
	assertInterrupted(bundle, label("never", "safe", false));
});

await scenario("persisted safe, declaration absent", async () => {
	const bundle = await recover("safe", undefined, false);
	assertInterrupted(bundle, label("safe", undefined, false));
});

await scenario("persisted safe, declaration without policy", async () => {
	const bundle = await recover("safe", null, false);
	assertInterrupted(bundle, label("safe", null, false));
});

await scenario("neither policy safe", async () => {
	const bundle = await recover("never", "never", false);
	assertInterrupted(bundle, label("never", "never", false));
});

await scenario("both policies safe but cancelled", async () => {
	const bundle = await recover("safe", "safe", true);
	assertInterrupted(bundle, label("safe", "safe", true));
});

if (failures.length > 0) {
	assert.fail(
		`${failures.length} interrupted-recovery scenario(s) violated the replay safety invariant ` +
			`(replay needs persisted call policy AND current tool declaration safe, and no cancellation):\n- ${failures.join("\n- ")}`,
	);
}

console.log(
	"regression passed: 7 interrupted-recovery scenarios (conjunctive replay policy, cancellation, durable checkpoint publication)",
);
