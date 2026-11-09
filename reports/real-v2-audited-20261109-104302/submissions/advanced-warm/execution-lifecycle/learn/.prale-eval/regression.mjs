/**
 * Executable cross-module regression for the recovery authorization chain.
 *
 * Loads the real submitted modules (drive/tools.ts -> execution/tools.ts ->
 * execution/effect-gate.ts) through the read-only subject helper. Only the
 * checkpoint store, publication sink and progress transport are faked, so the
 * asserted ordering is the ordering of the real code under test.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 *
 * Every assertion is an uncaught node:assert/strict failure. No file inputs are
 * produced; all observations live in memory for the duration of this process.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createExecutionPipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERRUPTED = /Tool execution was interrupted/;

const pipeline = await createExecutionPipeline(root);

const textOf = (content) =>
	(content ?? []).filter((part) => part.type === "text").map((part) => part.text);

const order = (events) => (name) => events.indexOf(name);

/** Assert the recovered invocation was published as an interruption, never executed. */
function assertInterrupted(result, label, options = {}) {
	assert.equal(result.events.filter((event) => event === "publish").length, 1, `${label}: publish once`);
	assert.equal(result.events.includes("invoke"), false, `${label}: tool effect must not run`);
	assert.equal(result.events.includes("effect-complete"), false, `${label}: no external effect completes`);
	assert.equal(result.events.includes("clear"), options.cleared === true, `${label}: replay checkpoint handling`);
	assert.equal(result.events.includes("read"), options.cleared !== true,
		`${label}: durable checkpoint must be read`);
	assert.equal(result.outcome.message.isError, true, `${label}: interruption is an error result`);
	const texts = textOf(result.outcome.message.content);
	assert.match(texts.at(-1) ?? "", INTERRUPTED, `${label}: interruption marker is appended last`);
	return texts;
}

// ---------------------------------------------------------------------------
// 1. gate module: cancellation and closure must reject admission synchronously.
// ---------------------------------------------------------------------------
{
	const { createGate, AbortRequested } = pipeline.gate;
	let calls = 0;
	const open = createGate();
	assert.equal(open.gate.admit(() => {
		calls += 1;
		return "admitted";
	}), "admitted", "open gate admits the effect");

	const cancellation = Promise.resolve();
	open.control.beginAbort(cancellation);
	assert.throws(() => open.gate.admit(() => {
		calls += 1;
		return "admitted";
	}), (error) => error instanceof AbortRequested && error.cancellation === cancellation,
	"aborting gate rejects admission with AbortRequested");
	assert.equal(calls, 1, "aborting gate never invokes the admitted callback");

	const closed = createGate();
	const closedError = new Error("drive pass closed");
	closed.control.close(closedError);
	assert.throws(() => closed.gate.admit(() => {
		calls += 1;
		return "admitted";
	}), (error) => error === closedError, "closed gate rejects admission with its close error");
	assert.equal(calls, 1, "closed gate never invokes the admitted callback");
}

// ---------------------------------------------------------------------------
// 2. executor module: the cleared/persisted arguments are the executed ones.
// ---------------------------------------------------------------------------
{
	const { gate, control } = pipeline.gate.createGate();
	let received;
	const tool = {
		name: "fixture-tool",
		replay: "safe",
		async execute(_id, args) {
			received = args;
			return { content: [{ type: "text", text: args.message }] };
		},
	};
	const cleared = {
		toolCall: { id: "call-direct", name: "fixture-tool", arguments: { message: "raw-model-arguments" } },
		tool,
		args: { message: "persisted-arguments" },
	};
	const invocation = {
		invocationId: "result-direct",
		operationId: "op-direct",
		turnId: "turn-direct",
		getMemo: async () => undefined,
		setMemo: async () => {},
	};
	const executed = await pipeline.execution.executeToolCall(cleared, gate, () => {}, {}, invocation, {});
	control.close(new Error("done with this gate"));
	assert.deepEqual(received, { message: "persisted-arguments" }, "executor passes cleared args, not model args");
	assert.equal(executed.isError, false, "cleared execution succeeds");
	assert.equal(textOf(executed.result.content)[0], "persisted-arguments", "tool observed persisted args");
}

// ---------------------------------------------------------------------------
// 3. Recovery chain: clear before invoke, publish only after effect + drain.
// ---------------------------------------------------------------------------
{
	const observations = { publishedDuringEffect: 0, publishedDuringDrain: 0, published: 0, args: undefined };
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		onPublish: () => {
			observations.published += 1;
		},
		effect: async ({ args, update }) => {
			observations.args = args;
			observations.publishedDuringEffect = observations.published;
			update({ content: [{ type: "text", text: "latest durable snapshot" }], details: { step: 1 } }, { checkpoint: true });
			await Promise.resolve(); // deterministic microtask boundary inside the effect
			return {
				content: [{ type: "text", text: args.message }],
				details: { kept: true },
				usage: { output: 3 },
			};
		},
		progressDrain: async () => {
			observations.publishedDuringDrain = observations.published;
			await Promise.resolve(); // drain is only complete after the next microtask
		},
	});

	const { events } = result;
	const at = order(events);
	assert.equal(events[0], "clear", "replay checkpoint is cleared before anything else");
	assert.ok(at("invoke") > at("clear"), "checkpoint clearing precedes invocation");
	assert.ok(at("checkpoint") > at("invoke"), "progress checkpoint is written by the running effect");
	assert.ok(at("effect-complete") > at("checkpoint"), "effect completes after progress");
	assert.ok(at("seal") > at("effect-complete"), "progress is sealed once the effect settles");
	assert.ok(at("drain") > at("seal"), "durable progress drains after sealing");
	assert.ok(at("drain-complete") > at("drain"), "drain completes");
	assert.equal(events.filter((event) => event === "publish").length, 1, "outcome published exactly once");
	assert.equal(events.at(-1), "publish", "publication is the final lifecycle step");
	assert.ok(at("drain-complete") < at("publish"), "publication waits for durable progress drain");
	assert.ok(at("effect-complete") < at("publish"), "publication waits for the effect");

	assert.equal(observations.publishedDuringEffect, 0, "no publication before the effect finishes");
	assert.equal(observations.publishedDuringDrain, 0, "no publication while durable progress is draining");
	assert.equal(observations.published, 1, "publication happens after the invocation completes");
	assert.deepEqual(observations.args, { message: "persisted-arguments" }, "effect receives persisted args");

	assert.equal(result.checkpoints.length, 1, "checkpoint snapshot written once");
	assert.deepEqual(result.checkpoints[0]?.details, { step: 1 }, "checkpoint snapshot is the effect progress");
	assert.equal(result.updates.length, 1, "one live update emitted");
	assert.equal(result.updates[0].type, "tool_update", "live update event type");
	assert.equal(result.updates[0].recovery, true, "live update is marked as recovery");
	assert.equal(result.updates[0].toolCallId, "call-2", "live update addresses the recovered call");

	assert.equal(result.outcome.message.isError, false, "successful replay is not an error");
	assert.equal(textOf(result.outcome.message.content)[0], "persisted-arguments", "result carries replay arguments");
	assert.deepEqual(result.outcome.message.details, { kept: true }, "result details preserved");
	assert.deepEqual(result.outcome.message.usage, { output: 3 }, "result usage preserved");
	assert.equal(result.outcome.terminate, false, "replay does not terminate the turn");
}

// ---------------------------------------------------------------------------
// 4. Both replay declarations must be safe.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ persisted: "never", declared: "safe", cancelled: false });
	const texts = assertInterrupted(result, "unsafe persisted declaration");
	assert.equal(texts[0], "checkpoint-evidence", "durable checkpoint snapshot is preserved in the interruption");
	assert.deepEqual(result.outcome.message.details, { step: 2 }, "checkpoint details are preserved");
}
{
	const result = await pipeline.run({ persisted: "safe", declared: "never", cancelled: false });
	assertInterrupted(result, "unsafe tool replay declaration");
}
{
	// A tool that vanished between runs must stay interrupted, never invoked.
	const result = await pipeline.run({ persisted: "safe", declared: undefined, cancelled: false });
	assertInterrupted(result, "missing tool");
}

// ---------------------------------------------------------------------------
// 5. Cancellation and a missing tool context never reach the effect.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ persisted: "safe", declared: "safe", cancelled: true });
	assertInterrupted(result, "cancelled recovery");
}
{
	// The gate is aborting but the abort signal was not raised: only admission
	// state can stop the effect, so an unchecked gate would run stale arguments.
	let effectRan = false;
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		gateState: "aborting",
		effect: async () => {
			effectRan = true;
			return { content: [{ type: "text", text: "stale effect" }] };
		},
	});
	// The cleared arguments are consumed before admission, but the effect never runs.
	assertInterrupted(result, "aborting gate", { cleared: true });
	assert.equal(effectRan, false, "aborting gate prevents the external effect");
	assert.ok(result.events.indexOf("drain") < result.events.indexOf("publish"),
		"aborted recovery still drains progress before publishing");
}
{
	let effectRan = false;
	await assert.rejects(
		pipeline.run({
			persisted: "safe",
			declared: "safe",
			gateState: "closed",
			effect: async () => {
				effectRan = true;
				return { content: [{ type: "text", text: "stale effect" }] };
			},
		}),
		/closed gate/,
		"closed gate aborts the drive pass",
	);
	assert.equal(effectRan, false, "closed gate prevents the external effect");
}

process.stdout.write("regression: OK\n");
