/**
 * Lifecycle-fence regression: cancellation and completion must fence off late activity.
 *
 * Linked production modules (real code):
 *   - packages/agent/src/harness/execution/effect-gate.ts   (admission gate / terminal error)
 *   - packages/agent/src/harness/execution/tools.ts         (tool executor / live update callback)
 *   - packages/agent/src/harness/runtime/drive/tools.ts     (recovery scheduler / checkpoint + effect admission)
 *
 * Boundary fakes supply the durable session layer (values, progress, placement) and the
 * provider/context helpers, so every assertion observes behavior across module boundaries:
 * the scheduler drives the real executor through the real gate.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const GATE = "packages/agent/src/harness/execution/effect-gate.ts";
const EXECUTOR = "packages/agent/src/harness/execution/tools.ts";
const SCHEDULER = "packages/agent/src/harness/runtime/drive/tools.ts";

/** Realm-safe structural copy: values often come from the VM module context. */
const json = (value) => JSON.parse(JSON.stringify(value));

const USAGE = {
	input: 3,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class SessionInvariantError extends Error {
	constructor(message) {
		super(message);
		this.name = "SessionInvariantError";
	}
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

/* ------------------------------------------------------------------ gate --- */
/* A closed gate is terminal: a late beginAbort cannot reopen admission or replace the error. */
async function gateFence() {
	const graph = createGraph(root, GATE);
	const { AbortRequested, createGate } = await graph.module(GATE);

	const terminal = new Error("drive finished");
	const { gate, control } = createGate();
	let admitted = 0;
	assert.equal(
		gate.admit(() => {
			admitted += 1;
			return "admitted";
		}),
		"admitted",
		"open gate admits work",
	);

	control.close(terminal);
	// Late cancellation after completion: the gate is sealed and must stay sealed.
	control.beginAbort(Promise.resolve());
	control.signalAbort();

	let refusal;
	try {
		gate.admit(() => {
			admitted += 1;
			return "reopened";
		});
	} catch (error) {
		refusal = error;
	}
	assert.equal(refusal, terminal, "closed gate keeps refusing with its terminal error");
	assert.equal(refusal instanceof AbortRequested, false, "terminal error is not replaced by AbortRequested");
	assert.equal(admitted, 1, "closed gate never invokes admitted work");
	assert.equal(gate.signal.aborted, true, "closed gate stays aborted");
	assert.equal(gate.signal.reason, terminal, "closed gate keeps its terminal abort reason");

	// A genuinely aborting gate still refuses before admission with the cancellation promise.
	const aborting = createGate();
	const cancellation = deferred();
	aborting.control.beginAbort(cancellation.promise);
	let refusedWhileAborting;
	try {
		aborting.gate.admit(() => "never");
	} catch (error) {
		refusedWhileAborting = error;
	}
	assert.ok(refusedWhileAborting instanceof AbortRequested, "aborting gate refuses admission");
	assert.equal(refusedWhileAborting.cancellation, cancellation.promise, "AbortRequested carries the cancellation");
	assert.equal(aborting.gate.signal.aborted, false, "aborting gate signals only after cancellation settles");
	cancellation.resolve();
	await cancellation.promise;
	aborting.control.signalAbort();
	assert.equal(aborting.gate.signal.aborted, true, "aborting gate signals once cancellation settles");

	control.close(new Error("second close"));
	assert.equal(gate.signal.reason, terminal, "repeat close cannot replace the terminal error");
	console.log("ok - gate: closed gate is terminal");
}

/* -------------------------------------------------------------- executor --- */
/* Completion seals the live-update and checkpoint callback channel of a finished tool. */
async function executorFence() {
	const graph = createGraph(
		root,
		[EXECUTOR, GATE],
		{
			validateToolArguments: (_tool, call) => call.arguments,
			withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
		},
		{},
	);
	const executor = await graph.module(EXECUTOR);
	const { createGate } = await graph.module(GATE);

	const { gate } = createGate();
	const updates = [];
	const finished = deferred();
	let lateUpdate;
	let invoked = 0;
	const tool = {
		name: "echo",
		label: "Echo",
		description: "echo",
		parameters: {},
		async execute(_toolCallId, args, onUpdate) {
			invoked += 1;
			onUpdate({ content: [{ type: "text", text: "early" }], details: { step: 1 } }, { checkpoint: true });
			lateUpdate = onUpdate;
			await finished.promise;
			onUpdate({ content: [{ type: "text", text: "during" }], details: { step: 2 } }, { checkpoint: true });
			return { content: [{ type: "text", text: args.value }], details: { step: 3 }, usage: USAGE };
		},
	};
	const call = {
		toolCall: { type: "toolCall", id: "call-1", name: "echo", arguments: { value: "done" } },
		tool,
		args: { value: "done" },
	};
	const invocation = {
		invocationId: "res-1",
		operationId: "op-1",
		turnId: "turn-1",
		getMemo: async () => undefined,
		setMemo: async () => {},
	};

	const running = executor.executeToolCall(
		call,
		gate,
		(partial, options) => updates.push({ partial: json(partial), options: options ?? {} }),
		undefined,
		invocation,
		{},
	);
	assert.equal(invoked, 1, "gate admitted the tool effect");
	assert.equal(updates.length, 1, "in-flight update reaches the live channel");
	assert.equal(updates[0].options.checkpoint, true, "checkpoint intent is forwarded while running");

	finished.resolve();
	const executed = await running;
	assert.equal(executed.isError, false, "tool completes without error");
	assert.equal(updates.length, 2, "updates emitted before completion are delivered");

	// The tool keeps its callback and fires after it resolved: completion must have sealed the channel.
	lateUpdate({ content: [{ type: "text", text: "late" }], details: { step: 4 } }, { checkpoint: true });
	assert.equal(updates.length, 2, "completed tool cannot publish new live updates");
	assert.deepEqual(
		updates.map(({ partial }) => partial.content[0].text),
		["early", "during"],
		"only pre-completion updates were published",
	);

	// Cross-module fence: a sealed gate refuses the effect before the tool ever runs.
	const sealed = createGate();
	const terminal = new Error("run finished");
	sealed.control.close(terminal);
	let refusal;
	try {
		executor.executeToolCall(
			call,
			sealed.gate,
			() => {
				throw new Error("sealed tool must not publish updates");
			},
			undefined,
			invocation,
			{},
		);
	} catch (error) {
		refusal = error;
	}
	assert.equal(refusal, terminal, "sealed gate refuses tool admission with its terminal error");
	assert.equal(invoked, 1, "sealed gate never invokes the tool effect");
	console.log("ok - executor: completion seals live and checkpoint callbacks");
}

/* ------------------------------------------------------------- scheduler --- */
/* Cancelled recoveries only settle the durable leaf: they never clear or re-invoke. */
function durableHarness() {
	const store = new Map();
	const events = [];
	const activity = [];
	const appliedWrites = [];
	const checkpointWrites = [];
	const progressChannels = [];
	const executions = [];
	const keys = {
		pendingToolOutput: (operationId, resultEntryId) => `pi.pending.tool_output/${operationId}/${resultEntryId}`,
		operationToolArgs: (operationId, turnId, sourceIndex) =>
			`pi.op.tool_args/${operationId}/${turnId}/${sourceIndex}`,
		operationToolMemo: (operationId, resultEntryId, name) => `pi.op.tool_memo/${operationId}/${resultEntryId}/${name}`,
		operationToolMemoPrefix: (operationId, resultEntryId) => `pi.op.tool_memo/${operationId}/${resultEntryId}/`,
		pendingEntry: (resultEntryId) => `pi.pending.entry/${resultEntryId}`,
	};
	const reader = {
		async getValue(key) {
			activity.push({ op: "read", key });
			return store.has(key) ? { value: store.get(key) } : undefined;
		},
		async scanValues(prefix) {
			return [...store.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([address, value]) => ({ address, value }));
		},
	};
	const applyWrites = (writes) => {
		for (const write of writes ?? []) {
			activity.push({ op: "write", key: write.key, write });
			appliedWrites.push(write);
			if (write.op === "set") store.set(write.key, write.value);
			else store.delete(write.key);
		}
	};
	const commit = { timestamp: 1_000 };
	const runDecision = (decision) => {
		if (decision.kind === "return") return decision.result;
		if (decision.kind === "reject") throw decision.error;
		applyWrites(decision.writes);
		events.push(...(decision.events?.(commit) ?? []));
		return decision.materialize?.(commit);
	};

	const batch = {
		assistantEntryId: "assistant-1",
		turnId: "turn-1",
		configuration: {
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "off",
			activeToolNames: ["safe"],
		},
		calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId: "res-1", replay: "safe" }],
	};
	const run = {
		at: "tools",
		control: { status: "running" },
		settings: {
			compaction: { enabled: false },
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		batch,
		latestAssistantEntryId: "assistant-1",
	};
	const sources = {
		assistant: { stopReason: "toolUse" },
		toolCalls: { "res-1": { type: "toolCall", id: "call-0", name: "safe", arguments: { value: "recovered" } } },
	};
	const tool = {
		name: "safe",
		label: "Safe",
		description: "safe replayable tool",
		parameters: {},
		replay: "safe",
		async execute(_toolCallId, args, onUpdate) {
			executions.push(json(args));
			onUpdate?.(
				{ content: [{ type: "text", text: "live" }], details: { live: true } },
				{ checkpoint: true },
			);
			return { content: [{ type: "text", text: "replayed" }], details: { value: "safe" }, usage: USAGE };
		},
	};

	const lane = {
		name: "main",
		state: { operation: { meta: { operationId: "op-1" }, state: run }, inbox: [], lastOperationId: null },
		command: async (planner) => runDecision(await planner(lane.state, reader)),
		settleOperation: async (capability, planner) =>
			runDecision(await planner(lane.state, capability, { operationId: "op-1" }, reader)),
		continueOperation: async (_capability, planner) =>
			runDecision(await planner(lane.state, run)),
		emitBatch: async (batchEvents) => {
			events.push(...batchEvents);
		},
		hooks: { runToolWithGate: async () => undefined },
	};

	return {
		store,
		events,
		activity,
		appliedWrites,
		checkpointWrites,
		progressChannels,
		executions,
		keys,
		reader,
		batch,
		run,
		sources,
		tool,
		lane,
		bindings: {
			validateToolArguments: (_tool, call) => call.arguments,
			withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
			SessionInvariantError,
			setValue: (key, value) => ({ op: "set", key, value }),
			deleteValue: (key) => ({ op: "delete", key }),
			pendingEntry: keys.pendingEntry,
			pendingToolOutput: keys.pendingToolOutput,
			operationToolArgs: keys.operationToolArgs,
			operationToolMemo: keys.operationToolMemo,
			operationToolMemoPrefix: keys.operationToolMemoPrefix,
			openToolProgress: () => {
				const channel = {
					items: [],
					sealed: false,
					write(item) {
						if (channel.sealed) return;
						channel.items.push(item);
						checkpointWrites.push(item);
					},
					seal() {
						channel.sealed = true;
					},
					async drain() {},
				};
				progressChannels.push(channel);
				return channel;
			},
			materializeReady: async () => {},
			readToolBatchSource: async () => sources,
			toolCallFor: (batchSources, call) => batchSources.toolCalls[call.resultEntryId],
			withToolBatch: (capability, next) => ({ ...capability, batch: next }),
		},
	};
}

async function recover({ cancelled }) {
	const harness = durableHarness();
	const graph = createGraph(root, [SCHEDULER, EXECUTOR, GATE], harness.bindings, {}, {
		[SCHEDULER]: "\nexport { recoverToolInvocation };\n",
	});
	const scheduler = await graph.module(SCHEDULER);
	const { createGate } = await graph.module(GATE);

	const { gate } = createGate();
	const closeController = new AbortController();
	const drive = {
		operationId: "op-1",
		context: {},
		gate,
		closeSignal: closeController.signal,
	};
	const checkpointKey = harness.keys.pendingToolOutput("op-1", "res-1");
	harness.store.set(checkpointKey, {
		content: [{ type: "text", text: "durable partial" }],
		details: { progress: "kept" },
		usage: USAGE,
	});
	harness.store.set(harness.keys.operationToolArgs("op-1", "turn-1", 0), { value: "persisted" });

	const task = await scheduler.recoverToolInvocation(
		harness.lane,
		drive,
		harness.run,
		harness.sources,
		harness.batch.calls[0],
		new Map([[harness.tool.name, harness.tool]]),
		undefined,
		cancelled,
	);
	// Control asynchronous ordering with promises only: the completion settles synchronously here.
	await task.completion;
	return harness;
}

async function cancelledRecoveryFence() {
	const harness = await recover({ cancelled: true });
	assert.equal(harness.progressChannels.length, 0, "cancelled recovery never opens a progress checkpoint channel");
	assert.equal(harness.checkpointWrites.length, 0, "cancelled recovery never writes a checkpoint");
	const checkpointTouches = harness.activity.filter(
		(entry) => entry.key === harness.keys.pendingToolOutput("op-1", "res-1"),
	);
	assert.equal(checkpointTouches[0]?.op, "read", "cancelled recovery reads the checkpoint before settling it");
	assert.equal(
		checkpointTouches.filter((entry) => entry.op === "write" && entry.write.op === "delete").length,
		1,
		"cancelled recovery clears the checkpoint only through its own terminal outcome",
	);
	assert.deepEqual(harness.executions, [], "cancelled recovery never invokes the tool effect");
	const starts = harness.events.filter((event) => event.type === "tool_start");
	const ends = harness.events.filter((event) => event.type === "tool_end");
	const updates = harness.events.filter((event) => event.type === "tool_update");
	assert.equal(starts.length, 0, "cancelled recovery publishes no tool_start");
	assert.equal(updates.length, 0, "cancelled recovery publishes no tool_update");
	assert.equal(ends.length, 1, "cancelled recovery publishes exactly one terminal tool_end");
	assert.equal(ends[0].recovery, true, "terminal tool_end is marked as recovery");
	assert.equal(ends[0].isError, true, "cancelled recovery result is an error");
	const result = json(ends[0].result);
	assert.deepEqual(
		result.content[0],
		{ type: "text", text: "durable partial" },
		"cancelled recovery consumes the durable checkpoint before clearing it",
	);
	assert.equal(result.content.at(-1).text.includes("external outcome is unknown"), true, "interruption marker published");
	assert.deepEqual(result.details, { progress: "kept" }, "cancelled recovery preserves checkpoint details");
	assert.deepEqual(result.usage, USAGE, "cancelled recovery preserves checkpoint usage");

	const staged = harness.store.get(harness.keys.pendingEntry("res-1"));
	assert.equal(staged?.type, "message", "cancelled recovery stages one durable result");
	const message = json(staged.payload);
	assert.equal(message.role, "toolResult", "staged result is a tool-result message");
	assert.equal(message.isError, true, "staged cancelled result is an error");
	assert.deepEqual(message.details, { progress: "kept" }, "staged cancelled message keeps details");
	assert.deepEqual(message.usage, USAGE, "staged cancelled message keeps usage");
	console.log("ok - scheduler: cancelled recovery never clears or invokes");
}

async function liveRecoveryFence() {
	const harness = await recover({ cancelled: false });
	assert.deepEqual(harness.executions, [{ value: "persisted" }], "safe/safe recovery replays persisted arguments once");
	assert.equal(
		harness.appliedWrites.some(
			(write) => write.op === "delete" && write.key === harness.keys.pendingToolOutput("op-1", "res-1"),
		),
		true,
		"safe/safe recovery clears its stale checkpoint",
	);
	assert.equal(
		harness.store.has(harness.keys.pendingToolOutput("op-1", "res-1")),
		false,
		"cleared checkpoint is gone from the durable store",
	);

	const starts = harness.events.filter((event) => event.type === "tool_start");
	const ends = harness.events.filter((event) => event.type === "tool_end");
	assert.equal(starts.length, 1, "safe/safe recovery publishes exactly one tool_start");
	assert.equal(starts[0].recovery, true, "recovered tool_start is marked as recovery");
	assert.deepEqual(json(starts[0].args), { value: "persisted" }, "recovered tool_start reports replayed args");
	assert.equal(ends.length, 1, "safe/safe recovery publishes exactly one tool_end");
	assert.equal(ends[0].recovery, true, "recovered tool_end is marked as recovery");
	assert.equal(ends[0].isError, false, "completed recovery is not an error");
	const result = json(ends[0].result);
	assert.deepEqual(result.content, [{ type: "text", text: "replayed" }], "recovery publishes the replayed content");
	assert.deepEqual(result.details, { value: "safe" }, "recovery preserves executed details");
	assert.deepEqual(result.usage, USAGE, "recovery preserves executed usage");
	assert.equal(harness.events.filter((event) => event.type === "tool_update").length, 1, "live update published once");

	const staged = json(harness.store.get(harness.keys.pendingEntry("res-1")));
	assert.equal(staged.type, "message", "recovery stages its durable result");
	assert.equal(staged.payload.isError, false, "staged recovery result is not an error");
	assert.deepEqual(staged.payload.details, { value: "safe" }, "staged recovery message keeps details");
	assert.deepEqual(staged.payload.usage, USAGE, "staged recovery message keeps usage");
	console.log("ok - scheduler: live safe/safe recovery still completes and publishes once");
}

await gateFence();
await executorFence();
await cancelledRecoveryFence();
await liveRecoveryFence();
console.log("regression: lifecycle fences hold");
