#!/usr/bin/env node
/**
 * Cross-module regression for the recovered-tool progress/checkpoint/error transfer.
 *
 * Loads the real submitted modules through `.prale-eval/subject.mjs`:
 *   - packages/agent/src/harness/runtime/drive/tools.ts   (recovery -> progress channel -> publication)
 *   - packages/agent/src/harness/execution/tools.ts       (effect admission -> tool execute -> error output)
 *   - packages/agent/src/harness/execution/effect-gate.ts (admission / abort lifecycle)
 *
 * Every assertion is an uncaught `node:assert/strict` assertion. No timers, no
 * randomness, no external services: asynchronous ordering is controlled by
 * explicit promise hand-offs only. No files outside `.prale-eval/` are created.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function text(value) {
	return { content: [{ type: "text", text: value }] };
}

/** Project a value produced inside the sandbox graph onto plain host objects. */
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function updatePartials(updates) {
	return updates.filter((item) => item.type === "tool_update").map((item) => item.partialResult);
}

function indexOf(events, name) {
	return events.indexOf(name);
}

const pipeline = await createExecutionPipeline(root);
const { createGate, AbortRequested } = pipeline.gate;

// ---------------------------------------------------------------------------
// 1. effect gate: admission refusal, durable abort delivery, permanent close.
//    (packages/agent/src/harness/execution/effect-gate.ts)
// ---------------------------------------------------------------------------
{
	const { gate, control } = createGate();
	let deliveries = 0;
	gate.signal.addEventListener("abort", () => {
		deliveries += 1;
	});

	// No abort has been requested yet: work is admitted and the signal stays clear.
	let admitted = 0;
	gate.admit(() => {
		admitted += 1;
	});
	assert.equal(admitted, 1, "an open gate admits work");
	assert.equal(gate.signal.aborted, false, "an open gate does not signal abort");

	// An idle signalAbort is a no-op (no cancellation has been requested).
	control.signalAbort();
	assert.equal(gate.signal.aborted, false, "signalAbort without beginAbort does not fire");

	const cancellation = deferred();
	control.beginAbort(cancellation.promise);

	let refusal;
	try {
		gate.admit(() => "never admitted");
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof AbortRequested, "beginAbort refuses new effect admission");
	assert.equal(refusal.cancellation, cancellation.promise, "refusal carries the pending cancellation");
	assert.equal(gate.signal.aborted, false, "the interrupt waits for cancellation to become durable");

	cancellation.resolve();
	await cancellation.promise;
	control.signalAbort();

	assert.equal(gate.signal.aborted, true, "signalAbort reaches the already-admitted AbortSignal");
	assert.equal(deliveries, 1, "the admitted abort listener is interrupted exactly once");

	control.signalAbort();
	assert.equal(deliveries, 1, "repeated signalAbort delivery is idempotent");

	// A closed gate refuses work with its own error and is already interrupted.
	const closing = createGate();
	const failure = new Error("drive closed");
	closing.control.close(failure);
	assert.throws(
		() => closing.gate.admit(() => "never admitted"),
		(error) => error === failure,
		"a closed gate refuses work with the close error",
	);
	assert.equal(closing.gate.signal.aborted, true, "close also interrupts admitted work");
}

// ---------------------------------------------------------------------------
// 2. recovered tool: live progress is observable, only checkpoint=true is
//    durable, and the tool exception stays an error in the final message.
//    (drive/tools.ts producer + execution/tools.ts effect boundary)
// ---------------------------------------------------------------------------
{
	const liveOnly = { ...text("live-1"), details: { step: 1 } };
	const checkpointed = { ...text("durable"), details: { step: 2 } };
	const explicitlyLive = { ...text("live-2"), details: { step: 3 } };
	const explosion = new Error("tool exploded after checkpoint");

	const result = await pipeline.run({
		effect: async ({ update }) => {
			update(liveOnly);
			update(checkpointed, { checkpoint: true });
			update(explicitlyLive, { checkpoint: false });
			throw explosion;
		},
	});

	assert.deepEqual(
		plain(result.checkpoints),
		[checkpointed],
		"only the checkpoint=true update may become durable progress",
	);
	assert.deepEqual(
		plain(updatePartials(result.updates)),
		[liveOnly, checkpointed, explicitlyLive],
		"every admitted live update still reaches observers",
	);

	// Progress drain and update delivery both precede final publication.
	const seal = indexOf(result.events, "seal");
	const drain = indexOf(result.events, "drain");
	const drained = indexOf(result.events, "drain-complete");
	const published = indexOf(result.events, "publish");
	assert.ok(indexOf(result.events, "invoke") >= 0, "the recovered effect ran");
	assert.equal(result.events.filter((name) => name === "seal").length, 1, "progress is sealed once");
	assert.ok(drain >= 0 && drained === drain + 1, "progress is drained after sealing");
	assert.ok(seal < drain, "sealing precedes draining");
	assert.ok(drained < published, "final publication follows progress drain");
	for (const [index, event] of result.events.entries()) {
		if (event === "update") assert.ok(index < published, "every live update is delivered before publication");
		if (event === "checkpoint") assert.ok(index < seal, "every durable checkpoint precedes sealing");
	}

	// The failure survives finalization: it is an error result, not success.
	assert.equal(result.outcome.message.isError, true, "a tool exception remains an error in the final message");
	assert.deepEqual(
		plain(result.outcome.message.content),
		[{ type: "text", text: "tool exploded after checkpoint" }],
		"the final message carries the tool failure text",
	);
	assert.equal(result.outcome.terminate, false, "a failed recovered call does not terminate the run");

	// Nothing may be admitted once the invocation has been finalized.
	const updatesBefore = result.updates.length;
	const checkpointsBefore = result.checkpoints.length;
	result.callback({ ...text("late"), details: { late: true } }, { checkpoint: true });
	assert.equal(result.updates.length, updatesBefore, "a finalized invocation admits no late live updates");
	assert.equal(result.checkpoints.length, checkpointsBefore, "a finalized invocation admits no late checkpoints");
}

// ---------------------------------------------------------------------------
// 3. abort requested while the recovered effect is running: the interrupt must
//    reach that already-admitted tool's AbortSignal, and the interrupt must stop
//    further admission (the after_tool patch is refused).
//    (effect-gate.ts control -> execution/tools.ts admission -> drive/tools.ts)
// ---------------------------------------------------------------------------
{
	const observed = { hadSignal: false, abortedBefore: false, abortedAfter: false, deliveries: 0, reason: undefined };
	const patch = { content: [{ type: "text", text: "patched-by-hook" }], isError: false };

	const result = await pipeline.run({
		patch,
		effect: async ({ context, control }) => {
			const signal = context.abortSignal;
			observed.hadSignal = signal instanceof AbortSignal;
			observed.abortedBefore = signal.aborted;
			signal.addEventListener("abort", () => {
				observed.deliveries += 1;
			});
			const cancellation = deferred();
			control.beginAbort(cancellation.promise);
			cancellation.resolve();
			await cancellation.promise;
			control.signalAbort();
			observed.abortedAfter = signal.aborted;
			observed.reason = signal.reason;
			if (signal.aborted) throw new Error("cancelled effect");
			return text("finished without interruption");
		},
	});

	assert.equal(observed.hadSignal, true, "the executing tool receives an AbortSignal");
	assert.equal(observed.abortedBefore, false, "the signal is clear while the effect is admitted");
	assert.equal(observed.abortedAfter, true, "signalAbort reaches the already-admitted tool's AbortSignal");
	assert.equal(observed.deliveries, 1, "the tool's abort listener runs once");
	assert.ok(observed.reason instanceof Error, "the delivered reason is an Error");

	assert.equal(result.outcome.message.isError, true, "the interrupted effect is reported as an error");
	assert.deepEqual(
		plain(result.outcome.message.content),
		[{ type: "text", text: "cancelled effect" }],
		"the abort skipped the after_tool patch instead of rewriting the result",
	);
}

// ---------------------------------------------------------------------------
// 4. a gate that is already aborting never admits the external effect, and the
//    staged outcome is still a cancelled error rather than a success.
//    (effect-gate.ts admission + drive/tools.ts interruption staging)
// ---------------------------------------------------------------------------
{
	let executed = 0;
	const result = await pipeline.run({
		gateState: "aborting",
		effect: async () => {
			executed += 1;
			return text("must not run");
		},
	});

	assert.equal(executed, 0, "an aborting gate admits no external effect");
	assert.equal(result.events.includes("invoke"), false, "the tool body never runs after beginAbort");
	assert.equal(result.outcome.message.isError, true, "the refused invocation is an error result");
	assert.equal(result.checkpoints.length, 0, "a refused invocation persists no progress");
	assert.equal(result.events.includes("publish"), true, "the refused invocation is still published");
}

// ---------------------------------------------------------------------------
// 5. unrelated behavior stays intact: with an open gate the after_tool patch
//    still rewrites content while the tool's error flag is preserved.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({
		patch: { content: [{ type: "text", text: "patched-by-hook" }] },
		effect: async ({ update }) => {
			update(text("partial"), { checkpoint: true });
			throw new Error("failure kept");
		},
	});

	assert.deepEqual(plain(result.checkpoints), [text("partial")], "the checkpoint snapshot is persisted once");
	assert.deepEqual(
		plain(result.outcome.message.content),
		[{ type: "text", text: "patched-by-hook" }],
		"an open gate still applies the after_tool patch",
	);
	assert.equal(result.outcome.message.isError, true, "the patch does not clear the tool error flag");
}

// ---------------------------------------------------------------------------
// 6. successful recovered calls still publish a non-error result after drain.
// ---------------------------------------------------------------------------
{
	const result = await pipeline.run({
		effect: async ({ args, update }) => {
			update(text("working"), { checkpoint: true });
			return { content: [{ type: "text", text: `done:${args.message}` }], details: { kept: true } };
		},
	});

	assert.deepEqual(plain(result.checkpoints), [text("working")], "the successful call kept its checkpoint");
	assert.equal(result.outcome.message.isError, false, "a successful tool call is not an error");
	assert.deepEqual(plain(result.outcome.message.content), [{ type: "text", text: "done:persisted-arguments" }]);
	assert.ok(indexOf(result.events, "drain-complete") < indexOf(result.events, "publish"), "publication follows drain");
}

console.log("regression: live progress, durable checkpoints, errors and abort delivery agree across modules");
