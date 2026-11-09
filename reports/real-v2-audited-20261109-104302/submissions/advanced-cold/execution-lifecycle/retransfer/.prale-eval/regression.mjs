/**
 * Cross-module regression for the execution lifecycle fences.
 *
 * The submitted production modules are loaded through `.prale-eval/subject.mjs`:
 * the real recovery procedure (`runtime/drive/tools.ts`), the real tool executor
 * (`execution/tools.ts`) and the real effect gate (`execution/effect-gate.ts`) all
 * run live. Only checkpoint storage, progress transport, hook delivery and tool
 * bodies are replaced by promises/records so ordering is fully deterministic.
 *
 * Three independent fences are asserted:
 *  1. effect-gate: `beginAbort` cannot reopen a closed gate or displace its terminal error.
 *  2. execution/tools: completion seals live and checkpoint-bearing update callbacks.
 *  3. runtime/drive/tools: a cancelled recovery neither clears its checkpoint nor invokes the tool.
 * A fourth group asserts the fences do not over-reach: non-cancelled `safe`/`safe`
 * recovery still completes, preserves usage/details and publishes exactly once.
 */
import assert from "node:assert/strict";
import { createExecutionPipeline } from "./subject.mjs";

const root = process.cwd();
const pipeline = await createExecutionPipeline(root);

/** Let every queued microtask/thenable chain settle; no real timers are used. */
const settle = async () => {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
};

const invocation = {
	invocationId: "result-2",
	operationId: "op-1",
	turnId: "turn-1",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

const gate = pipeline.gate;
const execution = pipeline.execution;
assert.equal(typeof gate.createGate, "function", "effect-gate module must be loaded");
assert.equal(typeof execution.executeToolCall, "function", "execution/tools module must be loaded");

/* ------------------------------------------------------------------ *
 * 1. Effect gate fence: cancellation never reopens a closed gate.
 * ------------------------------------------------------------------ */
{
	const { gate: liveGate, control } = gate.createGate();
	const terminal = new Error("terminal gate failure");

	// Closing owns the terminal error and aborts the admitted work.
	control.close(terminal);
	assert.throws(
		() => liveGate.admit(() => "admitted"),
		(error) => error === terminal,
		"a closed gate refuses admission with its terminal error",
	);
	assert.equal(liveGate.signal.aborted, true);
	assert.equal(liveGate.signal.reason, terminal);

	// A cancellation that arrives after the gate closed must not reopen it.
	control.beginAbort(Promise.resolve());
	assert.equal(liveGate.signal.reason, terminal, "late cancellation must not replace the terminal abort reason");
	assert.throws(
		() => liveGate.admit(() => "admitted"),
		(error) => {
			assert.equal(error, terminal, "late beginAbort reopened the closed gate");
			return true;
		},
		"beginAbort must not reopen a closed gate",
	);
	control.signalAbort();
	assert.equal(liveGate.signal.reason, terminal, "late signalAbort must not replace the terminal abort reason");

	// Closing twice keeps the first terminal error, and closing after an abort still wins.
	control.close(new Error("second close"));
	assert.throws(
		() => liveGate.admit(() => "admitted"),
		(error) => error === terminal,
	);

	const aborting = gate.createGate();
	const first = Promise.resolve();
	aborting.control.beginAbort(first);
	aborting.control.beginAbort(Promise.resolve());
	let refusal;
	try {
		aborting.gate.admit(() => "admitted");
	} catch (error) {
		refusal = error;
	}
	assert.equal(refusal?.name, "AbortRequested", "an aborted-open gate refuses admission");
	assert.equal(refusal.cancellation, first, "beginAbort must keep the first cancellation while aborting");
	const closingWhileAborting = new Error("closed during abort");
	aborting.control.close(closingWhileAborting);
	assert.throws(
		() => aborting.gate.admit(() => "admitted"),
		(error) => error === closingWhileAborting,
		"close must win over a pending abort",
	);
}

/* ------------------------------------------------------------------ *
 * 2. Executor fence: the gate + executor never run an effect or emit
 *    updates once the gate is closed, even if cancellation arrived late.
 * ------------------------------------------------------------------ */
{
	const { gate: closedGate, control } = gate.createGate();
	const terminal = new Error("executor terminal failure");
	control.close(terminal);
	control.beginAbort(Promise.resolve());

	let invoked = 0;
	const delivered = [];
	const cleared = {
		toolCall: { type: "toolCall", id: "call-gated", name: "gated", arguments: { message: "x" } },
		tool: {
			name: "gated",
			replay: "never",
			async execute(_id, _args, update) {
				invoked += 1;
				update({ content: [{ type: "text", text: "late" }], details: {} });
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		},
		args: { message: "x" },
	};
	assert.throws(
		() =>
			execution.executeToolCall(
				cleared,
				closedGate,
				(partial) => delivered.push(partial),
				undefined,
				invocation,
				{},
			),
		(error) => {
			assert.equal(error, terminal, "a closed gate must refuse the tool effect with its terminal error");
			return true;
		},
	);
	assert.equal(invoked, 0, "a refused effect must not invoke the tool");
	assert.equal(delivered.length, 0, "a refused effect must not deliver updates");
}

/* ------------------------------------------------------------------ *
 * 3. Executor fence: completion seals live and checkpoint callbacks.
 * ------------------------------------------------------------------ */
{
	const { gate: openGate } = gate.createGate();
	let lateUpdate;
	const delivered = [];
	const cleared = {
		toolCall: { type: "toolCall", id: "call-late", name: "streaming", arguments: { message: "x" } },
		tool: {
			name: "streaming",
			replay: "never",
			async execute(_id, _args, update) {
				update({ content: [{ type: "text", text: "partial" }], details: { step: 1 } });
				lateUpdate = update;
				return { content: [{ type: "text", text: "done" }], details: { step: 2 } };
			},
		},
		args: { message: "x" },
	};
	const executed = await execution.executeToolCall(
		cleared,
		openGate,
		(partial, options) => delivered.push({ partial, checkpoint: options?.checkpoint === true }),
		undefined,
		invocation,
		{},
	);
	assert.equal(executed.isError, false);
	assert.equal(delivered.length, 1, "updates emitted during execution are delivered");
	assert.equal(delivered[0].partial.content[0].text, "partial");

	lateUpdate({ content: [{ type: "text", text: "late" }], details: { step: 9 } }, { checkpoint: true });
	lateUpdate({ content: [{ type: "text", text: "late-again" }], details: { step: 10 } });
	await settle();
	assert.equal(delivered.length, 1, "updates emitted after completion must be sealed");
	assert.equal(
		delivered.some((entry) => entry.partial?.details?.step === 9 || entry.partial?.details?.step === 10),
		false,
	);
}

/* ------------------------------------------------------------------ *
 * 4. Scheduler fence: cancelled recovery never clears or invokes.
 * ------------------------------------------------------------------ */
{
	const cancelled = await pipeline.run({ cancelled: true, persisted: "safe", declared: "safe" });
	assert.equal(cancelled.events.includes("clear"), false, "a cancelled recovery must not clear its checkpoint");
	assert.equal(cancelled.events.includes("invoke"), false, "a cancelled recovery must not invoke the tool");
	assert.equal(cancelled.events.includes("update"), false, "a cancelled recovery must not publish live updates");
	assert.equal(cancelled.events.filter((event) => event === "read").length, 1, "a cancelled recovery reads its checkpoint");
	assert.equal(cancelled.events.filter((event) => event === "publish").length, 1, "a cancelled recovery publishes once");
	assert.equal(cancelled.context, undefined, "a cancelled recovery must not open a tool context");
	assert.equal(cancelled.updates.length, 0);
	assert.equal(cancelled.checkpoints.length, 0);
	assert.equal(cancelled.outcome.message.isError, true);
	assert.equal(cancelled.outcome.message.content[0].text, "checkpoint-evidence");
	assert.match(
		cancelled.outcome.message.content.at(-1).text,
		/external outcome is unknown/,
		"a cancelled recovery stages the interruption marker",
	);
	assert.deepEqual(cancelled.outcome.message.details, { step: 2 }, "a cancelled recovery keeps checkpoint details");
	assert.equal(cancelled.outcome.terminate, false);

	// The same fence holds when replay is not declared safe on either side.
	const cancelledUnsafe = await pipeline.run({ cancelled: true, persisted: "never", declared: "safe" });
	assert.equal(cancelledUnsafe.events.includes("invoke"), false);
	assert.equal(cancelledUnsafe.events.includes("clear"), false);
	assert.equal(cancelledUnsafe.events.filter((event) => event === "publish").length, 1);
	assert.equal(cancelledUnsafe.outcome.message.isError, true);
}

/* ------------------------------------------------------------------ *
 * 5. The fences must not over-reach: a live safe/safe recovery still
 *    completes, preserves usage/details and publishes exactly once.
 * ------------------------------------------------------------------ */
{
	const resumed = await pipeline.run({ persisted: "safe", declared: "safe" });
	assert.deepEqual(
		resumed.events,
		["clear", "invoke", "effect-complete", "seal", "drain", "drain-complete", "publish"],
		"a non-cancelled safe/safe recovery clears, executes, seals, drains and publishes once",
	);
	assert.equal(resumed.outcome.message.isError, false);
	assert.equal(resumed.outcome.message.content[0].text, "persisted-arguments", "recovery reuses persisted arguments");
	assert.deepEqual(resumed.outcome.message.details, { kept: true }, "recovery preserves result details");
	assert.deepEqual(resumed.outcome.message.usage, { output: 3 }, "recovery preserves result usage");
	assert.equal(resumed.outcome.terminate, false);
	assert.equal(resumed.updates.length, 0);
	assert.equal(resumed.checkpoints.length, 0);

	// Live updates still flow while the invocation is running, including checkpoints.
	const streaming = await pipeline.run({
		effect: async ({ update }) => {
			update({ content: [{ type: "text", text: "live-1" }], details: { step: 1 } }, { checkpoint: true });
			await Promise.resolve();
			update({ content: [{ type: "text", text: "live-2" }], details: { step: 2 } });
			return {
				content: [{ type: "text", text: "streamed" }],
				details: { kept: true },
				usage: { output: 7 },
			};
		},
	});
	assert.equal(streaming.updates.length, 2, "live updates during execution are published");
	assert.equal(streaming.checkpoints.length, 1, "checkpoint updates during execution are persisted");
	assert.equal(streaming.outcome.message.content[0].text, "streamed");
	assert.deepEqual(streaming.outcome.message.usage, { output: 7 });
	assert.equal(streaming.events.filter((event) => event === "publish").length, 1, "the outcome publishes once");
	assert.equal(streaming.events.includes("clear"), true);
	assert.equal(streaming.events.indexOf("invoke") < streaming.events.indexOf("effect-complete"), true);

	// A live recovery that is not replay-safe still stages the checkpoint instead of executing.
	const interrupted = await pipeline.run({ persisted: "never", declared: "safe" });
	assert.equal(interrupted.events.includes("invoke"), false);
	assert.equal(interrupted.events.filter((event) => event === "read").length, 1);
	assert.equal(interrupted.events.filter((event) => event === "publish").length, 1);
	assert.equal(interrupted.outcome.message.isError, true);
	assert.deepEqual(interrupted.outcome.message.details, { step: 2 });
}

console.log("execution lifecycle fences: all cross-module assertions passed");
