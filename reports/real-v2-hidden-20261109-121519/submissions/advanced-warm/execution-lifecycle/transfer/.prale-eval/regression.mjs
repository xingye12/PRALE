/**
 * Regression evidence for advanced/execution-lifecycle/transfer.
 *
 * Exercises the real recovered-tool path end to end: the private recovery entry
 * in `runtime/drive/tools.ts`, the real executor/finalizer in
 * `execution/tools.ts`, the real effect gate in `execution/effect-gate.ts`, and
 * the real placement helpers in `runtime/drive/tool-placement.ts` that resolve
 * the recovered call. Only external boundaries (checkpoint store, progress
 * transport, hook delivery, outcome publication) are faked by the read-only
 * subject helper. No timers, randomness, network or real time are used:
 * asynchronous ordering is controlled exclusively with promises.
 *
 * Contract under test:
 *  1. Every admitted live update reaches observers; only `checkpoint: true`
 *     updates are persisted as durable progress.
 *  2. A tool exception stays an error in the final published message.
 *  3. Final publication happens only after progress has been drained.
 *  4. `signalAbort()` delivers cancellation to the already-admitted tool's
 *     AbortSignal.
 *  5. No new effect may be admitted after `beginAbort`.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createExecutionPipeline } from "./subject.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function textOf(message) {
	return (message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function indexOfEvent(events, name) {
	const index = events.indexOf(name);
	assert.notEqual(index, -1, `expected a ${name} event in ${JSON.stringify(events)}`);
	return index;
}

const pipeline = await createExecutionPipeline(root);

// ---------------------------------------------------------------------------
// 1. Recovered tool: live progress, an explicit checkpoint, then a failure.
// ---------------------------------------------------------------------------
{
	const liveOne = { content: [{ type: "text", text: "live-1" }], details: { step: 1 } };
	const liveTwo = { content: [{ type: "text", text: "live-2" }], details: { step: 2 } };
	const checkpoint = { content: [{ type: "text", text: "durable" }], details: { step: 3 } };

	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		effect: async ({ update }) => {
			update(liveOne);
			update(liveTwo);
			update(checkpoint, { checkpoint: true });
			throw new Error("tool failed after checkpoint");
		},
	});

	// Every admitted live update still reaches observers, in call order.
	assert.deepEqual(
		result.updates.map((event) => event.partialResult),
		[liveOne, liveTwo, checkpoint],
		"all admitted live updates must reach observers",
	);
	assert.deepEqual(
		result.checkpoints,
		[checkpoint],
		"only updates marked checkpoint: true may be persisted",
	);
	assert.equal(
		result.events.filter((name) => name === "checkpoint").length,
		1,
		"exactly one durable progress write is expected",
	);

	// A tool exception remains an error in the final message.
	assert.equal(result.outcome?.message.isError, true, "a failed tool must publish an error result");
	assert.equal(textOf(result.outcome?.message), "tool failed after checkpoint");
	assert.equal(result.outcome?.terminate, false);

	// Sealing happens before the drain, and publication follows the drain.
	const seal = indexOfEvent(result.events, "seal");
	const drain = indexOfEvent(result.events, "drain");
	const drained = indexOfEvent(result.events, "drain-complete");
	const publish = indexOfEvent(result.events, "publish");
	assert.ok(seal < drain, "progress must be sealed before draining");
	assert.ok(drain < drained, "drain must complete after it starts");
	assert.ok(drained < publish, "final publication must follow progress drain");
	assert.ok(
		result.events.lastIndexOf("update") < drained,
		"all live updates must be admitted before the drain completes",
	);
}

// ---------------------------------------------------------------------------
// 2. Live-only progress is never persisted, and publication waits for a drain
//    that is still pending.
// ---------------------------------------------------------------------------
{
	const published = deferred();
	const drainReached = deferred();
	const releaseDrain = deferred();
	let drainFinished = false;
	let publishObservedDrain = undefined;

	const running = pipeline.run({
		effect: async ({ update }) => {
			update({ content: [{ type: "text", text: "live-only" }], details: { step: 1 } });
			return { content: [{ type: "text", text: "done" }], details: { ok: true } };
		},
		progressDrain: async () => {
			drainReached.resolve();
			await releaseDrain.promise;
			drainFinished = true;
		},
		onPublish: () => {
			publishObservedDrain = drainFinished;
			published.resolve();
		},
	});

	await drainReached.promise;
	// Drain is still pending here: publication must not have happened yet.
	assert.equal(drainFinished, false, "drain is expected to still be pending");
	releaseDrain.resolve();
	const result = await running;
	await published.promise;

	assert.equal(publishObservedDrain, true, "publication must wait for the progress drain to finish");
	assert.deepEqual(result.checkpoints, [], "live updates without checkpoint: true must not be persisted");
	assert.equal(result.outcome?.message.isError, false);
	assert.equal(textOf(result.outcome?.message), "done");
	assert.ok(
		indexOfEvent(result.events, "drain-complete") < indexOfEvent(result.events, "publish"),
		"publish must be the last step after drain completion",
	);
}

// ---------------------------------------------------------------------------
// 3. Signaling an abort reaches the already-admitted tool's AbortSignal while
//    new effects are refused.
// ---------------------------------------------------------------------------
{
	const cancellation = deferred();
	let signal;
	let abortedDuringEffect;
	let listenerFired = false;
	let refusal;
	let refusalCancellation;

	const result = await pipeline.run({
		effect: async ({ context, control }) => {
			signal = context.abortSignal;
			assert.ok(signal instanceof AbortSignal, "admitted tool must receive an AbortSignal");
			signal.addEventListener("abort", () => {
				listenerFired = true;
			});
			control.beginAbort(cancellation.promise);
			control.signalAbort();
			abortedDuringEffect = signal.aborted;
			return { content: [{ type: "text", text: "still returned" }], details: {} };
		},
	});

	assert.equal(abortedDuringEffect, true, "signalAbort must abort the admitted tool's signal");
	assert.equal(signal.aborted, true);
	assert.equal(listenerFired, true, "an abort listener on the admitted signal must fire");

	// No new effect may be admitted through the gate once beginAbort ran.
	try {
		result.gate.admit(() => "admitted");
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof Error, "the gate must refuse admission after beginAbort");
	assert.equal(refusal.name, "AbortRequested");
	assert.equal(refusal.cancellation, cancellation.promise);
	cancellation.resolve();
}

// ---------------------------------------------------------------------------
// 4. beginAbort before admission: the effect is never invoked and a synthetic
//    interrupted outcome is published instead.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ gateState: "aborting" });
	assert.equal(result.events.includes("invoke"), false, "no new effect may be admitted after beginAbort");
	assert.equal(result.updates.length, 0);
	assert.equal(result.checkpoints.length, 0);
	assert.equal(result.outcome?.message.isError, true);
	assert.match(
		textOf(result.outcome?.message),
		/external outcome is unknown/,
		"an effect refused by the aborting gate must publish the interrupted outcome",
	);
	assert.ok(
		indexOfEvent(result.events, "drain-complete") < indexOfEvent(result.events, "publish"),
		"even a cancelled outcome publishes after the drain",
	);
}

// ---------------------------------------------------------------------------
// 5. Cancelled recovery keeps the durable checkpoint evidence and stays error.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({ cancelled: true });
	assert.equal(result.events.includes("invoke"), false, "a cancelled recovery must not run the tool");
	assert.equal(result.outcome?.message.isError, true);
	assert.match(textOf(result.outcome?.message), /checkpoint-evidence/);
	assert.match(textOf(result.outcome?.message), /external outcome is unknown/);
	assert.deepEqual(result.checkpoints, []);
}

console.log("execution lifecycle transfer regression: ok");
