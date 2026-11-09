#!/usr/bin/env node
/**
 * Regression coverage for `advanced/execution-lifecycle/transfer`.
 *
 * The script loads the submitted production modules through `.prale-eval/subject.mjs`
 * (real recovery -> real tool executor/finalizer -> real effect gate -> real drive
 * progress channel; only checkpoint storage, progress transport and hook delivery are
 * faked). Every assertion below therefore crosses at least one real module boundary:
 *
 *   runtime/drive/tools.ts  -> execution/tools.ts -> execution/effect-gate.ts
 *
 * Covered invariants:
 *   1. Only updates explicitly marked `{ checkpoint: true }` become durable progress;
 *      every admitted live update still reaches observers.
 *   2. A tool effect that throws still produces an error result in the finalized
 *      message (`isError: true`), never a successful-looking message.
 *   3. Signalling the abort (`beginAbort` -> durable cancellation -> `signalAbort`)
 *      reaches the AbortSignal of the already-admitted tool effect.
 *   4. Nothing new is admitted once `beginAbort` has run (no tool effect, no after-tool
 *      hook patch), and the durable checkpoint evidence survives interruption.
 *   5. Final publication happens only after live progress has been drained and the
 *      progress channel sealed.
 *
 * Ordering is driven exclusively by promises (no timers, randomness or real IO), so the
 * result is deterministic. Run from the workspace root:
 *
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutionPipeline } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function texts(content) {
	// Values cross the vm module boundary, so copy into a host array before asserting.
	return Array.from(content ?? [], (block) => (block?.type === "text" ? block.text : `<${block?.type}>`));
}

function partialText(partial) {
	return texts(partial?.content).join(" | ");
}

/** Progress must be sealed and drained before the durable outcome is published. */
function assertPublicationFollowsDrain(events, label) {
	const sealed = events.indexOf("seal");
	const draining = events.indexOf("drain");
	const drained = events.indexOf("drain-complete");
	const published = events.indexOf("publish");
	assert.ok(sealed >= 0, `${label}: progress channel was never sealed`);
	assert.ok(draining > sealed, `${label}: drain must start after seal, saw ${events.join(",")}`);
	assert.ok(drained > draining, `${label}: drain must complete, saw ${events.join(",")}`);
	assert.ok(published > drained, `${label}: final publication must follow progress drain, saw ${events.join(",")}`);
}

/**
 * Incident scenario: a recovered (safe-replay) tool emits live progress, one explicit
 * checkpoint, more live progress, then fails.
 */
async function recoveredToolPublishesOnlyCheckpointsAndKeepsFailure() {
	const pipeline = await createExecutionPipeline(root);
	const drainStarted = deferred();
	const drainRelease = deferred();
	let publications = 0;

	let recoveredArgs;

	const running = pipeline.run({
		persisted: "safe",
		declared: "safe",
		progressDrain: async () => {
			drainStarted.resolve();
			await drainRelease.promise;
		},
		onPublish: () => {
			publications += 1;
		},
		effect: async ({ args, update }) => {
			recoveredArgs = args;
			update({ content: [{ type: "text", text: "live-1" }], details: { step: 1 } });
			update({ content: [{ type: "text", text: "checkpoint-2" }], details: { step: 2 } }, { checkpoint: true });
			update({ content: [{ type: "text", text: "live-3" }], details: { step: 3 } });
			throw new Error("fixture tool failed");
		},
	});

	await drainStarted.promise;
	assert.equal(publications, 0, "final publication must wait until progress drain completes");
	drainRelease.resolve();
	const result = await running;

	assert.equal(publications, 1, "the recovered outcome must be published exactly once");
	assert.deepEqual(recoveredArgs, { message: "persisted-arguments" }, "safe replay reuses persisted arguments");

	// Every admitted live update reached the observers, in emission order.
	assert.deepEqual(
		result.updates.map((event) => event.type),
		["tool_update", "tool_update", "tool_update"],
		"all admitted live updates must reach observers",
	);
	assert.deepEqual(
		result.updates.map((event) => partialText(event.partialResult)),
		["live-1", "checkpoint-2", "live-3"],
		"live updates must reach observers unchanged and in order",
	);
	for (const event of result.updates) {
		assert.equal(event.recovery, true, "recovered tool updates must be marked as recovery");
		assert.equal(event.toolCallId, "call-2");
		assert.equal(event.toolName, "fixture-tool");
	}

	// Only the update flagged `checkpoint: true` became durable progress.
	assert.equal(result.checkpoints.length, 1, "only checkpoint=true updates may be persisted");
	assert.equal(partialText(result.checkpoints[0]), "checkpoint-2");
	assert.deepEqual(result.checkpoints[0].details, { step: 2 });

	// The replay checkpoint was cleared before the recovered effect was re-admitted.
	const events = result.events;
	assert.ok(events.includes("clear"), "recovered invocation must clear its replay checkpoint");
	assert.ok(events.indexOf("clear") < events.indexOf("invoke"), "replay checkpoint clears before re-admission");
	assert.equal(events.filter((event) => event === "invoke").length, 1, "the recovered effect runs exactly once");
	assert.ok(events.indexOf("invoke") < events.indexOf("update"), "updates start only after admission");
	assertPublicationFollowsDrain(events, "recovered failure");

	// A tool exception stays an error in the final message.
	const message = result.outcome.message;
	assert.equal(message.role, "toolResult");
	assert.equal(message.toolCallId, "call-2");
	assert.equal(message.toolName, "fixture-tool");
	assert.equal(result.outcome.toolCall.id, "call-2");
	assert.equal(message.isError, true, "a throwing tool must yield isError=true");
	assert.deepEqual(texts(message.content), ["fixture tool failed"]);
	assert.equal(result.outcome.terminate, false);
	assert.equal(result.context?.abortSignal?.aborted, false, "no cancellation was requested");

	return result;
}

/**
 * Abort scenario: the effect is already admitted when cancellation becomes durable; the
 * abort must reach that effect's AbortSignal, and nothing new may be admitted afterwards.
 */
async function abortReachesAdmittedToolAndAdmitsNothingNew() {
	const pipeline = await createExecutionPipeline(root);
	const ready = deferred();
	const release = deferred();
	const aborted = deferred();
	let toolSignal;
	let control;

	const running = pipeline.run({
		persisted: "safe",
		declared: "safe",
		patch: { content: [{ type: "text", text: "after-tool-patch" }], isError: false },
		effect: async ({ context, control: gateControl }) => {
			toolSignal = context.abortSignal;
			control = gateControl;
			if (!toolSignal) return { content: [{ type: "text", text: "no abort signal" }], details: {} };
			toolSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
			ready.resolve();
			await Promise.race([aborted.promise, release.promise]);
			if (toolSignal.aborted) throw new Error("cancelled effect");
			return { content: [{ type: "text", text: "effect completed before cancellation" }], details: {} };
		},
	});

	await ready.promise;
	const cancellation = deferred();
	control.beginAbort(cancellation.promise);
	const abortedBeforeCancellation = toolSignal?.aborted;

	cancellation.resolve();
	await cancellation.promise;
	control.signalAbort();
	const abortedAfterSignal = toolSignal?.aborted;
	release.resolve();

	const result = await running;

	assert.equal(
		abortedBeforeCancellation,
		false,
		"beginAbort must not signal the gate until cancellation is durable",
	);
	assert.equal(
		abortedAfterSignal,
		true,
		"signalAbort must reach the AbortSignal of the already-admitted tool",
	);

	// No new effects may be admitted after beginAbort: the after_tool patch is refused.
	assert.notEqual(
		partialText(result.outcome.message.content),
		"after-tool-patch",
		"after_tool effect must not be admitted once beginAbort has run",
	);
	assert.deepEqual(texts(result.outcome.message.content), ["cancelled effect"]);
	assert.equal(result.outcome.message.isError, true, "the cancelled effect stays an error in the message");

	let refusal;
	try {
		result.gate.admit(() => "late effect");
		refusal = undefined;
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal, "no effect may be admitted after beginAbort");
	assert.equal(refusal.name, "AbortRequested");
	assert.equal(refusal.cancellation, cancellation.promise, "AbortRequested carries the durable cancellation");

	assertPublicationFollowsDrain(result.events, "aborted while admitted");
	return result;
}

/** Cancellation that is already durable before admission: the effect never starts. */
async function abortBeforeAdmissionAdmitsNoEffect() {
	const pipeline = await createExecutionPipeline(root);
	let invocations = 0;
	const result = await pipeline.run({
		persisted: "safe",
		declared: "safe",
		gateState: "aborting",
		effect: async () => {
			invocations += 1;
			return { content: [{ type: "text", text: "must not run" }], details: {} };
		},
	});

	assert.equal(invocations, 0, "an aborting gate must not admit a new tool effect");
	assert.equal(result.events.includes("invoke"), false, "the recovered effect was never entered");
	assert.deepEqual(result.updates, [], "no live updates exist for a refused effect");
	assert.deepEqual(result.checkpoints, [], "no durable progress is written for a refused effect");
	assert.equal(result.outcome.message.isError, true);
	const content = texts(result.outcome.message.content);
	assert.match(content.at(-1) ?? "", /external outcome is unknown/);
	assertPublicationFollowsDrain(result.events, "aborted before admission");
	return result;
}

/** A non-replayable recovered effect keeps its last durable checkpoint in the message. */
async function interruptedRecoveryKeepsDurableCheckpoint() {
	const pipeline = await createExecutionPipeline(root);
	let invocations = 0;
	const result = await pipeline.run({
		persisted: "never",
		declared: "never",
		effect: async () => {
			invocations += 1;
			return { content: [{ type: "text", text: "must not run" }], details: {} };
		},
	});

	assert.equal(invocations, 0, "a non-replayable recovered effect must not be re-executed");
	assert.ok(result.events.includes("read"), "the durable checkpoint is read back");
	assert.equal(result.events.includes("clear"), false, "non-replayable recovery keeps its checkpoint");
	assert.equal(result.outcome.message.isError, true);
	const content = texts(result.outcome.message.content);
	assert.equal(content[0], "checkpoint-evidence", "the durable checkpoint snapshot leads the message");
	assert.match(content.at(-1) ?? "", /external outcome is unknown/);
	assert.deepEqual(result.outcome.message.details, { step: 2 }, "checkpoint details survive interruption");
	assert.equal(result.outcome.terminate, false);
	return result;
}

const recovered = await recoveredToolPublishesOnlyCheckpointsAndKeepsFailure();
const aborted = await abortReachesAdmittedToolAndAdmitsNothingNew();
const refused = await abortBeforeAdmissionAdmitsNoEffect();
const interrupted = await interruptedRecoveryKeepsDurableCheckpoint();

assert.deepEqual(
	[recovered.outcome.message.isError, aborted.outcome.message.isError, refused.outcome.message.isError, interrupted.outcome.message.isError],
	[true, true, true, true],
	"every interrupted, refused or failing recovered effect is reported as an error",
);

console.log("execution-lifecycle/transfer regression: all scenarios passed");
