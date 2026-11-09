/**
 * Cross-module regression: recovered tool progress/checkpoint/error lifecycle.
 *
 * Loads the submitted production modules (runtime/drive/tools.ts -> execution/tools.ts
 * -> execution/effect-gate.ts) through the read-only subject helper. Only checkpoint
 * storage, progress transport, hook delivery and the tool effect itself are faked;
 * completion, gate admission, progress draining and finalization run live.
 *
 * Asynchronous ordering is controlled exclusively with promises: no timers, no
 * randomness, no IO, no external services.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function textOf(result) {
	return (result?.content ?? [])
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("");
}

function indexOfEvent(events, type) {
	const index = events.indexOf(type);
	assert.notEqual(index, -1, `expected a ${type} event in ${JSON.stringify(events)}`);
	return index;
}

function lastIndexOfEvent(events, type) {
	const index = events.lastIndexOf(type);
	assert.notEqual(index, -1, `expected a ${type} event in ${JSON.stringify(events)}`);
	return index;
}

const pipeline = await createExecutionPipeline(root);

// 1. A recovered, safely replayed tool emits live progress, an explicit checkpoint,
//    more live progress, another checkpoint, then fails.
{
	const checkpointOne = { content: [{ type: "text", text: "checkpoint-1" }], details: { step: 1 } };
	const liveOnly = { content: [{ type: "text", text: "live-1" }], details: { step: 2 } };
	const checkpointTwo = { content: [{ type: "text", text: "checkpoint-2" }], details: { step: 3 } };
	const failure = await pipeline.run({
		effect: async ({ update }) => {
			update(checkpointOne, { checkpoint: true });
			update(liveOnly);
			update(checkpointTwo, { checkpoint: true });
			throw new Error("tool exploded");
		},
	});

	// Every admitted live update reached the observer, in emission order.
	assert.deepEqual(
		failure.updates.map(({ partialResult }) => partialResult),
		[checkpointOne, liveOnly, checkpointTwo],
	);
	// Only the checkpoint=true updates were persisted; the live-only update was not.
	assert.deepEqual(failure.checkpoints, [checkpointOne, checkpointTwo]);
	// The recovered tool really executed (safe replay) after clearing its checkpoint.
	assert.ok(indexOfEvent(failure.events, "clear") < indexOfEvent(failure.events, "invoke"));
	// A tool exception stays an error in the final durable message and tool_end event.
	assert.equal(failure.outcome.message.isError, true);
	assert.equal(textOf(failure.outcome.message), "tool exploded");
	assert.equal(failure.outcome.terminate, false);

	// Checkpoint persistence and live delivery both settle before progress drains,
	// and final publication happens only after the drain completed.
	assert.ok(indexOfEvent(failure.events, "checkpoint") < indexOfEvent(failure.events, "seal"));
	assert.ok(lastIndexOfEvent(failure.events, "update") < indexOfEvent(failure.events, "drain"));
	assert.ok(indexOfEvent(failure.events, "drain-complete") < indexOfEvent(failure.events, "publish"));
	assert.equal(failure.events.at(-1), "publish");
}

// 2. Publication is withheld until the pending progress drain finishes, and a live
//    update without checkpoint=true is observed but never persisted.
{
	const drainStarted = deferred();
	const releaseDrain = deferred();
	const liveOnly = { content: [{ type: "text", text: "live-only" }], details: { progress: "live" } };
	const publications = [];
	const running = pipeline.run({
		effect: async ({ update }) => {
			update(liveOnly);
			return { content: [{ type: "text", text: "finished" }], details: { kept: true } };
		},
		progressDrain: async () => {
			drainStarted.resolve();
			await releaseDrain.promise;
		},
		onPublish: (value) => publications.push(value),
	});

	await drainStarted.promise;
	assert.equal(publications.length, 0, "final publication must wait for the progress drain");
	releaseDrain.resolve();
	const drained = await running;

	assert.equal(publications.length, 1);
	assert.equal(publications[0], drained.outcome);
	assert.deepEqual(drained.updates.map(({ partialResult }) => partialResult), [liveOnly]);
	assert.deepEqual(drained.checkpoints, []);
	assert.equal(drained.outcome.message.isError, false);
	assert.equal(textOf(drained.outcome.message), "finished");
	assert.ok(lastIndexOfEvent(drained.events, "update") < indexOfEvent(drained.events, "drain"));
	assert.ok(indexOfEvent(drained.events, "drain-complete") < indexOfEvent(drained.events, "publish"));
	assert.equal(drained.events.at(-1), "publish");
}

// 3. An abort signalled while a tool is admitted reaches that tool's AbortSignal;
//    the task still drains progress and publishes its final outcome.
{
	const started = deferred();
	const release = deferred();
	const cancellation = deferred();
	let admittedSignal;
	let abortsObserved = 0;
	let control;
	const running = pipeline.run({
		effect: async ({ context, control: gateControl }) => {
			admittedSignal = context.abortSignal;
			control = gateControl;
			admittedSignal.addEventListener("abort", () => {
				abortsObserved += 1;
			});
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "returned after abort" }], details: {} };
		},
	});

	await started.promise;
	control.beginAbort(cancellation.promise);
	assert.equal(admittedSignal.aborted, false, "beginAbort alone must not pull the admitted signal");
	control.signalAbort();
	assert.equal(admittedSignal.aborted, true, "signalAbort must abort the already-admitted tool signal");
	assert.equal(abortsObserved, 1, "the admitted tool must observe the abort event");
	assert.equal(admittedSignal.reason?.name, "AbortError");
	release.resolve();

	const aborted = await running;
	assert.ok(indexOfEvent(aborted.events, "drain-complete") < indexOfEvent(aborted.events, "publish"));
	assert.equal(aborted.events.at(-1), "publish");
}

// 4. Gate lifecycle inside the same gate module the drive uses: beginAbort closes
//    ordinary admission synchronously, signalAbort only fires afterwards, and close
//    refuses admission with its own error while aborting with that reason.
{
	const { gate, control } = pipeline.gate.createGate();
	const cancellation = Promise.resolve();
	control.beginAbort(cancellation);
	let admitted = 0;
	assert.throws(
		() =>
			gate.admit(() => {
				admitted += 1;
			}),
		(error) => error instanceof pipeline.gate.AbortRequested && error.cancellation === cancellation,
	);
	assert.equal(admitted, 0, "no new effect may be admitted after beginAbort");
	assert.equal(gate.signal.aborted, false);

	control.signalAbort();
	assert.equal(gate.signal.aborted, true);
	control.signalAbort();
	assert.equal(gate.signal.aborted, true);

	const closed = pipeline.gate.createGate();
	const reason = new Error("closed gate");
	closed.control.close(reason);
	assert.throws(
		() =>
			closed.gate.admit(() => {
				admitted += 1;
			}),
		(error) => error === reason,
	);
	assert.equal(admitted, 0);
	assert.equal(closed.gate.signal.aborted, true);
	assert.equal(closed.gate.signal.reason, reason);
}

// 5. Execution boundary directly: a tool throw becomes error output (never a success
//    result) while both admitted live updates, checkpointed or not, are delivered.
{
	const { gate } = pipeline.gate.createGate();
	const observed = [];
	const tool = {
		name: "fixture-tool",
		async execute(_id, args, onUpdate) {
			onUpdate({ content: [{ type: "text", text: "partial" }], details: { step: 1 } });
			onUpdate({ content: [{ type: "text", text: "checkpoint" }], details: { step: 2 } }, { checkpoint: true });
			throw new Error(args.message);
		},
	};
	const executed = await pipeline.execution.executeToolCall(
		{ toolCall: { id: "call-1", name: "fixture-tool", arguments: { message: "boom" } }, tool, args: { message: "boom" } },
		gate,
		(partial, options) => observed.push({ partial, options }),
		undefined,
		{ invocationId: "result-1", operationId: "op-1", turnId: "turn-1", getMemo: async () => undefined, setMemo: async () => {} },
		{},
	);
	assert.equal(executed.isError, true);
	assert.equal(textOf(executed.result), "boom");
	assert.deepEqual(
		observed.map(({ partial }) => textOf(partial)),
		["partial", "checkpoint"],
	);
	assert.equal(observed[1].options?.checkpoint, true);
}

// 6. A recovered tool that declared replay nor persisted one is not executed again:
//    the checkpoint evidence plus an explicit interruption marker is published.
{
	const interrupted = await pipeline.run({ persisted: "never" });
	assert.equal(interrupted.events.includes("invoke"), false);
	assert.ok(indexOfEvent(interrupted.events, "read") < indexOfEvent(interrupted.events, "publish"));
	assert.equal(interrupted.updates.length, 0);
	assert.equal(interrupted.checkpoints.length, 0);
	assert.equal(interrupted.outcome.message.isError, true);
	assert.match(textOf(interrupted.outcome.message), /checkpoint-evidence/);
	assert.match(textOf(interrupted.outcome.message), /Tool execution was interrupted/);
}

console.log("regression: live progress, checkpoints, errors and abort delivery agree across modules");
