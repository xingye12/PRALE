/**
 * Cross-module regression for "Recovery authorization must survive effect admission".
 *
 * Loads the real submitted production modules (drive/tools.ts -> execution/tools.ts ->
 * execution/effect-gate.ts) through subject.mjs and asserts the observable
 * authorization-to-effect chain. Every asynchronous ordering decision is driven by
 * explicit promises; no timers, randomness, network or credentials are used.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERRUPTION_MARKER = /external outcome is unknown/;

/** A promise whose settlement is controlled by the test. */
function deferred() {
	let settle;
	const promise = new Promise((resolve, reject) => {
		settle = { resolve, reject };
	});
	return { promise, resolve: (value) => settle.resolve(value), reject: (error) => settle.reject(error) };
}

/** Text payloads of a published tool outcome, tolerant of unexpected shapes. */
function texts(outcome) {
	const content = outcome?.message?.content;
	// Array.from rebuilds the list in this realm so strict deep equality is not
	// affected by the production modules' own realm prototypes.
	return Array.isArray(content)
		? Array.from(content, (item) => (item && typeof item.text === "string" ? item.text : ""))
		: [];
}

function position(events, name) {
	const index = events.indexOf(name);
	assert.notEqual(index, -1, `expected a ${JSON.stringify(name)} step, saw ${JSON.stringify(events)}`);
	return index;
}

const pipeline = await createExecutionPipeline(root);

/** A tool effect that the test releases explicitly, recording what the executor supplied. */
function controlledEffect(observed) {
	const entered = deferred();
	const release = deferred();
	return {
		entered: entered.promise,
		release: () => release.resolve(),
		effect: async ({ args, context, invocation }) => {
			observed.args = args;
			observed.context = context;
			observed.invocation = invocation;
			entered.resolve();
			await release.promise;
			return { content: [{ type: "text", text: `effect:${String(args.message)}` }], details: { kept: true }, usage: { output: 3 } };
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Both replay declarations safe: the executor consumes the persisted args,
//    the old checkpoint is cleared before invocation, and publication waits for
//    the external effect plus the durable progress drain.
// ---------------------------------------------------------------------------
{
	const observed = {};
	const effect = controlledEffect(observed);
	const drainEntered = deferred();
	const drainRelease = deferred();
	const published = [];
	const running = pipeline.run({
		persisted: "safe",
		declared: "safe",
		effect: effect.effect,
		progressDrain: () => {
			drainEntered.resolve();
			return drainRelease.promise;
		},
		onPublish: (value) => published.push(value),
	});

	await effect.entered;
	assert.deepEqual(published, [], "the tool outcome must not be published while the external effect is still running");

	effect.release();
	await drainEntered.promise;
	assert.deepEqual(published, [], "the tool outcome must not be published before durable progress drains");

	drainRelease.resolve();
	const result = await running;

	// Producer (drive) hands the cleared arguments to the consumer (executor).
	assert.deepEqual(observed.args, { message: "persisted-arguments" }, "the executor must run with the cleared/persisted arguments");
	assert.deepEqual(texts(result.outcome), ["effect:persisted-arguments"]);
	assert.equal(result.outcome.message.isError, false);
	assert.equal(result.outcome.message.toolCallId, "call-2");
	assert.equal(result.outcome.message.toolName, "fixture-tool");
	assert.equal(result.outcome.toolCall.id, "call-2");

	// The invocation handed to the tool is the drive-built durable capability.
	assert.equal(observed.invocation.invocationId, "result-2");
	assert.equal(observed.invocation.operationId, "op-1");
	assert.equal(observed.invocation.turnId, "turn-1");

	// Execution runs under the gate's signal, not an unrelated one.
	assert.equal(observed.context.abortSignal, result.gate.signal);

	// Ordering: clear durable checkpoint -> invoke effect -> effect done -> drain done -> publish.
	assert.ok(
		position(result.events, "clear") < position(result.events, "invoke"),
		`the old checkpoint must be cleared before invocation: ${JSON.stringify(result.events)}`,
	);
	assert.ok(position(result.events, "effect-complete") < position(result.events, "seal"));
	assert.ok(position(result.events, "drain-complete") < position(result.events, "publish"));
	assert.equal(result.events.at(-1), "publish");

	assert.equal(published.length, 1, "exactly one tool outcome must be published");
	assert.equal(published[0], result.outcome);
}

// ---------------------------------------------------------------------------
// 2. Replay is declared unsafe at either end of the chain: the interrupted
//    operation is never admitted and keeps its durable checkpoint evidence.
// ---------------------------------------------------------------------------
for (const replayCase of [
	{ name: "unsafe persisted declaration", persisted: "safe", declared: "never" },
	{ name: "unsafe tool declaration", persisted: "never", declared: "safe" },
]) {
	const result = await pipeline.run({ persisted: replayCase.persisted, declared: replayCase.declared });
	const content = texts(result.outcome);

	assert.equal(result.events.includes("invoke"), false, `${replayCase.name}: the tool effect must not run`);
	assert.equal(result.events.includes("effect-complete"), false, `${replayCase.name}: no effect may complete`);
	assert.equal(result.events.includes("clear"), false, `${replayCase.name}: an unsafe replay must not clear the durable checkpoint`);
	assert.deepEqual(content.slice(0, -1), ["checkpoint-evidence"], `${replayCase.name}: the durable checkpoint evidence must be preserved`);
	assert.match(content.at(-1) ?? "", INTERRUPTION_MARKER, `${replayCase.name}: the outcome must stay interrupted`);
	assert.equal(result.outcome.message.isError, true);
	assert.ok(position(result.events, "read") < position(result.events, "publish"));
}

// ---------------------------------------------------------------------------
// 3. A missing tool keeps the operation interrupted instead of executing.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ persisted: "safe", declared: undefined });
	const content = texts(result.outcome);

	assert.equal(result.events.includes("invoke"), false, "a missing tool must not execute");
	assert.equal(result.events.includes("clear"), false, "a missing tool must not clear the durable checkpoint");
	assert.deepEqual(content.slice(0, -1), ["checkpoint-evidence"]);
	assert.match(content.at(-1) ?? "", INTERRUPTION_MARKER);
	assert.equal(result.outcome.message.isError, true);
}

// ---------------------------------------------------------------------------
// 4. Cancellation before recovery keeps the operation interrupted.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ persisted: "safe", declared: "safe", cancelled: true });

	assert.equal(result.events.includes("invoke"), false, "a cancelled recovery must not execute");
	assert.equal(result.events.includes("clear"), false, "a cancelled recovery must not clear the durable checkpoint");
	assert.match(texts(result.outcome).at(-1) ?? "", INTERRUPTION_MARKER);
	assert.equal(result.outcome.message.isError, true);
}

// ---------------------------------------------------------------------------
// 5. An aborting gate refuses effect admission: no tool effect is entered, the
//    invocation is published as interrupted only after the drain.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ persisted: "safe", declared: "safe", gateState: "aborting" });

	assert.equal(result.events.includes("invoke"), false, `an aborting gate must refuse admission: ${JSON.stringify(result.events)}`);
	assert.equal(result.events.includes("effect-complete"), false, "an aborting gate must not let the effect complete");
	assert.match(texts(result.outcome).at(-1) ?? "", INTERRUPTION_MARKER);
	assert.equal(result.outcome.message.isError, true);
	assert.ok(position(result.events, "seal") < position(result.events, "drain-complete"));
	assert.ok(position(result.events, "drain-complete") < position(result.events, "publish"));
}

// ---------------------------------------------------------------------------
// 6. A closed gate refuses admission and surfaces its own error.
// ---------------------------------------------------------------------------
{
	const gateError = new Error("effect gate closed during recovery");
	await assert.rejects(
		pipeline.run({ persisted: "safe", declared: "safe", gateState: "closed", gateError }),
		(error) => error === gateError,
		"a closed gate must refuse effect admission with its own error",
	);
}

// ---------------------------------------------------------------------------
// 7. Gate module itself: admission is synchronous and state aware.
// ---------------------------------------------------------------------------
{
	const { AbortRequested, createGate } = pipeline.gate;

	assert.equal(
		createGate().gate.admit(() => "admitted"),
		"admitted",
		"an open gate must admit work synchronously",
	);

	let invoked = 0;
	const closed = createGate();
	const failure = new Error("closed gate");
	closed.control.close(failure);
	assert.throws(
		() => closed.gate.admit(() => (invoked += 1)),
		(error) => error === failure,
		"admission through a closed gate must throw the closing error",
	);
	assert.equal(invoked, 0, "a closed gate must not run the requested effect");
	assert.equal(closed.gate.signal.aborted, true);
	assert.equal(closed.gate.signal.reason, failure);

	const cancellation = Promise.resolve();
	const aborting = createGate();
	aborting.control.beginAbort(cancellation);
	assert.throws(
		() => aborting.gate.admit(() => (invoked += 1)),
		(error) => error instanceof AbortRequested && error.cancellation === cancellation,
		"cancellation must refuse admission with AbortRequested carrying the cancellation promise",
	);
	assert.equal(invoked, 0, "an aborting gate must not run the requested effect");
	assert.equal(aborting.gate.signal.aborted, false, "the abort signal only fires after cancellation commits");
}

console.log("recovery authorization regression: ok");
