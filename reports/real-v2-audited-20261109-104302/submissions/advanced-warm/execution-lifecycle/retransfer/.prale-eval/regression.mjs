/**
 * Lifecycle fence regression coverage.
 *
 * Loads the real submitted production modules through ./subject.mjs, which links
 * the real recovery scheduler (runtime/drive/tools.ts), the real tool executor
 * (execution/tools.ts) and the real effect gate (execution/effect-gate.ts).
 * Only external IO/provider boundaries (checkpoint store, progress transport,
 * hook delivery) are faked, and every async interleaving is driven by promises.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import process from "node:process";
import { createExecutionPipeline } from "./subject.mjs";

function count(events, name) {
	return events.filter((event) => event === name).length;
}

function indexOf(events, name) {
	return events.indexOf(name);
}

function textOf(message) {
	return (message.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const pipeline = await createExecutionPipeline(process.cwd());

/* ------------------------------------------------------------------ */
/* Scheduler: a cancelled recovery must neither clear nor invoke.       */
/* ------------------------------------------------------------------ */
{
	const effect = [];
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		arguments: { message: "persisted-arguments" },
		cancelled: true,
		effect: async ({ args, update }) => {
			effect.push(args);
			update({ content: [{ type: "text", text: "must not be live" }], details: { live: true } }, { checkpoint: true });
			return { content: [{ type: "text", text: "must not run" }], details: { ran: true }, usage: { output: 9 } };
		},
	});

	assert.equal(effect.length, 0, "cancelled recovery must not cross the external effect boundary");
	assert.equal(count(result.events, "invoke"), 0, "cancelled recovery must not invoke the tool");
	assert.equal(count(result.events, "clear"), 0, "cancelled recovery must not clear the replay checkpoint");
	assert.equal(count(result.events, "checkpoint"), 0, "cancelled recovery must not write new checkpoints");
	assert.equal(count(result.events, "update"), 0, "cancelled recovery must not emit live updates");
	assert.equal(count(result.events, "read"), 1, "cancelled recovery still reads its durable checkpoint evidence");
	assert.equal(count(result.events, "publish"), 1, "cancelled recovery publishes exactly one terminal outcome");
	assert.ok(indexOf(result.events, "read") < indexOf(result.events, "publish"), "checkpoint read precedes publication");

	assert.equal(result.outcome.message.isError, true, "cancelled recovery outcome is an error result");
	assert.match(textOf(result.outcome.message), /external outcome is unknown/, "interruption marker is reported");
	assert.match(textOf(result.outcome.message), /checkpoint-evidence/, "durable checkpoint content is preserved");
	assert.deepEqual(result.outcome.message.details, { step: 2 }, "durable checkpoint details are preserved");
	assert.equal(result.outcome.terminate, false, "cancelled recovery must not terminate the run");
}

/* ------------------------------------------------------------------ */
/* Scheduler: a non-cancelled safe/safe recovery still completes once. */
/* ------------------------------------------------------------------ */
{
	const effectArgs = [];
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		arguments: { message: "persisted-arguments" },
		cancelled: false,
		effect: async ({ args, update }) => {
			effectArgs.push(args);
			update({ content: [{ type: "text", text: "live partial" }], details: { live: true } }, { checkpoint: true });
			return {
				content: [{ type: "text", text: "recovered" }],
				details: { kept: "yes" },
				usage: { output: 3 },
			};
		},
	});

	assert.deepEqual(effectArgs, [{ message: "persisted-arguments" }], "cleared persisted arguments reach the effect");
	assert.equal(count(result.events, "clear"), 1, "safe/safe recovery clears the replay checkpoint once");
	assert.equal(count(result.events, "invoke"), 1, "safe/safe recovery invokes the tool once");
	assert.equal(count(result.events, "publish"), 1, "safe/safe recovery publishes exactly once");
	assert.ok(indexOf(result.events, "clear") < indexOf(result.events, "invoke"), "checkpoint clear precedes invocation");
	assert.ok(indexOf(result.events, "invoke") < indexOf(result.events, "publish"), "invocation precedes publication");
	assert.equal(result.checkpoints.length, 1, "checkpointed progress is written once");

	assert.equal(result.outcome.message.isError, false, "successful recovery is not an error result");
	assert.equal(textOf(result.outcome.message), "recovered", "recovered result content survives finalization");
	assert.deepEqual(result.outcome.message.details, { kept: "yes" }, "recovered details survive finalization");
	assert.deepEqual(result.outcome.message.usage, { output: 3 }, "recovered usage survives finalization");
}

/* ------------------------------------------------------------------ */
/* Executor (direct): settlement seals the live update callback.        */
/* ------------------------------------------------------------------ */
{
	const { gate } = pipeline.gate.createGate();
	const live = [];
	let lateUpdate;
	const tool = {
		name: "fixture-tool",
		replay: "never",
		async execute(_id, args, update) {
			update({ content: [{ type: "text", text: "live partial" }], details: { n: 1 } }, { checkpoint: true });
			lateUpdate = update;
			return { content: [{ type: "text", text: args.message }], details: { done: true }, usage: { output: 2 } };
		},
	};
	const invocation = {
		invocationId: "call-2",
		operationId: "op-1",
		turnId: "turn-1",
		async getMemo() {
			return undefined;
		},
		async setMemo() {},
	};
	const executed = await pipeline.execution.executeToolCall(
		{ toolCall: { id: "call-2", name: "fixture-tool", arguments: { message: "raw" } }, tool, args: { message: "raw" } },
		gate,
		(partial, options) => live.push({ partial, options }),
		undefined,
		invocation,
		{},
	);

	assert.equal(executed.isError, false, "executor reports the tool result");
	assert.equal(textOf({ content: executed.result.content }), "raw", "executor returns the tool output");
	assert.deepEqual(executed.result.usage, { output: 2 }, "executor preserves tool usage");
	assert.equal(live.length, 1, "live updates are delivered while the effect runs");
	assert.deepEqual(live[0].options, { checkpoint: true }, "update options are forwarded while running");

	typeof lateUpdate === "function" && lateUpdate({ content: [{ type: "text", text: "late" }], details: { n: 2 } });
	assert.equal(live.length, 1, "updates emitted after completion are dropped by the executor seal");
}

/* ------------------------------------------------------------------ */
/* Executor + scheduler: a completed tool cannot emit new updates or    */
/* fresh checkpoints through the recovery pipeline.                     */
/* ------------------------------------------------------------------ */
{
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		cancelled: false,
		effect: async ({ args, update }) => {
			update({ content: [{ type: "text", text: "live partial" }], details: { live: true } }, { checkpoint: true });
			return { content: [{ type: "text", text: args.message }], details: { kept: true }, usage: { output: 3 } };
		},
	});

	const updatesBefore = count(result.events, "update");
	const checkpointsBefore = count(result.events, "checkpoint");
	assert.equal(updatesBefore, 1, "exactly one live update is published during execution");
	assert.equal(checkpointsBefore, 1, "exactly one checkpoint is written during execution");

	assert.equal(typeof result.callback, "function", "the tool received a live update callback");
	result.callback({ content: [{ type: "text", text: "late" }], details: { late: true } }, { checkpoint: true });
	assert.equal(count(result.events, "update"), updatesBefore, "no update is published after completion");
	assert.equal(count(result.events, "checkpoint"), checkpointsBefore, "no checkpoint is written after completion");
	assert.equal(result.checkpoints.length, checkpointsBefore, "the progress transport saw no post-completion write");
}

/* ------------------------------------------------------------------ */
/* Gate: beginAbort cannot reopen a closed gate or replace its error.   */
/* ------------------------------------------------------------------ */
{
	const { gate, control } = pipeline.gate.createGate();
	const terminal = new Error("terminal");
	control.close(terminal);
	const reopened = deferred();
	control.beginAbort(reopened.promise);

	assert.throws(
		() => gate.admit(() => "ran"),
		(error) => error === terminal,
		"a closed gate keeps rejecting with its terminal error",
	);
	assert.equal(gate.signal.aborted, true, "a closed gate leaves its signal aborted");
	assert.equal(gate.signal.reason, terminal, "the abort reason stays the terminal error");

	control.signalAbort();
	assert.equal(gate.signal.reason, terminal, "signalAbort cannot replace the terminal reason");
}

/* ------------------------------------------------------------------ */
/* Gate: abort still works on an open gate (unchanged API behavior).    */
/* ------------------------------------------------------------------ */
{
	const { gate, control } = pipeline.gate.createGate();
	const cancellation = deferred();
	control.beginAbort(cancellation.promise);

	let refusal;
	try {
		gate.admit(() => "ran");
	} catch (error) {
		refusal = error;
	}
	assert.equal(refusal instanceof pipeline.gate.AbortRequested, true, "open gate refuses admission with AbortRequested");
	assert.equal(refusal.cancellation, cancellation.promise, "the refusal carries the cancellation promise");
	assert.equal(gate.signal.aborted, false, "the signal is not aborted before cancellation is durable");

	cancellation.resolve();
	await cancellation.promise;
	control.signalAbort();
	assert.equal(gate.signal.aborted, true, "signalAbort signals admitted work after cancellation");

	control.close(new Error("closed later"));
	assert.throws(
		() => gate.admit(() => "ran"),
		(error) => error.message === "closed later",
		"closing an aborting gate wins and becomes terminal",
	);
}

/* ------------------------------------------------------------------ */
/* Gate + scheduler: a closed gate refuses a fresh recovery effect.     */
/* ------------------------------------------------------------------ */
{
	const terminal = new Error("gate closed");
	const effect = [];
	let failure;
	try {
		await pipeline.run({
			persisted: "safe",
			declared: "safe",
			cancelled: false,
			gateState: "closed",
			gateError: terminal,
			effect: async ({ args }) => {
				effect.push(args);
				return { content: [{ type: "text", text: "must not run" }], details: {} };
			},
		});
	} catch (error) {
		failure = error;
	}

	assert.equal(failure, terminal, "a closed gate surfaces its terminal error to the recovery");
	assert.equal(effect.length, 0, "a closed gate blocks the recovery effect from running");
}

console.log("lifecycle fence regression: all cross-module assertions passed");
