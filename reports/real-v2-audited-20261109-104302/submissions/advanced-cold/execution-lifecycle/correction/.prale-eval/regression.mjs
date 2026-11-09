#!/usr/bin/env node
/**
 * Cross-module regression suite for the execution lifecycle repair.
 *
 * The subject helper links the real submitted modules
 * (`runtime/drive/tools.ts` -> `execution/tools.ts` -> `execution/effect-gate.ts`)
 * and fakes only the storage/progress/hook boundary. Every check below is an
 * uncaught `node:assert/strict` assertion, so a regression aborts the run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

const INTERRUPTION_MARKER_TEXT =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

const pipeline = await createExecutionPipeline(root);
const { createGate, AbortRequested } = pipeline.gate;
const execution = pipeline.execution;

function indexOfEvent(events, name) {
	return events.indexOf(name);
}

function assertBefore(events, first, second) {
	const left = indexOfEvent(events, first);
	const right = indexOfEvent(events, second);
	assert.notEqual(left, -1, `expected a ${first} event in ${JSON.stringify(events)}`);
	assert.notEqual(right, -1, `expected a ${second} event in ${JSON.stringify(events)}`);
	assert.ok(left < right, `expected ${first} before ${second} in ${JSON.stringify(events)}`);
}

const scenario = async (name, body) => {
	process.stderr.write(`# ${name}\n`);
	await body();
};

// Inputs used by the execution module in isolation.
const clearedCall = {
	toolCall: { id: "call-9", name: "fixture-tool", arguments: { message: "executed-arguments" } },
	tool: { name: "fixture-tool", replay: "safe" },
	args: { message: "executed-arguments" },
};
const reusedUsage = { input: 2, output: 3 };

const testRoot = fs.mkdtempSync(path.join(here, ".tmp-"));
try {
	// Local, disposable test input: the arguments replayed from the durable intent row.
	const replayArgumentsPath = path.join(testRoot, "replay-arguments.json");
	const replayArguments = { message: "fixture-replayed-arguments" };
	fs.writeFileSync(replayArgumentsPath, JSON.stringify(replayArguments, null, 2));
	const persistedArgs = JSON.parse(fs.readFileSync(replayArgumentsPath, "utf8"));

	/* ------------------------------------------------------------------ *
	 * effect-gate.ts: terminal closure outranks a pending cancellation.
	 * ------------------------------------------------------------------ */
	await scenario("gate: open gate admits synchronously without aborting", async () => {
		const { gate } = createGate();
		let ran = false;
		const value = gate.admit(() => {
			ran = true;
			return "admitted";
		});
		assert.equal(value, "admitted");
		assert.equal(ran, true);
		assert.equal(gate.signal.aborted, false);
	});

	await scenario("gate: pending cancellation refuses admission with its own promise", async () => {
		const cancellation = new Promise(() => {});
		const { gate, control } = createGate();
		control.beginAbort(cancellation);
		let ran = false;
		assert.throws(
			() =>
				gate.admit(() => {
					ran = true;
				}),
			(error) => {
				assert.ok(error instanceof AbortRequested, String(error));
				assert.equal(error.cancellation, cancellation);
				return true;
			},
		);
		assert.equal(ran, false);
		assert.equal(gate.signal.aborted, false);
	});

	await scenario("gate: terminal error closed over a pending cancellation is authoritative", async () => {
		const cancellation = new Promise(() => {});
		const { gate, control } = createGate();
		const terminal = new Error("terminal-close");
		control.beginAbort(cancellation);
		control.close(terminal);
		let ran = false;
		assert.throws(
			() =>
				gate.admit(() => {
					ran = true;
				}),
			(error) => {
				assert.ok(!(error instanceof AbortRequested), "pending cancellation overrode the terminal closure");
				assert.equal(error, terminal);
				return true;
			},
		);
		assert.equal(ran, false);
		assert.equal(gate.signal.aborted, true);
		assert.equal(gate.signal.reason, terminal);

		// A late cancellation must not downgrade the closed gate.
		control.beginAbort(cancellation);
		assert.throws(() => gate.admit(() => undefined), (error) => error === terminal);
		// A second close must not replace the authoritative error.
		control.close(new Error("later-close"));
		assert.throws(() => gate.admit(() => undefined), (error) => error === terminal);
	});

	await scenario("gate: first terminal closure wins and blocks later cancellation", async () => {
		const { gate, control } = createGate();
		const first = new Error("first");
		control.close(first);
		control.close(new Error("second"));
		control.beginAbort(Promise.resolve());
		assert.throws(() => gate.admit(() => undefined), (error) => error === first);
		assert.equal(gate.signal.aborted, true);
		assert.equal(gate.signal.reason, first);
	});

	/* ------------------------------------------------------------------ *
	 * execution/tools.ts: explicit false/empty patches win, unspecified
	 * fields and usage are preserved.
	 * ------------------------------------------------------------------ */
	await scenario("execution: an explicit isError=false patch clears an executed failure", async () => {
		const finalized = execution.finalizeToolCall(
			clearedCall,
			{
				result: {
					content: [{ type: "text", text: "tool failed" }],
					details: { failed: true },
					usage: reusedUsage,
				},
				isError: true,
			},
			{ isError: false, content: [], usage: { output: 1 } },
		);
		assert.equal(finalized.isError, false, "explicit isError=false patch was ignored");
		assert.deepEqual(finalized.result.content, [], "explicit empty content patch was ignored");
		assert.deepEqual(finalized.result.usage, { output: 1 });
		assert.deepEqual(finalized.result.details, { failed: true }, "unspecified details were dropped");

		const message = execution.createToolResultMessage(finalized);
		assert.equal(message.role, "toolResult");
		assert.equal(message.toolCallId, "call-9");
		assert.equal(message.toolName, "fixture-tool");
		assert.equal(message.isError, false);
		assert.deepEqual(message.content, []);
		assert.deepEqual(message.usage, { output: 1 });
		assert.deepEqual(message.details, { failed: true });
	});

	await scenario("execution: unspecified patch fields, usage and extra result fields survive", async () => {
		const finalized = execution.finalizeToolCall(
			clearedCall,
			{
				result: {
					content: [{ type: "text", text: "native" }],
					details: { native: true },
					usage: reusedUsage,
					annotation: { source: "tool" },
				},
				isError: false,
			},
			{ terminate: true },
		);
		assert.equal(finalized.isError, false);
		assert.equal(finalized.terminate, true);
		assert.deepEqual(finalized.result.content, [{ type: "text", text: "native" }]);
		assert.deepEqual(finalized.result.details, { native: true });
		assert.deepEqual(finalized.result.usage, reusedUsage, "usage was dropped by the patch merge");
		assert.deepEqual(finalized.result.annotation, { source: "tool" }, "unspecified result fields were dropped");
	});

	await scenario("execution: explicit null details apply while an undefined isError keeps the failure", async () => {
		const finalized = execution.finalizeToolCall(
			clearedCall,
			{ result: { content: [{ type: "text", text: "boom" }], details: { native: true } }, isError: true },
			{ details: null, isError: undefined },
		);
		assert.equal(finalized.isError, true, "isError must fall back to the executed failure");
		assert.equal(finalized.result.details, null);
		assert.equal(execution.createToolResultMessage(finalized).details, null);
	});

	await scenario("execution: an absent after-tool patch preserves the executed result", async () => {
		const executed = {
			result: { content: [{ type: "text", text: "untouched" }], details: { native: true }, usage: reusedUsage },
			isError: false,
		};
		const finalized = execution.finalizeToolCall(clearedCall, executed, undefined);
		assert.equal(finalized.result, executed.result);
		assert.equal(finalized.isError, false);
		assert.equal(finalized.terminate, false);
		const message = execution.createToolResultMessage(finalized);
		assert.deepEqual(message.content, [{ type: "text", text: "untouched" }]);
		assert.deepEqual(message.details, { native: true });
		assert.deepEqual(message.usage, reusedUsage);
	});

	/* ------------------------------------------------------------------ *
	 * drive/tools.ts: non-cancelled safe/safe recovery replays the effect;
	 * every other combination falls back to the checkpoint outcome.
	 * ------------------------------------------------------------------ */
	await scenario("drive: non-cancelled safe/safe recovery replays through the real executor", async () => {
		let seenArgs;
		const run = await pipeline.run({
			arguments: persistedArgs,
			effect: async ({ args }) => {
				seenArgs = args;
				return { content: [{ type: "text", text: args.message }], details: { resumed: true }, usage: { output: 3 } };
			},
		});
		assert.deepEqual(seenArgs, persistedArgs, "the replayed effect must receive the persisted arguments");
		assert.equal(indexOfEvent(run.events, "read"), -1, "safe replay must not read the interruption checkpoint");
		assertBefore(run.events, "clear", "invoke");
		assertBefore(run.events, "invoke", "publish");
		assert.equal(typeof run.callback, "function");
		const message = run.outcome.message;
		assert.equal(message.isError, false, "replayed invocation was reported as an interruption");
		assert.deepEqual(message.content, [{ type: "text", text: persistedArgs.message }]);
		assert.deepEqual(message.details, { resumed: true });
		assert.deepEqual(message.usage, { output: 3 });
		assert.equal(
			message.content.some((part) => part.text === INTERRUPTION_MARKER_TEXT),
			false,
		);
		assert.equal(run.outcome.terminate, false);
	});

	await scenario("drive: a pending cancellation keeps safe/safe recovery on the checkpoint path", async () => {
		const run = await pipeline.run({ cancelled: true, arguments: persistedArgs });
		assert.equal(indexOfEvent(run.events, "clear"), -1, "cancelled recovery must not replay");
		assert.equal(indexOfEvent(run.events, "invoke"), -1, "cancelled recovery must not invoke the tool");
		assert.equal(run.callback, undefined);
		assert.equal(run.outcome.message.isError, true);
		const texts = run.outcome.message.content.map((part) => part.text);
		assert.ok(texts.includes("checkpoint-evidence"), JSON.stringify(texts));
		assert.ok(texts.includes(INTERRUPTION_MARKER_TEXT), JSON.stringify(texts));
		assert.deepEqual(run.outcome.message.details, { step: 2 });
		assert.equal(run.outcome.terminate, false);
	});

	await scenario("drive: replay needs both the persisted and declared replay policy", async () => {
		for (const options of [
			{ declared: "never" },
			{ persisted: "never" },
			{ declared: undefined },
		]) {
			const run = await pipeline.run({ ...options, arguments: persistedArgs });
			assert.equal(indexOfEvent(run.events, "invoke"), -1, `tool ran for ${JSON.stringify(options)}`);
			assert.equal(indexOfEvent(run.events, "clear"), -1, `replay started for ${JSON.stringify(options)}`);
			assert.equal(run.callback, undefined);
			assert.equal(run.outcome.message.isError, true);
			const texts = run.outcome.message.content.map((part) => part.text);
			assert.ok(texts.includes(INTERRUPTION_MARKER_TEXT), JSON.stringify(texts));
		}
	});

	await scenario("drive: updates and progress checkpoints are delivered before publication", async () => {
		const run = await pipeline.run({
			effect: async ({ args, update }) => {
				await update({ content: [{ type: "text", text: "partial" }], details: { step: 1 } }, { checkpoint: true });
				await update({ content: [{ type: "text", text: "partial-2" }], details: { step: 2 } }, { checkpoint: false });
				return { content: [{ type: "text", text: args.message }], details: { done: true }, usage: { output: 1 } };
			},
		});
		assert.deepEqual(
			run.updates.map((event) => event.type),
			["tool_update", "tool_update"],
		);
		assert.deepEqual(
			run.updates.map((event) => event.partialResult.content[0].text),
			["partial", "partial-2"],
		);
		assert.equal(
			run.updates.every((event) => event.recovery === true),
			true,
		);
		assert.deepEqual(
			run.checkpoints.map((checkpoint) => checkpoint.details),
			[{ step: 1 }],
		);
		assertBefore(run.events, "update", "publish");
		assertBefore(run.events, "drain", "publish");
		assert.equal(run.outcome.message.isError, false);
	});

	await scenario("drive+execution: a replayed tool receives the admitted abort signal", async () => {
		const run = await pipeline.run({ arguments: persistedArgs });
		assert.ok(run.context !== undefined, "the tool received no execution context");
		assert.equal(run.context.abortSignal, run.gate.signal);
	});

	await scenario("drive+execution: an after-tool patch clears isError on a failed replay", async () => {
		const run = await pipeline.run({
			arguments: persistedArgs,
			effect: async () => {
				throw new Error("tool exploded");
			},
			patch: { isError: false, content: [], usage: { output: 1 } },
		});
		const message = run.outcome.message;
		assert.equal(run.callback !== undefined, true, "the replayed effect never ran");
		assert.equal(message.isError, false, "explicit isError=false patch was ignored");
		assert.deepEqual(message.content, [], "explicit empty content patch was ignored");
		assert.deepEqual(message.usage, { output: 1 });
		assert.equal(Object.hasOwn(message, "details"), false);
	});

	await scenario("drive+execution: a replayed patch keeps unspecified details and usage", async () => {
		const usage = { input: 2, output: 3 };
		const run = await pipeline.run({
			arguments: persistedArgs,
			effect: async () => ({
				content: [{ type: "text", text: "original-output" }],
				details: { kept: true },
				usage,
			}),
			patch: { content: [], terminate: true },
		});
		const message = run.outcome.message;
		assert.equal(message.isError, false);
		assert.deepEqual(message.content, []);
		assert.deepEqual(message.details, { kept: true });
		assert.deepEqual(message.usage, usage);
		assert.equal(run.outcome.terminate, true);
	});

	/* ------------------------------------------------------------------ *
	 * Gate state as seen by a recovering invocation.
	 * ------------------------------------------------------------------ */
	await scenario("drive+gate: a closed gate rejects a safe replay with the terminal error", async () => {
		const terminal = new Error("gate-closed-terminal");
		await assert.rejects(
			pipeline.run({ gateState: "closed", gateError: terminal, arguments: persistedArgs }),
			(error) => {
				assert.equal(error, terminal);
				return true;
			},
		);
	});

	await scenario("drive+gate: cancellation that wins admission does not replay the effect", async () => {
		let invoked = false;
		const run = await pipeline.run({
			gateState: "aborting",
			arguments: persistedArgs,
			effect: async () => {
				invoked = true;
				return { content: [{ type: "text", text: "unreachable" }] };
			},
		});
		assert.equal(invoked, false);
		assert.equal(run.callback, undefined);
		assert.equal(run.outcome.message.isError, true);
		const texts = run.outcome.message.content.map((part) => part.text);
		assert.ok(texts.includes(INTERRUPTION_MARKER_TEXT), JSON.stringify(texts));
	});

	await scenario("drive+gate: closing an aborting gate mid-invocation makes the terminal error authoritative", async () => {
		const terminal = new Error("mid-invocation-terminal");
		let effectCompleted = false;
		await assert.rejects(
			pipeline.run({
				arguments: persistedArgs,
				effect: async ({ control }) => {
					control.beginAbort(new Promise(() => {}));
					control.close(terminal);
					effectCompleted = true;
					return { content: [{ type: "text", text: "effect-finished" }], details: { late: true } };
				},
			}),
			(error) => {
				assert.equal(
					error,
					terminal,
					`expected the terminal gate error, received ${error?.name}: ${error?.message}`,
				);
				return true;
			},
		);
		assert.equal(effectCompleted, true, "the external effect had already completed before admission was refused");
	});
} finally {
	fs.rmSync(testRoot, { recursive: true, force: true });
	assert.equal(fs.existsSync(testRoot), false, "temporary fixtures must be cleaned up");
}

process.stderr.write("# execution lifecycle regression suite passed\n");
