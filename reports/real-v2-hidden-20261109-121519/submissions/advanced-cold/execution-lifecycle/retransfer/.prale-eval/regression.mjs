/**
 * Cross-module lifecycle fence regression.
 *
 * Loads the real recovery scheduler (runtime/drive/tools.ts), the real tool
 * executor (execution/tools.ts) and the real effect gate (execution/effect-gate.ts)
 * through `.prale-eval/subject.mjs`. Only durable checkpoint storage, progress
 * transport and event delivery are faked by the helper.
 *
 * Every assertion below is observable behavior across a module boundary and is
 * controlled with promises only: no timers, randomness, network or credentials.
 */
import assert from "node:assert/strict";
import { createExecutionPipeline } from "./subject.mjs";

const root = process.cwd();
const pipeline = await createExecutionPipeline(root);
const gateModule = await pipeline.graph.module("gate");
const executionModule = await pipeline.graph.module("execution");

/** Flush only microtask work so late callbacks have every chance to escape. */
async function settleMicrotasks() {
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function admittedError(gate) {
	try {
		gate.admit(() => "invoked");
	} catch (error) {
		return error;
	}
	return undefined;
}

function toolMessage(outcome) {
	assert.equal(typeof outcome, "object");
	assert.notEqual(outcome, null);
	assert.equal(outcome.message.role, "toolResult");
	return outcome.message;
}

function textOf(message) {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

// ---------------------------------------------------------------------------
// Gate: a closed gate is terminal; beginAbort can neither reopen it nor replace
// its terminal error. A still-open gate must keep refusing admission normally.
// ---------------------------------------------------------------------------
{
	const terminal = new Error("terminal gate error");
	const { gate, control } = gateModule.createGate();
	control.close(terminal);
	assert.equal(gate.signal.aborted, true);
	assert.equal(gate.signal.reason, terminal);
	assert.equal(admittedError(gate), terminal);

	// beginAbort after close must be a no-op rather than reviving the gate.
	control.beginAbort(Promise.resolve());
	const afterAbort = admittedError(gate);
	assert.equal(afterAbort, terminal, "beginAbort must not replace the terminal gate error");
	assert.notEqual(afterAbort instanceof gateModule.AbortRequested, true);
	assert.equal(gate.signal.reason, terminal);

	// A later signalAbort/close must keep the first terminal error as well.
	control.signalAbort();
	control.close(new Error("second terminal error"));
	assert.equal(admittedError(gate), terminal);
	assert.equal(gate.signal.reason, terminal);
}

{
	// Abort-first gates still refuse admission with AbortRequested and only
	// signal after cancellation commits; a second beginAbort keeps the first.
	let resolveCancellation;
	const cancellation = new Promise((resolve) => {
		resolveCancellation = resolve;
	});
	const { gate, control } = gateModule.createGate();
	control.beginAbort(cancellation);
	const first = admittedError(gate);
	assert.equal(first instanceof gateModule.AbortRequested, true);
	assert.equal(first.cancellation, cancellation);
	assert.equal(gate.signal.aborted, false);
	control.beginAbort(Promise.resolve());
	const second = admittedError(gate);
	assert.equal(second instanceof gateModule.AbortRequested, true);
	assert.equal(second.cancellation, cancellation);
	resolveCancellation();
	await cancellation;
	control.signalAbort();
	assert.equal(gate.signal.aborted, true);
}

// ---------------------------------------------------------------------------
// Executor + gate: a gate closed while (or before) execution is admitted must
// surface its terminal error and must never invoke the tool effect.
// ---------------------------------------------------------------------------
{
	let invoked = false;
	const terminal = new Error("executor terminal error");
	const cleared = {
		toolCall: { type: "toolCall", id: "call-direct", name: "fixture-tool", arguments: { message: "direct" } },
		tool: {
			name: "fixture-tool",
			async execute() {
				invoked = true;
				return { content: [], details: {} };
			},
		},
		args: { message: "direct" },
	};
	const invocation = { invocationId: "result-direct", operationId: "op-direct", turnId: "turn-direct" };
	const { gate, control } = gateModule.createGate();
	control.close(terminal);
	control.beginAbort(Promise.resolve());

	assert.throws(
		() => executionModule.executeToolCall(cleared, gate, () => {}, {}, invocation, {}),
		(error) => error === terminal,
		"terminal gate error must survive beginAbort",
	);
	assert.equal(invoked, false);
}

// ---------------------------------------------------------------------------
// Scheduler: a cancelled safe/safe recovery reads the durable checkpoint but
// never clears it and never re-invokes the effect; it publishes exactly once.
// ---------------------------------------------------------------------------
{
	const cancelled = await pipeline.run({ cancelled: true, persisted: "safe", declared: "safe" });
	assert.deepEqual(cancelled.events, ["read", "publish"]);
	assert.equal(cancelled.events.includes("clear"), false, "cancelled recovery must not clear the checkpoint");
	assert.equal(cancelled.events.includes("invoke"), false, "cancelled recovery must not invoke the tool");
	assert.equal(cancelled.events.filter((event) => event === "publish").length, 1);
	assert.deepEqual(cancelled.checkpoints, []);

	const message = toolMessage(cancelled.outcome);
	assert.equal(message.isError, true);
	assert.deepEqual(message.details, { step: 2 });
	assert.equal(message.usage, undefined);
	assert.match(textOf(message), /external outcome is unknown/);
	assert.match(textOf(message), /checkpoint-evidence/);
	assert.equal(message.content.at(-1).text.includes("external outcome is unknown"), true);
}

// Cancellation fences the effect even when only the persisted call is replayable
// and the tool itself advertises side effects (unsafe) - nothing may run.
{
	const cancelled = await pipeline.run({ cancelled: true, persisted: "never", declared: "never" });
	assert.equal(cancelled.events.includes("clear"), false);
	assert.equal(cancelled.events.includes("invoke"), false);
	assert.equal(cancelled.events.filter((event) => event === "publish").length, 1);
	assert.equal(toolMessage(cancelled.outcome).isError, true);
}

// ---------------------------------------------------------------------------
// Scheduler: a non-cancelled safe/safe recovery still completes, re-invokes
// with the persisted arguments, preserves usage/details and publishes once.
// ---------------------------------------------------------------------------
{
	let invokedArgs;
	const replayed = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		effect: async ({ args }) => {
			invokedArgs = args;
			return {
				content: [{ type: "text", text: args.message }],
				details: { kept: true },
				usage: { output: 3 },
			};
		},
	});
	assert.deepEqual(invokedArgs, { message: "persisted-arguments" });
	assert.deepEqual(replayed.events, ["clear", "invoke", "effect-complete", "seal", "drain", "drain-complete", "publish"]);
	assert.equal(replayed.events.filter((event) => event === "publish").length, 1);
	assert.ok(replayed.events.indexOf("seal") < replayed.events.indexOf("publish"));

	const message = toolMessage(replayed.outcome);
	assert.equal(message.isError, false);
	assert.equal(textOf(message), "persisted-arguments");
	assert.deepEqual(message.details, { kept: true });
	assert.deepEqual(message.usage, { output: 3 });
	assert.equal(replayed.outcome.terminate, false);
}

// ---------------------------------------------------------------------------
// Executor: live and checkpoint callbacks are sealed once the tool completes.
// A captured update callback invoked after completion must not emit an update
// event, write another checkpoint, or publish a second outcome.
// ---------------------------------------------------------------------------
{
	let lateUpdate;
	const completed = await pipeline.run({
		effect: async ({ args, update }) => {
			update({ content: [{ type: "text", text: "partial" }], details: { step: 1 } }, { checkpoint: true });
			lateUpdate = update;
			return {
				content: [{ type: "text", text: args.message }],
				details: { kept: true },
				usage: { output: 3 },
			};
		},
	});

	// Updates produced while the effect was live are still delivered once.
	assert.equal(completed.events.filter((event) => event === "update").length, 1);
	assert.deepEqual(completed.checkpoints, [{ content: [{ type: "text", text: "partial" }], details: { step: 1 } }]);
	assert.equal(completed.updates.length, 1);
	assert.equal(completed.events.filter((event) => event === "publish").length, 1);

	const frozenEvents = [...completed.events];
	const frozenUpdates = completed.updates.length;
	const frozenCheckpoints = completed.checkpoints.length;
	const frozenOutcome = JSON.stringify(completed.outcome);

	assert.equal(typeof lateUpdate, "function");
	lateUpdate({ content: [{ type: "text", text: "late" }], details: { step: 9 } }, { checkpoint: true });
	await settleMicrotasks();

	assert.deepEqual(completed.events, frozenEvents, "late update must not emit events after completion");
	assert.equal(completed.updates.length, frozenUpdates, "late update must not be delivered after completion");
	assert.equal(
		completed.checkpoints.length,
		frozenCheckpoints,
		"late checkpoint callback must not persist after completion",
	);
	assert.equal(JSON.stringify(completed.outcome), frozenOutcome, "late update must not republish an outcome");
	assert.equal(toolMessage(completed.outcome).isError, false);
}

// A failing effect also seals its live callback: the error result is final and
// late progress may not reopen the invocation.
{
	let lateUpdate;
	const failed = await pipeline.run({
		effect: async ({ update }) => {
			lateUpdate = update;
			throw new Error("effect failed");
		},
	});
	const message = toolMessage(failed.outcome);
	assert.equal(message.isError, true);
	assert.equal(textOf(message), "effect failed");
	assert.equal(failed.updates.length, 0);

	const frozenEvents = [...failed.events];
	lateUpdate({ content: [{ type: "text", text: "late" }], details: {} }, { checkpoint: true });
	await settleMicrotasks();
	assert.deepEqual(failed.events, frozenEvents);
	assert.equal(failed.updates.length, 0);
	assert.equal(failed.checkpoints.length, 0);
}

process.stdout.write("lifecycle fence regression: ok\n");
