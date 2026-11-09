/**
 * Cross-module regression for recovery authorization -> effect admission.
 *
 * The real production modules are loaded through the read-only `subject.mjs` helper:
 *   packages/agent/src/harness/runtime/drive/tools.ts   (recovery procedure)
 *   packages/agent/src/harness/execution/tools.ts       (effect executor)
 *   packages/agent/src/harness/execution/effect-gate.ts (admission capability)
 * Only the durable checkpoint storage, the progress transport and the outcome
 * publisher are boundary fakes, so every assertion below observes behaviour that
 * crosses real module boundaries.
 *
 * Ordered with promises only: no timers, randomness or external services.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERRUPTION_MARKER = "external outcome is unknown";
const PERSISTED = "persisted-arguments";
const MODEL = "raw-model-arguments";

const pipeline = await createExecutionPipeline(root);

function text(message) {
	return (message?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function indexOf(events, name) {
	const index = events.indexOf(name);
	assert.notEqual(index, -1, `expected ${name} in observable events, saw: ${events.join(", ")}`);
	return index;
}

/** Run one recovery pass, converting any unexpected throw into an assertion failure. */
async function recover(options, label) {
	try {
		return await pipeline.run(options);
	} catch (error) {
		assert.fail(`recovery must not throw for ${label}: ${error?.stack ?? String(error)}`);
	}
}

/** The recovered operation must stay interrupted: no checkpoint clear, no effect, evidence kept. */
function assertInterrupted(result, label) {
	assert.equal(result.events.includes("invoke"), false, `${label}: tool effect must not be admitted`);
	assert.equal(result.events.includes("clear"), false, `${label}: replay checkpoint must not be cleared`);
	assert.ok(result.events.includes("read"), `${label}: the durable checkpoint must be read`);
	assert.ok(result.events.includes("publish"), `${label}: an interrupted outcome must be published`);
	assert.equal(result.outcome.message.isError, true, `${label}: interrupted outcome must be an error result`);
	assert.match(text(result.outcome.message), /checkpoint-evidence/, `${label}: durable progress must be kept`);
	assert.match(text(result.outcome.message), new RegExp(INTERRUPTION_MARKER), `${label}: interruption must be explicit`);
	assert.doesNotMatch(text(result.outcome.message), new RegExp(MODEL), `${label}: stale model arguments must never surface`);
}

// 1. Both declarations safe: replay the cleared/persisted arguments and publish after the drain.
{
	const seen = {};
	const result = await recover(
		{
			persisted: "safe",
			declared: "safe",
			effect: async ({ args, update, invocation, context }) => {
				seen.args = args;
				seen.invocation = invocation;
				seen.context = context;
				update({ content: [{ type: "text", text: "partial-progress" }], details: { step: 1 } }, { checkpoint: true });
				return {
					content: [{ type: "text", text: `replayed:${args.message}` }],
					details: { replayed: true },
					usage: { output: 2 },
				};
			},
		},
		"safe replay",
	);

	assert.equal(seen.args.message, PERSISTED, "the executor must invoke the tool with the persisted arguments");
	assert.notEqual(seen.args.message, MODEL, "the executor must not replay the original model arguments");
	assert.equal(seen.invocation.operationId, "op-1", "invocation must carry the durable operation identity");
	assert.equal(seen.invocation.invocationId, "result-2", "invocation must carry the durable invocation identity");
	assert.equal(seen.context.abortSignal, result.gate.signal, "the effect must run under the gate's abort signal");

	const events = result.events;
	assert.ok(indexOf(events, "clear") < indexOf(events, "invoke"), "the stale checkpoint must be cleared before invocation");
	assert.ok(indexOf(events, "invoke") < indexOf(events, "effect-complete"), "the effect must complete after invocation");
	assert.ok(indexOf(events, "effect-complete") < indexOf(events, "drain-complete"), "progress must drain after the effect");
	assert.ok(
		indexOf(events, "drain-complete") < indexOf(events, "publish"),
		"the outcome must be published only after the durable progress drain finishes",
	);
	assert.equal(events.at(-1), "publish", "publication must be the last recovery step");

	assert.equal(result.outcome.message.isError, false, "a replayed effect publishes its real result");
	assert.match(text(result.outcome.message), /replayed:persisted-arguments/);
	assert.deepEqual(result.outcome.message.details, { replayed: true });
	assert.deepEqual(
		result.checkpoints,
		[{ content: [{ type: "text", text: "partial-progress" }], details: { step: 1 } }],
		"checkpointed progress must be written to the durable progress transport",
	);
	const updateEvent = result.updates.find((event) => event.type === "tool_update");
	assert.ok(updateEvent, "live tool updates must be emitted");
	assert.equal(updateEvent.recovery, true, "recovered updates must be marked as recovery");
	assert.equal(updateEvent.partialResult.content[0].text, "partial-progress");
}

// 2. Publication is withheld while the durable progress drain is still pending.
{
	let releaseDrain;
	const drainGate = new Promise((resolve) => {
		releaseDrain = resolve;
	});
	let enteredDrain;
	const drainEntered = new Promise((resolve) => {
		enteredDrain = resolve;
	});
	const observed = { published: false, outcome: undefined, result: undefined, thrown: undefined };
	const pending = pipeline
		.run({
			persisted: "safe",
			declared: "safe",
			progressDrain: () => {
				enteredDrain();
				return drainGate;
			},
			onPublish: (value) => {
				observed.published = true;
				observed.outcome = value;
			},
		})
		.then(
			(value) => {
				observed.result = value;
			},
			(error) => {
				observed.thrown = error;
			},
		);

	await drainEntered;
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(observed.thrown, undefined, "the drained recovery must not fail");
	assert.equal(observed.published, false, "the outcome must not be published before the progress drain finishes");
	assert.equal(observed.outcome, undefined, "no outcome may leak while the drain is pending");

	releaseDrain();
	await pending;
	assert.equal(observed.thrown, undefined, "the drained recovery must not fail");
	assert.equal(observed.published, true, "the outcome is published once the drain finishes");
	assert.ok(
		indexOf(observed.result.events, "drain-complete") < indexOf(observed.result.events, "publish"),
		"publication strictly follows the completed drain",
	);
}

// 3. Cancellation wins admission: the interrupted checkpoint is published, never executed.
{
	const result = await recover({ persisted: "safe", declared: "safe", cancelled: true }, "cancelled recovery");
	assertInterrupted(result, "cancelled recovery");
}

// 4. Only the durable declaration is safe: the current tool declaration forbids replay.
{
	const result = await recover({ persisted: "safe", declared: "never" }, "tool declared replay never");
	assertInterrupted(result, "tool declared replay never");
}

// 5. Only the current tool declaration is safe: the durable intent forbids replay.
{
	const result = await recover({ persisted: "never", declared: "safe" }, "durable intent replay never");
	assertInterrupted(result, "durable intent replay never");
}

// 6. Neither declaration is safe.
{
	const result = await recover({ persisted: "never", declared: "never" }, "both declarations never");
	assertInterrupted(result, "both declarations never");
}

// 7. The tool is no longer registered: it stays interrupted instead of executing.
{
	const result = await recover({ persisted: "safe", declared: undefined }, "missing tool");
	assertInterrupted(result, "missing tool");
}

// 8. Cancellation gate already aborting: admission must refuse before the effect starts.
{
	const result = await recover({ persisted: "safe", declared: "safe", gateState: "aborting" }, "aborting gate");
	assert.equal(result.events.includes("invoke"), false, "an aborting gate must refuse effect admission");
	assert.equal(result.gate.signal.aborted, false, "cancellation must not signal before it commits");
	assert.equal(result.outcome.message.isError, true);
	assert.match(text(result.outcome.message), new RegExp(INTERRUPTION_MARKER));
}

// 9. Closed gate: admission refuses and the close fault propagates without any effect.
{
	const closedError = new Error("closed gate");
	let effects = 0;
	await assert.rejects(
		async () =>
			pipeline.run({
				persisted: "safe",
				declared: "safe",
				gateState: "closed",
				gateError: closedError,
				effect: async () => {
					effects += 1;
					return { content: [{ type: "text", text: "must not run" }], details: {} };
				},
			}),
		(error) => {
			assert.equal(error, closedError, "the closed gate fault must propagate unchanged");
			return true;
		},
		"a closed gate must refuse admission",
	);
	assert.equal(effects, 0, "a closed gate must prevent the recovered effect from starting");
}

// 10. Default effect path also proves the persisted arguments reach the tool.
{
	const result = await recover({}, "default effect");
	assert.equal(result.outcome.message.isError, false);
	assert.match(text(result.outcome.message), new RegExp(`^${PERSISTED}$`), "default effect must see persisted arguments");
	assert.doesNotMatch(text(result.outcome.message), new RegExp(MODEL));
}

console.log("recovery authorization regression: all assertions passed");
