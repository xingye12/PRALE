#!/usr/bin/env node
/**
 * Regression coverage for advanced/execution-lifecycle/correction.
 *
 * Exercises the real recovery path (drive/tools.ts) against the real tool
 * executor/finalizer (execution/tools.ts) and the real effect gate
 * (execution/effect-gate.ts). Every observation below crosses at least one
 * module boundary: recovery asks the gate for admission, the gate decides
 * whether the effect and the after-tool hook may run, and the executor turns
 * the raw tool output plus hook patch into the published tool result.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pipeline = await createExecutionPipeline(root);

const usage = {
	input: 1,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 4,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textOf(message) {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function isInterruption(message) {
	return (
		message.isError === true &&
		textOf(message).includes("external outcome is unknown") &&
		textOf(message).includes("checkpoint-evidence")
	);
}

// 1. A non-cancelled safe/safe replay re-runs the tool from the persisted
//    arguments instead of settling on the durable checkpoint.
{
	const result = await pipeline.run({ persisted: "safe", declared: "safe", cancelled: false });

	assert.deepEqual(
		result.events.slice(0, 3),
		["clear", "invoke", "effect-complete"],
		"non-cancelled safe/safe replay must clear the checkpoint and re-invoke the tool",
	);
	assert.equal(result.events.includes("read"), false, "safe replay must not fall back to the checkpoint");
	assert.equal(result.events.filter((event) => event === "publish").length, 1);

	const { outcome } = result;
	assert.equal(outcome.message.role, "toolResult");
	assert.equal(outcome.message.toolCallId, "call-2");
	assert.equal(outcome.message.toolName, "fixture-tool");
	assert.deepEqual(outcome.message.content, [{ type: "text", text: "persisted-arguments" }]);
	assert.deepEqual(outcome.message.details, { kept: true });
	assert.deepEqual(outcome.message.usage, { output: 3 });
	assert.equal(outcome.message.isError, false);
	assert.equal(outcome.terminate, false);
	assert.equal(typeof result.callback, "function", "replayed execution must expose the update callback");
	assert.equal(result.context.abortSignal, result.gate.signal, "replayed execution must run against the gate signal");
	assert.deepEqual(result.checkpoints, []);
}

// 2. A cancelled replay still settles on the durable checkpoint without
//    touching the external effect.
{
	const result = await pipeline.run({ persisted: "safe", declared: "safe", cancelled: true });

	assert.deepEqual(result.events, ["read", "publish"]);
	assert.equal(result.events.includes("invoke"), false, "cancelled replay must not execute the tool");
	assert.equal(isInterruption(result.outcome.message), true);
	assert.deepEqual(result.outcome.message.details, { step: 2 });
	assert.equal(result.outcome.terminate, false);
}

// 3. Unsafe (or undeclared) tools are never replayed, even when the persisted
//    call was recorded as safe.
for (const options of [
	{ persisted: "safe", declared: "never" },
	{ persisted: "safe", declared: undefined },
]) {
	const result = await pipeline.run(options);
	assert.deepEqual(result.events, ["read", "publish"], `declared=${String(options.declared)} must skip execution`);
	assert.equal(result.events.includes("invoke"), false);
	assert.equal(isInterruption(result.outcome.message), true);
	assert.deepEqual(result.outcome.message.details, { step: 2 });
}

// 4. An after-tool hook may explicitly clear isError while replacing content
//    with an explicit empty array; fields the hook leaves unspecified are
//    preserved from the raw execution.
{
	const patchedUsage = { ...usage, output: 9, totalTokens: 10 };
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		effect: async () => {
			throw new Error("tool exploded");
		},
		patch: { isError: false, content: [], usage: patchedUsage },
	});

	assert.deepEqual(result.events.slice(0, 2), ["clear", "invoke"]);
	assert.equal(result.events.includes("effect-complete"), false);

	const { message } = result.outcome;
	assert.equal(message.isError, false, "an explicit isError:false patch must win over a raw error result");
	assert.deepEqual(message.content, [], "an explicit empty content patch must be applied");
	assert.deepEqual(message.usage, patchedUsage);
	assert.equal(Object.hasOwn(message, "details"), false, "unspecified details must stay unspecified");
	assert.deepEqual(result.outcome.terminate, false);
}

// 5. Explicit false/empty patch values are applied while unspecified result
//    fields (details, usage, content) survive from the executed tool result.
{
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		effect: async () => ({
			content: [{ type: "text", text: "raw" }],
			details: { raw: true },
			usage,
			terminate: true,
		}),
		patch: { content: [], isError: false, terminate: false },
	});

	const { message } = result.outcome;
	assert.deepEqual(message.content, []);
	assert.deepEqual(message.details, { raw: true }, "unspecified details must be preserved");
	assert.deepEqual(message.usage, usage, "unspecified usage must be preserved");
	assert.equal(message.isError, false);
	assert.equal(result.outcome.terminate, false, "an explicit terminate:false patch must be applied");

	const kept = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		effect: async () => ({
			content: [{ type: "text", text: "raw" }],
			details: { raw: true },
			usage,
			terminate: true,
		}),
		patch: { details: {}, terminate: true },
	});
	assert.deepEqual(kept.outcome.message.content, [{ type: "text", text: "raw" }]);
	assert.deepEqual(kept.outcome.message.details, {});
	assert.deepEqual(kept.outcome.message.usage, usage);
	assert.equal(kept.outcome.message.isError, false);
	assert.equal(kept.outcome.terminate, true);
}

// 6. A terminal gate closure wins over an already pending cancellation.
{
	const { createGate } = pipeline.gate;
	const { gate, control } = createGate();
	let releaseCancellation;
	const cancellation = new Promise((resolve) => {
		releaseCancellation = resolve;
	});
	control.beginAbort(cancellation);

	assert.throws(
		() => gate.admit(() => "unreachable"),
		(error) => error?.name === "AbortRequested",
		"a pending cancellation must refuse new admissions",
	);
	assert.equal(gate.signal.aborted, false);

	const terminal = new Error("terminal gate closure");
	control.close(terminal);
	control.signalAbort();

	assert.equal(gate.signal.aborted, true);
	assert.equal(gate.signal.reason, terminal, "the terminal error must become the abort reason");
	assert.throws(
		() => gate.admit(() => "unreachable"),
		(error) => error === terminal,
		"a terminal closure must be authoritative for future admissions",
	);

	releaseCancellation();
	await cancellation;
	control.beginAbort(Promise.resolve());

	assert.throws(
		() => gate.admit(() => "unreachable"),
		(error) => error === terminal,
		"neither the settled cancellation nor a later abort request may reopen or override the closure",
	);
}

// 7. The same terminal priority is observable across the execution lifecycle:
//    a gate closed while aborting refuses the remaining after-tool effect, so
//    recovery surfaces the terminal error instead of a patched outcome.
{
	const terminal = new Error("transport closed while cancelling");
	let observed;
	await assert.rejects(
		pipeline.run({
			persisted: "safe",
			declared: "safe",
			effect: async ({ control, context }) => {
				observed = { control, context };
				control.beginAbort(new Promise(() => {}));
				control.close(terminal);
				return { content: [{ type: "text", text: "after closure" }], details: {}, usage };
			},
		}),
		(error) => error === terminal,
		"the terminal closure must abort the rest of the invocation with its own error",
	);
	assert.equal(observed.context.abortSignal.aborted, true);
	assert.equal(observed.context.abortSignal.reason, terminal);
	observed.control.close(new Error("later closure"));
	observed.control.beginAbort(Promise.resolve());
	assert.throws(
		() => observed.context.abortSignal.throwIfAborted(),
		(error) => error === terminal,
	);
}

console.log("execution-lifecycle correction regression: ok");
