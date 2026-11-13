/**
 * Cross-module regression for the durable tool-invocation lifecycle.
 *
 * Real modules linked in one VM graph (no task-specific adapters, no doubles of the
 * code under test):
 *
 *   - packages/agent/src/harness/execution/effect-gate.ts   admission gate + AbortRequested
 *   - packages/agent/src/harness/execution/tools.ts         executeToolCall: throw -> error output
 *   - packages/agent/src/harness/runtime/progress.ts        durable progress channel
 *   - packages/agent/src/harness/runtime/drive/tools.ts     performToolInvocation: checkpoint
 *                                                           filtering, drain, hooks, outcome
 *
 * Everything else (Session scalar store, lane mutation line, hook bus, bound-value address
 * constructors, chord context, pi-ai validation, tool placement) is a boundary fake supplied
 * here. Ordering is controlled with promises only: no timers, no randomness, no services.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EFFECT_GATE = "packages/agent/src/harness/execution/effect-gate.ts";
const EXECUTION_TOOLS = "packages/agent/src/harness/execution/tools.ts";
const PROGRESS = "packages/agent/src/harness/runtime/progress.ts";
const DRIVE_TOOLS = "packages/agent/src/harness/runtime/drive/tools.ts";

const OPERATION_ID = "operation-1";
const TURN_ID = "turn-1";
const INVOCATION_ID = "result-1";

// ---------------------------------------------------------------------------
// Boundary fakes
// ---------------------------------------------------------------------------

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/** Deterministic identity for a bound-value address produced by the fake values boundary. */
function addressKey(address) {
	const { family, ...rest } = address;
	return `${family}:${JSON.stringify(rest)}`;
}

/** Bound-value address constructors plus the write descriptors they travel in. */
const values = {
	setValue: (address, value) => ({ kind: "set", address, value }),
	deleteValue: (address) => ({ kind: "delete", address }),
	appendList: (address, value) => ({ kind: "append", address, value }),
	pendingToolOutput: (operationId, invocationId) => ({ family: "pendingToolOutput", operationId, invocationId }),
	pendingAssistantFrames: (operationId, responseEntryId) => ({
		family: "pendingAssistantFrames",
		operationId,
		responseEntryId,
	}),
	pendingEntry: (resultEntryId) => ({ family: "pendingEntry", resultEntryId }),
	operationToolArgs: (operationId, turnId, sourceIndex) => ({
		family: "operationToolArgs",
		operationId,
		turnId,
		sourceIndex,
	}),
	operationToolMemo: (operationId, invocationId, name) => ({
		family: "operationToolMemo",
		operationId,
		invocationId,
		name,
	}),
	operationToolMemoPrefix: (operationId, invocationId) => ({
		family: "operationToolMemo",
		operationId,
		invocationId,
	}),
};

const configuration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: ["probe"],
};

/** Lane projection: one recovered call whose durable effect is still pending. */
function operationState() {
	return {
		tipId: "assistant-entry",
		configuration,
		inbox: [],
		lastOperationId: null,
		operation: {
			meta: {
				operationId: OPERATION_ID,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			},
			state: {
				at: "tools",
				control: { status: "running" },
				settings: {
					compaction: {},
					steeringMode: "all",
					followUpMode: "all",
					toolExecution: "parallel",
				},
				inbox: [],
				writes: [],
				latestAssistantEntryId: "assistant-entry",
				batch: {
					assistantEntryId: "assistant-entry",
					configuration,
					turnId: TURN_ID,
					calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId: INVOCATION_ID, replay: "never" }],
				},
			},
		},
	};
}

/**
 * Fake lane: one serialized mutation line over a scalar store, one event bus, one hook bus.
 * `command` mirrors the real contract - plan against the authoritative projection, then
 * (optionally behind a held barrier) apply every write and publish the new projection.
 */
function createLane() {
	const store = new Map();
	const events = [];
	const log = [];
	const hookEvents = [];
	const pendingDeliveries = [];
	let manualDelivery = false;
	let barrier;
	let queue = Promise.resolve();

	const applyWrite = (write) => {
		const key = addressKey(write.address);
		if (write.kind === "delete") {
			store.delete(key);
			return;
		}
		if (write.kind === "append") {
			const list = store.get(key) ?? [];
			list.push(write.value);
			store.set(key, list);
			return;
		}
		store.set(key, write.value);
	};

	const reader = {
		getValue: async (address) => {
			const key = addressKey(address);
			return store.has(key) ? { seq: 1, address, value: store.get(key) } : undefined;
		},
		readList: async (address) =>
			(store.get(addressKey(address)) ?? []).map((value, index) => ({ seq: index + 1, address, value })),
		scanValues: async () => [],
	};

	const lane = {
		name: "main",
		store,
		events,
		log,
		hookEvents,
		state: operationState(),
		readConfig: () => ({ tools: [], toolContext: undefined, retryPolicy: { enabled: false } }),
		hooks: {
			// The real HookRegistry admits the whole pipeline through the gate synchronously.
			runToolWithGate(name, event, gate) {
				return gate.admit(async () => {
					hookEvents.push({ name, event });
					log.push(name);
					return undefined;
				});
			},
		},
		emitBatch(batch) {
			events.push(...batch);
			log.push(`event:${batch.map((event) => event.type).join("+")}`);
			if (!manualDelivery) return Promise.resolve();
			const pending = deferred();
			pendingDeliveries.push(pending);
			return pending.promise;
		},
		command(plan) {
			const run = queue.then(async () => {
				const decision = await plan(lane.state, reader);
				if (decision.kind === "return") return decision.result;
				if (decision.kind === "reject") throw decision.error;
				if (barrier !== undefined) await barrier.promise;
				for (const write of decision.writes) applyWrite(write);
				lane.state = decision.next;
				log.push(`commit:${decision.writes.map((write) => write.kind).join("+")}`);
				return decision.materialize === undefined ? undefined : decision.materialize();
			});
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		/** Resolve once every mutation already enqueued on the line has settled. */
		async flush() {
			await queue;
		},
		holdCommits(promise) {
			barrier = promise;
		},
		useManualDelivery() {
			manualDelivery = true;
		},
		/** Resolve the oldest outstanding live-event delivery. */
		releaseDelivery() {
			const pending = pendingDeliveries.shift();
			if (pending !== undefined) pending.resolve();
		},
		deliveryCount() {
			return pendingDeliveries.length;
		},
		read(address) {
			return store.get(addressKey(address));
		},
	};
	return lane;
}

/** Fake Drive: real gate views plus the process-local context handed to admitted work. */
function createDrive(gate, control) {
	return {
		operationId: OPERATION_ID,
		gate,
		control,
		context: { abortSignal: undefined, toString: () => "[test context]" },
	};
}

function toolCall(name = "probe") {
	return { type: "toolCall", id: "tool-call-1", name, arguments: {} };
}

function partial(text) {
	return { content: [{ type: "text", text }], details: { step: text } };
}

function textOf(result) {
	return (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function toolUpdateEvents(lane) {
	return lane.events.filter((event) => event.type === "tool_update");
}

const invocation = {
	invocationId: INVOCATION_ID,
	operationId: OPERATION_ID,
	turnId: TURN_ID,
	getMemo: async () => undefined,
	setMemo: async () => {},
};

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const graph = createGraph(
	ROOT,
	[EFFECT_GATE, EXECUTION_TOOLS, PROGRESS, DRIVE_TOOLS],
	{
		// pi-ai boundary: argument validation is not part of this incident.
		validateToolArguments: (_tool, call) => call.arguments,
		// chord context boundary: the admitted context carries the gate signal.
		withAbortSignal: (signal, context) => ({
			...(context ?? {}),
			abortSignal: context?.abortSignal === undefined ? signal : AbortSignal.any([context.abortSignal, signal]),
		}),
		// session boundary used only by defensive invariant paths.
		SessionInvariantError: class SessionInvariantError extends Error {},
		...values,
		// tool-placement boundary: placement/materialization is out of scope here.
		materializeReady: async () => undefined,
		readToolBatchSource: async () => ({ assistant: { stopReason: "toolUse", toolCalls: [] }, toolCalls: [] }),
		toolCallFor: (_sources, call) => call.toolCall,
		withToolBatch: (run, batch) => ({ ...run, batch }),
	},
	{},
	{
		// Expose the module-private invocation procedure so the test can drive the real
		// producer (tool update callback) through the real consumer (progress + drive).
		[DRIVE_TOOLS]: "\nexport { performToolInvocation as __performToolInvocation };\n",
	},
);

const gateModule = await graph.module(EFFECT_GATE);
const executionTools = await graph.module(EXECUTION_TOOLS);
const progressModule = await graph.module(PROGRESS);
const driveTools = await graph.module(DRIVE_TOOLS);

assert.equal(typeof gateModule.createGate, "function");
assert.equal(typeof gateModule.AbortRequested, "function");
assert.equal(typeof executionTools.executeToolCall, "function");
assert.equal(typeof progressModule.openToolProgress, "function");
assert.equal(typeof driveTools.runTools, "function");
assert.equal(typeof driveTools.__performToolInvocation, "function");

const performToolInvocation = driveTools.__performToolInvocation;

function pendingInvocation(lane, tool) {
	const state = lane.state.operation.state;
	return {
		batch: state.batch,
		call: state.batch.calls[0],
		cleared: { toolCall: toolCall(tool.name), tool, args: {} },
	};
}

// ---------------------------------------------------------------------------
// 1. Effect gate: abort-first admission, and signaling the admitted effect
// ---------------------------------------------------------------------------

{
	const { gate, control } = gateModule.createGate();
	const cancellation = deferred();
	const aborts = [];
	gate.signal.addEventListener("abort", () => aborts.push("abort"));

	assert.equal(gate.signal.aborted, false, "a fresh gate must not be aborted");
	assert.equal(gate.admit(() => "admitted"), "admitted", "an open gate admits synchronously");

	control.beginAbort(cancellation.promise);
	assert.equal(
		gate.signal.aborted,
		false,
		"beginAbort alone must not signal: the cancellation marker has not committed yet",
	);

	// No new effect may be admitted once durable cancellation has begun.
	const startedAfterBeginAbort = [];
	let refusal;
	try {
		gate.admit(() => startedAfterBeginAbort.push("started"));
	} catch (error) {
		refusal = error;
	}
	assert.ok(
		refusal instanceof gateModule.AbortRequested,
		"admission after beginAbort must be refused with the shared AbortRequested",
	);
	assert.equal(refusal.cancellation, cancellation.promise);
	assert.deepEqual(startedAfterBeginAbort, [], "a refused admission must never invoke its effect");

	// Signaling must reach the already-admitted effect's signal.
	control.signalAbort();
	assert.equal(gate.signal.aborted, true, "signalAbort must abort the admitted work's signal");
	assert.deepEqual(aborts, ["abort"], "abort listeners must fire exactly once");
	assert.ok(
		gate.signal.reason instanceof gateModule.AbortRequested,
		"the gate must abort with its own AbortRequested so waiters treat it as expected cancellation",
	);

	cancellation.resolve();
}

// ---------------------------------------------------------------------------
// 2. Tool execution boundary: a throw stays an error, and an abort-first gate
//    never starts the tool
// ---------------------------------------------------------------------------

for (const [label, execute] of [
	[
		"synchronous",
		() => {
			throw new Error("tool failed synchronously");
		},
	],
	[
		"asynchronous",
		async () => {
			throw new Error("tool failed asynchronously");
		},
	],
]) {
	const { gate } = gateModule.createGate();
	const executed = await executionTools.executeToolCall(
		{ toolCall: toolCall(), tool: { name: "probe", label: "Probe", description: "probe", execute }, args: {} },
		gate,
		() => {},
		undefined,
		invocation,
		{ abortSignal: undefined },
	);
	assert.equal(executed.isError, true, `a ${label} tool throw must stay an error result`);
	assert.match(textOf(executed.result), /tool failed/, `the ${label} throw message must be preserved`);
}

{
	const { gate, control } = gateModule.createGate();
	const cancellation = deferred();
	control.beginAbort(cancellation.promise);
	let started = 0;
	let refusal;
	try {
		executionTools.executeToolCall(
			{
				toolCall: toolCall(),
				tool: {
					name: "probe",
					label: "Probe",
					description: "probe",
					execute: async () => {
						started += 1;
						return partial("never");
					},
				},
				args: {},
			},
			gate,
			() => {},
			undefined,
			invocation,
			{ abortSignal: undefined },
		);
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof gateModule.AbortRequested);
	assert.equal(started, 0, "no tool effect may start after beginAbort");
	cancellation.resolve();
}

// ---------------------------------------------------------------------------
// 3. Recovered invocation: live progress vs. durable checkpoints, then a throw
// ---------------------------------------------------------------------------

{
	const lane = createLane();
	const { gate, control } = gateModule.createGate();
	const drive = createDrive(gate, control);
	const seen = {};

	const tool = {
		name: "probe",
		label: "Probe",
		description: "probe",
		async execute(_id, _args, onUpdate) {
			const liveOnly = partial("live-only");
			onUpdate(liveOnly);
			await lane.flush();
			seen.afterLiveOnly = lane.read(values.pendingToolOutput(drive.operationId, INVOCATION_ID));

			const checkpoint = partial("checkpoint");
			onUpdate(checkpoint, { checkpoint: true });
			await lane.flush();
			seen.afterCheckpoint = lane.read(values.pendingToolOutput(drive.operationId, INVOCATION_ID));

			const trailingLive = partial("trailing-live");
			onUpdate(trailingLive);
			await lane.flush();
			seen.afterTrailingLive = lane.read(values.pendingToolOutput(drive.operationId, INVOCATION_ID));

			throw new Error("recovered tool exploded");
		},
	};

	const built = pendingInvocation(lane, tool);
	const outcome = await performToolInvocation(lane, drive, built.batch, built.call, built.cleared, undefined, true);

	// Every admitted live update reached observers, in order, tagged as recovery work.
	const updates = toolUpdateEvents(lane);
	assert.deepEqual(
		updates.map((event) => event.partialResult.details.step),
		["live-only", "checkpoint", "trailing-live"],
		"every admitted live update must reach observers in order",
	);
	assert.deepEqual(
		updates.map((event) => event.recovery),
		[true, true, true],
		"recovered invocations must tag live updates as recovery work",
	);
	assert.deepEqual(
		updates.map((event) => event.toolCallId),
		["tool-call-1", "tool-call-1", "tool-call-1"],
	);

	// Only checkpoint:true updates were persisted.
	assert.equal(seen.afterLiveOnly, undefined, "a live-only update must never be persisted");
	assert.equal(seen.afterCheckpoint?.details.step, "checkpoint", "checkpoint:true must persist its snapshot");
	assert.equal(
		seen.afterTrailingLive?.details.step,
		"checkpoint",
		"a live update after the checkpoint must not replace the durable snapshot",
	);

	// The tool exception stays an error in the final message.
	assert.equal(outcome.message.role, "toolResult");
	assert.equal(outcome.message.isError, true, "a tool exception must remain an error in the final message");
	assert.match(textOf(outcome.message), /recovered tool exploded/);
	assert.equal(outcome.terminate, false);

	const afterTool = lane.hookEvents.filter((hook) => hook.name === "after_tool");
	assert.equal(afterTool.length, 1, "after_tool must run once for a real recovered execution");
	assert.equal(afterTool[0].event.isError, true, "after_tool must observe the error result");
	assert.equal(
		lane.log.indexOf("commit:set") < lane.log.indexOf("after_tool"),
		true,
		"the durable checkpoint commit must precede after_tool",
	);
}

// ---------------------------------------------------------------------------
// 4. Ordering: live delivery and progress drain complete before after_tool
// ---------------------------------------------------------------------------

{
	const lane = createLane();
	lane.useManualDelivery();
	const commitBarrier = deferred();
	lane.holdCommits(commitBarrier.promise);
	const { gate, control } = gateModule.createGate();
	const drive = createDrive(gate, control);
	const toolReturned = deferred();

	const tool = {
		name: "probe",
		label: "Probe",
		description: "probe",
		async execute(_id, _args, onUpdate) {
			onUpdate(partial("checkpoint"), { checkpoint: true });
			toolReturned.resolve();
			return partial("final");
		},
	};

	const built = pendingInvocation(lane, tool);
	const running = performToolInvocation(lane, drive, built.batch, built.call, built.cleared, undefined, false);

	await toolReturned.promise;
	// The checkpoint commit is still held: neither after_tool nor publication may happen yet.
	assert.deepEqual(lane.hookEvents, [], "after_tool must wait for the drained checkpoint");
	assert.equal(lane.read(values.pendingToolOutput(OPERATION_ID, INVOCATION_ID)), undefined);
	assert.equal(lane.deliveryCount(), 1, "the live update delivery must still be outstanding");

	commitBarrier.resolve();
	lane.releaseDelivery();
	const outcome = await running;
	lane.log.push("publish-outcome");

	assert.equal(lane.read(values.pendingToolOutput(OPERATION_ID, INVOCATION_ID))?.details.step, "checkpoint");
	const commitIndex = lane.log.indexOf("commit:set");
	const afterToolIndex = lane.log.indexOf("after_tool");
	const publishIndex = lane.log.indexOf("publish-outcome");
	assert.notEqual(commitIndex, -1, "the checkpoint must be committed");
	assert.notEqual(afterToolIndex, -1, "after_tool must run");
	assert.equal(commitIndex < afterToolIndex, true, "final hooks must follow progress drain");
	assert.equal(afterToolIndex < publishIndex, true, "final publication must follow progress drain");
	assert.equal(outcome.message.isError, false, "a successful effect is not an error");
	assert.equal(textOf(outcome.message), "final");
	assert.deepEqual(
		lane.hookEvents.map((hook) => hook.event.isError),
		[false],
	);
}

// ---------------------------------------------------------------------------
// 5. Signaling the abort reaches the already-admitted tool's AbortSignal
// ---------------------------------------------------------------------------

{
	const lane = createLane();
	const { gate, control } = gateModule.createGate();
	const drive = createDrive(gate, control);
	const toolStarted = deferred();
	const releaseTool = deferred();
	const signalEvents = [];
	const observed = {};

	const tool = {
		name: "probe",
		label: "Probe",
		description: "probe",
		async execute(_id, _args, _onUpdate, _toolContext, _invocation, context) {
			assert.equal(context.abortSignal, gate.signal, "the admitted tool must own the gate signal");
			context.abortSignal.addEventListener("abort", () => signalEvents.push("abort"), { once: true });
			observed.abortedBefore = context.abortSignal.aborted;
			toolStarted.resolve();
			await releaseTool.promise;
			observed.abortedAtSettlement = context.abortSignal.aborted;
			return partial("finished after abort");
		},
	};

	const built = pendingInvocation(lane, tool);
	const running = performToolInvocation(lane, drive, built.batch, built.call, built.cleared, undefined, false);

	await toolStarted.promise;
	assert.equal(gate.signal.aborted, false, "an open gate must not signal before the marker commits");

	const cancellation = deferred();
	control.beginAbort(cancellation.promise);
	assert.deepEqual(signalEvents, [], "beginAbort alone must not signal the admitted tool");
	cancellation.resolve();
	control.signalAbort();

	assert.equal(gate.signal.aborted, true, "signalAbort must reach the already-admitted tool's signal");
	assert.deepEqual(signalEvents, ["abort"], "the tool's abort listener must fire");

	releaseTool.resolve();
	const outcome = await running;
	assert.equal(observed.abortedBefore, false);
	assert.equal(observed.abortedAtSettlement, true, "the admitted tool must observe the abort signal");
	assert.equal(outcome.message.isError, false, "a tool that settles after abort keeps its real result");
	assert.equal(textOf(outcome.message), "finished after abort");
	assert.equal(lane.log.includes("after_tool"), false, "after_tool must not start once the gate is aborting");
}

console.log("regression: durable tool lifecycle invariants hold across effect-gate, execution, progress, drive");
