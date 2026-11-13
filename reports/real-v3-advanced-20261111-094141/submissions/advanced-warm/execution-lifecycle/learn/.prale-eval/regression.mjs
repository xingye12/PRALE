/**
 * Cross-module regression for: "Recovery authorization must survive effect admission".
 *
 * Real production modules linked through the vm graph:
 *   execution/effect-gate.ts          owner-facing gate + procedure-facing admission
 *   execution/tools.ts                cleared-call executor
 *   session/values.ts                 durable value addresses
 *   session/types.ts, session/commit.ts  operation scope + write shapes
 *   runtime/progress.ts               durable tool-output checkpoint channel
 *   runtime/drive/tool-placement.ts   batch source + outcome staging/placement
 *   runtime/drive/tools.ts            recovery admission decision + effect publication
 *
 * Boundary fakes (not part of the defect surface):
 *   `@earendil-works/pi-ai` validateToolArguments
 *   `../context.ts` withAbortSignal
 *   `../../session/session.ts` SessionInvariantError
 *   a minimal durable Lane/Drive pair backed by an in-memory value store
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = "packages/agent/src/harness";

const MODULES = {
	effectGate: `${HARNESS}/execution/effect-gate.ts`,
	executionTools: `${HARNESS}/execution/tools.ts`,
	sessionTypes: `${HARNESS}/session/types.ts`,
	sessionValues: `${HARNESS}/session/values.ts`,
	sessionCommit: `${HARNESS}/session/commit.ts`,
	progress: `${HARNESS}/runtime/progress.ts`,
	placement: `${HARNESS}/runtime/drive/tool-placement.ts`,
	driveTools: `${HARNESS}/runtime/drive/tools.ts`,
};

const OPERATION_ID = "op-1";
const TURN_ID = "turn-1";
const ASSISTANT_ENTRY_ID = "assistant-1";
const RESULT_ENTRY_ID = "result-0";
const TOOL_CALL_ID = "call-0";
const TOOL_OUTPUT_NAMESPACE = "pi.pending.tool_output";
const TOOL_OUTPUT_KEY = `${OPERATION_ID}:${RESULT_ENTRY_ID}`;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const CONFIGURATION = {
	model: { provider: "fake", providerModelId: "fake-model", modelId: "fake-model" },
	thinkingLevel: "off",
	activeToolNames: ["effect"],
};

/** Copy a VM-realm value into host plain data so strict comparisons compare content. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const textOf = (content) =>
	(content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** In-memory durable store that applies lane writes and keeps an ordered observation log. */
function createStore(initial = []) {
	const values = new Map();
	const entries = new Map();
	const observations = [];
	let seq = 0;
	const addressKey = (address) => `${address.namespace}\u0000${address.key}`;

	const store = {
		observations,
		set(namespace, key, value) {
			values.set(`${namespace}\u0000${key}`, { namespace, key, value, seq: (seq += 1) });
		},
		get(namespace, key) {
			return values.get(`${namespace}\u0000${key}`)?.value;
		},
		entry(id) {
			return entries.get(id);
		},
		mark(label, detail) {
			observations.push({ at: observations.length, label, detail });
		},
		apply(writes) {
			const firstSeq = seq + 1;
			for (const write of writes ?? []) {
				if (write.kind === "value") {
					const key = `${write.namespace}\u0000${write.key}`;
					let label;
					if (write.op === "set") {
						values.set(key, { namespace: write.namespace, key: write.key, value: write.value, seq: (seq += 1) });
						label = "value:set";
					} else {
						values.delete(key);
						seq += 1;
						label = "value:delete";
					}
					store.mark(label, `${write.namespace}/${write.key}`);
					continue;
				}
				if (write.kind === "entry") {
					entries.set(write.entry.id, { ...write.entry, seq: (seq += 1) });
					store.mark("entry:insert", write.entry.id);
					continue;
				}
				seq += 1;
				store.mark(write.kind === "list" ? "list:write" : "usage:insert", `${write.namespace}/${write.key}`);
			}
			return {
				firstSeq,
				seqs: (writes ?? []).map((_, index) => firstSeq + index),
				timestamp: observations.length,
				stats: { usage: { ...ZERO_USAGE } },
			};
		},
		reader: {
			async getValue(address) {
				const stored = values.get(addressKey(address));
				return stored === undefined ? undefined : { address, value: stored.value, seq: stored.seq };
			},
			async scanValues(prefix) {
				const stem = `${prefix.namespace}\u0000${prefix.key}`;
				const found = [];
				for (const [key, stored] of values) {
					if (!key.startsWith(stem)) continue;
					found.push({
						address: { namespace: stored.namespace, key: stored.key, kind: "value" },
						value: stored.value,
						seq: stored.seq,
					});
				}
				return found;
			},
			async getEntries(ids) {
				const found = new Map();
				for (const id of ids) if (entries.has(id)) found.set(id, entries.get(id));
				return found;
			},
			async readList() {
				return [];
			},
		},
	};

	for (const [namespace, key, value] of initial) store.set(namespace, key, value);
	return store;
}

/** Minimal durable Lane: one serialized state line with the real command schemas. */
function createLane({ store, operation, config, onEvent }) {
	let sequence = 0;
	let state = {
		tipId: ASSISTANT_ENTRY_ID,
		configuration: CONFIGURATION,
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
			state: operation,
		},
	};
	let tail = Promise.resolve();
	const locked = (run) => {
		const started = tail.then(run, run);
		tail = started.then(
			() => undefined,
			() => undefined,
		);
		return started;
	};
	const applyCommit = (decision) => {
		const commit = store.apply(decision.writes);
		if (decision.next !== undefined) state = decision.next;
		if (decision.operationState !== undefined) {
			state = { ...state, operation: { meta: state.operation.meta, state: decision.operationState } };
		}
		if (decision.lane !== undefined) state = { ...state, ...decision.lane };
		const value = decision.materialize === undefined ? undefined : decision.materialize(commit);
		const emitted = decision.events === undefined ? [] : decision.events(commit);
		if (emitted.length > 0) void lane.emitBatch(emitted);
		return value;
	};
	const settle = (plan) =>
		locked(async () => {
			const operation0 = state.operation;
			const decision = await plan(state, operation0.state, operation0.meta, store.reader);
			if (decision.kind === "return") return decision.result;
			if (decision.kind !== "commit") return undefined;
			return applyCommit({
				writes: [
					...decision.writes,
					{ kind: "value", op: "set", namespace: "pi.op.state", key: OPERATION_ID, value: decision.operationState },
				],
				next: {
					...state,
					...(decision.lane ?? {}),
					operation: { meta: operation0.meta, state: decision.operationState },
				},
				materialize: decision.materialize,
				...(decision.events === undefined ? {} : { events: decision.events }),
			});
		});

	const lane = {
		name: "main",
		session: { idGenerator: { next: () => `generated-${(sequence += 1)}` } },
		get state() {
			return state;
		},
		readConfig: () => config,
		hooks: { runToolWithGate: async () => undefined },
		emitBatch: async (emitted) => {
			if (onEvent !== undefined) await onEvent(emitted, store);
		},
		command: (plan) =>
			locked(async () => {
				const decision = await plan(state, store.reader);
				if (decision.kind === "return") return decision.result;
				if (decision.kind === "reject") throw decision.error;
				return applyCommit(decision);
			}),
		settleOperation: (_capability, plan) => settle(plan),
		continueOperation: (capability, plan) =>
			settle(async (current, latest, meta, reader) => {
				if (latest.control.status === "cancel_requested") {
					return { kind: "return", result: { kind: "cancel_requested" } };
				}
				const decision = await plan(current, latest, meta, reader);
				if (decision.kind === "return") {
					return { kind: "return", result: { kind: "result", value: decision.result } };
				}
				return {
					...decision,
					materialize: (commit) => ({ kind: "result", value: decision.materialize(commit) }),
				};
			}),
	};
	return lane;
}

function createDrive(effectGate) {
	const { gate, control } = effectGate.createGate();
	return {
		operationId: OPERATION_ID,
		context: {},
		gate,
		closeSignal: new AbortController().signal,
		beginAbort: (cancellation) => control.beginAbort(cancellation),
		signalAbort: () => control.signalAbort(),
		closeGate: (error) => control.close(error),
	};
}

function assistantEntry(toolName, args) {
	return {
		id: ASSISTANT_ENTRY_ID,
		parentId: null,
		type: "message",
		seq: 1,
		timestamp: 1,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: TOOL_CALL_ID, name: toolName, arguments: args }],
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function toolsOperation(call) {
	return {
		at: "tools",
		control: { status: "running" },
		settings: { compaction: {}, steeringMode: "queue", followUpMode: "queue", toolExecution: "sequential" },
		latestAssistantEntryId: ASSISTANT_ENTRY_ID,
		batch: {
			assistantEntryId: ASSISTANT_ENTRY_ID,
			configuration: CONFIGURATION,
			turnId: TURN_ID,
			calls: [call],
		},
	};
}

function harnessTool({ name = "effect", replay, execute }) {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		...(replay === undefined ? {} : { replay }),
		execute,
	};
}

const bindings = {
	validateToolArguments: (tool, call) => {
		if (call.arguments === null || typeof call.arguments !== "object") {
			throw new Error(`Validation failed for tool "${tool.name}"`);
		}
		return { ...call.arguments };
	},
	withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
	SessionInvariantError: class SessionInvariantError extends Error {
		constructor(message) {
			super(message);
			this.name = "SessionInvariantError";
		}
	},
};

const graph = createGraph(ROOT, MODULES, bindings, {}, {});
const api = {
	effectGate: await graph.module("effectGate"),
	executionTools: await graph.module("executionTools"),
	values: await graph.module("sessionValues"),
	driveTools: await graph.module("driveTools"),
};

/**
 * Build one restored tool batch whose durable argument checkpoint ("persisted")
 * differs from the stale model arguments ("from-model"), and start `runTools`.
 */
function createRecovery({
	toolReplay = "safe",
	callReplay = "safe",
	includeTool = true,
	cancel = false,
	closeError,
	execute,
	onEvent,
}) {
	const operationArgs = api.values.operationToolArgs(OPERATION_ID, TURN_ID, 0);
	const store = createStore([
		[
			TOOL_OUTPUT_NAMESPACE,
			TOOL_OUTPUT_KEY,
			{ content: [{ type: "text", text: "durable partial" }], details: { progress: "kept" } },
		],
		[operationArgs.namespace, operationArgs.key, { value: "persisted" }],
	]);
	store.apply([{ kind: "entry", entry: assistantEntry("effect", { value: "from-model" }) }]);

	const observed = { args: undefined, checkpointBeforeCall: undefined, executions: 0 };
	const tool = includeTool
		? harnessTool({
				replay: toolReplay,
				execute: async (_id, args, onUpdate) => {
					observed.executions += 1;
					observed.args = plain(args);
					observed.checkpointBeforeCall = plain(store.get(TOOL_OUTPUT_NAMESPACE, TOOL_OUTPUT_KEY));
					store.mark("tool:execute:start", JSON.stringify(args));
					if (execute !== undefined) await execute({ onUpdate, store });
					store.mark("tool:execute:end");
					return { content: [{ type: "text", text: `effect:${args.value}` }], details: { value: args.value } };
				},
			})
		: undefined;

	const lane = createLane({
		store,
		operation: toolsOperation({
			status: "effect_pending",
			sourceIndex: 0,
			resultEntryId: RESULT_ENTRY_ID,
			replay: callReplay,
		}),
		config: {
			tools: tool === undefined ? [] : [tool],
			toolContext: undefined,
			resources: {},
			streamOptions: {},
			retryPolicy: {},
			compaction: {},
			steeringMode: "queue",
			followUpMode: "queue",
			toolExecution: "sequential",
			systemPrompt: undefined,
			toProviderMessages: (messages) => messages,
			entryProjectors: {},
		},
		onEvent,
	});
	const drive = createDrive(api.effectGate);
	if (cancel) drive.beginAbort(Promise.resolve());
	if (closeError !== undefined) drive.closeGate(closeError);
	const running = api.driveTools.runTools(lane, drive, lane.state.operation.state);
	return { store, observed, lane, drive, running };
}

function observationIndex(store, label, detail) {
	const index = store.observations.findIndex(
		(entry) => entry.label === label && (detail === undefined || entry.detail === detail),
	);
	assert.notEqual(index, -1, `expected observation ${label}${detail === undefined ? "" : ` ${detail}`}`);
	return index;
}

function lastCommittedResult(fixture) {
	const entry = fixture.store.entry(RESULT_ENTRY_ID);
	assert.ok(entry, "expected a committed tool result entry");
	return entry.message;
}

const cases = [];
const test = (name, body) => cases.push({ name, body });

/* ------------------------------------------------------------------ gate ---- */

test("the effect gate refuses admission once cancellation is requested", () => {
	const { gate, control } = api.effectGate.createGate();
	const cancellation = Promise.resolve();
	control.beginAbort(cancellation);
	let invoked = 0;
	assert.throws(
		() =>
			gate.admit(() => {
				invoked += 1;
				return "executed";
			}),
		(error) => {
			assert.ok(error instanceof api.effectGate.AbortRequested, "expected AbortRequested");
			assert.equal(error.cancellation, cancellation);
			return true;
		},
	);
	assert.equal(invoked, 0);
	assert.equal(gate.signal.aborted, false, "admission must not depend on the signal being aborted first");
});

test("the effect gate refuses admission after the owner closes it", () => {
	const open = api.effectGate.createGate();
	assert.equal(
		open.gate.admit(() => "executed"),
		"executed",
	);
	const closed = api.effectGate.createGate();
	const failure = new Error("harness closed");
	closed.control.close(failure);
	assert.throws(
		() => closed.gate.admit(() => "executed"),
		(error) => error === failure,
	);
});

/* -------------------------------------------------------------- executor ---- */

test("the executor invokes the effect with the cleared arguments, not the model arguments", async () => {
	const providerCall = {
		type: "toolCall",
		id: TOOL_CALL_ID,
		name: "effect",
		arguments: { value: "from-model" },
	};
	const seen = [];
	const tool = harnessTool({
		execute: async (_id, args) => {
			seen.push(plain(args));
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	});
	const prepared = api.executionTools.prepareToolCall(providerCall, [tool]);
	assert.equal("kind" in prepared, false, "expected a prepared call");
	const cleared = api.executionTools.applyBeforeToolDecision(prepared, { args: { value: "cleared" } });
	assert.equal("kind" in cleared, false, "expected a cleared call");
	assert.deepEqual(plain(cleared.args), { value: "cleared" });

	const { gate } = api.effectGate.createGate();
	const executed = await api.executionTools.executeToolCall(
		cleared,
		gate,
		() => {},
		undefined,
		{
			invocationId: RESULT_ENTRY_ID,
			operationId: OPERATION_ID,
			turnId: TURN_ID,
			getMemo: async () => undefined,
			setMemo: async () => {},
		},
		{},
	);
	assert.deepEqual(seen, [{ value: "cleared" }]);
	assert.equal(executed.isError, false);
	assert.equal(textOf(executed.result.content), "done");
});

test("the executor does not start the effect when admission is refused", async () => {
	const seen = [];
	const cleared = {
		toolCall: { type: "toolCall", id: TOOL_CALL_ID, name: "effect", arguments: { value: "from-model" } },
		tool: harnessTool({
			execute: async () => {
				seen.push("executed");
				return { content: [], details: {} };
			},
		}),
		args: { value: "cleared" },
	};
	const { gate, control } = api.effectGate.createGate();
	control.beginAbort(Promise.resolve());
	assert.throws(() =>
		api.executionTools.executeToolCall(
			cleared,
			gate,
			() => {},
			undefined,
			{
				invocationId: RESULT_ENTRY_ID,
				operationId: OPERATION_ID,
				turnId: TURN_ID,
				getMemo: async () => undefined,
				setMemo: async () => {},
			},
			{},
		),
	);
	assert.deepEqual(seen, []);
});

/* -------------------------------------------------------------- recovery ---- */

test("recovery replays a doubly declared safe effect with persisted arguments", async () => {
	const finishEffect = deferred();
	const updateSeen = deferred();
	const updateDelivery = deferred();
	let outcomeDuringUpdate;
	const fixture = createRecovery({
		execute: async ({ onUpdate }) => {
			onUpdate?.(
				{ content: [{ type: "text", text: "partial" }], details: { progress: "partial" } },
				{ checkpoint: true },
			);
			await finishEffect.promise;
		},
		onEvent: async (emitted, store) => {
			if (!emitted.some((event) => event.type === "tool_update")) return;
			outcomeDuringUpdate = plain(store.get("pi.pending.entry", RESULT_ENTRY_ID));
			updateSeen.resolve();
			await updateDelivery.promise;
			store.mark("tool:update:delivered");
		},
	});

	await updateSeen.promise;
	// The effect is still running: live updates are being delivered, but no outcome is published.
	assert.equal(outcomeDuringUpdate, undefined);
	assert.equal(fixture.store.get("pi.pending.entry", RESULT_ENTRY_ID), undefined);
	assert.equal(fixture.store.entry(RESULT_ENTRY_ID), undefined);

	finishEffect.resolve();
	updateDelivery.resolve();
	assert.deepEqual(plain(await fixture.running), { kind: "continue" });

	// The effect was replayed with the persisted arguments, never the stale model arguments.
	assert.equal(fixture.observed.executions, 1);
	assert.deepEqual(fixture.observed.args, { value: "persisted" });
	// The old checkpoint was cleared before the effect was invoked.
	assert.equal(fixture.observed.checkpointBeforeCall, undefined);

	const clearedCheckpoint = observationIndex(
		fixture.store,
		"value:delete",
		`${TOOL_OUTPUT_NAMESPACE}/${TOOL_OUTPUT_KEY}`,
	);
	const executeStart = observationIndex(fixture.store, "tool:execute:start");
	const progressWrite = observationIndex(
		fixture.store,
		"value:set",
		`${TOOL_OUTPUT_NAMESPACE}/${TOOL_OUTPUT_KEY}`,
	);
	const executeEnd = observationIndex(fixture.store, "tool:execute:end");
	const outcomeWrites = fixture.store.observations
		.map((entry, index) => ({ ...entry, index }))
		.filter((entry) => entry.label === "value:set" && entry.detail === `pi.pending.entry/${RESULT_ENTRY_ID}`)
		.map((entry) => entry.index);
	assert.ok(clearedCheckpoint < executeStart, "the replay checkpoint must be cleared before invocation");
	assert.ok(progressWrite > executeStart && progressWrite < executeEnd, "progress is checkpointed during the effect");
	assert.equal(outcomeWrites.length, 1, "the recovered outcome is published exactly once");
	assert.ok(outcomeWrites[0] > executeEnd, "the outcome is published only after the effect finishes");
	assert.ok(outcomeWrites[0] > progressWrite, "the outcome is published after durable progress");
	assert.ok(
		outcomeWrites[0] > observationIndex(fixture.store, "tool:update:delivered"),
		"the outcome is published after the live update delivery drains",
	);

	const message = lastCommittedResult(fixture);
	assert.equal(message.isError, false);
	assert.equal(textOf(message.content), "effect:persisted");
	assert.deepEqual(plain(message.details), { value: "persisted" });
});

test("recovery keeps an effect interrupted when only the tool declares replay safe", async () => {
	const fixture = createRecovery({ toolReplay: "safe", callReplay: "never" });
	assert.deepEqual(plain(await fixture.running), { kind: "continue" });
	assert.equal(fixture.observed.executions, 0);
	const message = lastCommittedResult(fixture);
	assert.equal(message.isError, true);
	assert.equal(textOf(message.content).includes("external outcome is unknown"), true);
	assert.deepEqual(plain(message.details), { progress: "kept" });
});

test("recovery keeps an effect interrupted when only the checkpoint declares replay safe", async () => {
	const fixture = createRecovery({ toolReplay: "never", callReplay: "safe" });
	assert.deepEqual(plain(await fixture.running), { kind: "continue" });
	assert.equal(fixture.observed.executions, 0);
	const message = lastCommittedResult(fixture);
	assert.equal(message.isError, true);
	assert.equal(textOf(message.content).includes("external outcome is unknown"), true);
	assert.deepEqual(plain(message.details), { progress: "kept" });
});

test("recovery keeps an effect interrupted when its tool is missing", async () => {
	const fixture = createRecovery({ includeTool: false, toolReplay: "safe", callReplay: "safe" });
	assert.deepEqual(plain(await fixture.running), { kind: "continue" });
	assert.equal(fixture.observed.executions, 0);
	const message = lastCommittedResult(fixture);
	assert.equal(message.isError, true);
	const text = textOf(message.content);
	assert.equal(text.includes("external outcome is unknown"), true, `expected interruption, saw: ${text}`);
	assert.equal(/\.execute|is not a function|undefined/.test(text), false, `executor ran without a tool: ${text}`);
	assert.deepEqual(plain(message.details), { progress: "kept" });
});

test("recovery keeps a replay-safe effect interrupted when cancellation wins admission", async () => {
	const fixture = createRecovery({ cancel: true });
	assert.deepEqual(plain(await fixture.running), { kind: "continue" });
	assert.equal(fixture.observed.executions, 0);
	const message = lastCommittedResult(fixture);
	assert.equal(message.isError, true);
	assert.equal(textOf(message.content).includes("external outcome is unknown"), true);
});

test("recovery never executes an effect through a closed gate", async () => {
	const closedError = new Error("harness closed");
	const fixture = createRecovery({ closeError: closedError });
	await assert.rejects(fixture.running, (error) => error === closedError);
	assert.equal(fixture.observed.executions, 0);
	assert.equal(fixture.store.entry(RESULT_ENTRY_ID), undefined);
});

/* ------------------------------------------------------------------ driver --- */

for (const entry of cases) {
	await entry.body();
	console.log(`ok - ${entry.name}`);
}
console.log(`regression passed: ${cases.length} cases`);
