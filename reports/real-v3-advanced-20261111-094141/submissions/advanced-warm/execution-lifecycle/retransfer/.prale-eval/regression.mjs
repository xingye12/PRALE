/**
 * Cross-module regression for the execution-lifecycle fencing incident.
 *
 * Real production modules linked together:
 *   harness/execution/effect-gate.ts        the owner/procedure lifecycle gate
 *   harness/execution/tools.ts              the tool effect executor (live + checkpoint callbacks)
 *   harness/runtime/drive/tools.ts          the tool batch scheduler (recovery paths)
 *   harness/runtime/drive/tool-placement.ts the durable staging/placement procedure
 *   harness/runtime/types.ts                Drive, the real owner of one gate
 *   harness/runtime/progress.ts, session/types.ts, session/values.ts, session/commit.ts
 *
 * Boundary fakes: pi-ai argument validation, the session invariant error, the context
 * helpers, and a minimal serialized-mutation lane that records events/commits and serves
 * reads from an in-memory value store. Asynchronous ordering is driven by promises only.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createGraph } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");

const MODULES = [
	"packages/agent/src/harness/session/types.ts",
	"packages/agent/src/harness/session/values.ts",
	"packages/agent/src/harness/session/commit.ts",
	"packages/agent/src/harness/execution/effect-gate.ts",
	"packages/agent/src/harness/execution/tools.ts",
	"packages/agent/src/harness/runtime/progress.ts",
	"packages/agent/src/harness/runtime/drive/tool-placement.ts",
	"packages/agent/src/harness/runtime/types.ts",
	"packages/agent/src/harness/runtime/drive/tools.ts",
];

class SessionInvariantError extends Error {}

const bindings = {
	// pi-ai argument validation over the empty schemas used by these fakes.
	validateToolArguments: (_tool, call) => call.arguments,
	// session/session.ts: only the invariant error type is consumed by these modules.
	SessionInvariantError,
	// context.ts helpers: keep the caller context, attach/detach the gate signal.
	withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
	withoutAbortSignal: (context) => ({ ...context, abortSignal: undefined }),
};

const graph = createGraph(root, MODULES, bindings);
const gateModule = await graph.module("packages/agent/src/harness/execution/effect-gate.ts");
const execution = await graph.module("packages/agent/src/harness/execution/tools.ts");
const driveTypes = await graph.module("packages/agent/src/harness/runtime/types.ts");
const values = await graph.module("packages/agent/src/harness/session/values.ts");
const scheduler = await graph.module("packages/agent/src/harness/runtime/drive/tools.ts");

const passed = [];
function pass(name) {
	passed.push(name);
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const text = (value) => ({ content: [{ type: "text", text: value }] });
const textOf = (result) => (result.content ?? []).map((block) => block.text).join("|");

const zUsage = {
	input: 3,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 7,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/* ---------------------------------------------------------------------------------------
 * 1. Gate fences: a closed gate is terminal.
 * ------------------------------------------------------------------------------------- */

function gateCannotReopen() {
	const { gate, control } = gateModule.createGate();
	const terminal = new Error("drive closed");
	control.close(terminal);

	// A late cancellation request lands after the pass was sealed.
	control.beginAbort(Promise.resolve());
	control.signalAbort();

	assert.throws(
		() => gate.admit(() => "must not run"),
		(error) => {
			assert.equal(error, terminal, "admit must keep refusing with the terminal gate error");
			return true;
		},
	);
	assert.equal(gate.signal.aborted, true, "a closed gate stays signalled");
	assert.equal(gate.signal.reason, terminal, "the abort reason stays the terminal error");

	const later = new Error("late close");
	control.close(later);
	assert.throws(
		() => gate.admit(() => "must not run"),
		(error) => {
			assert.equal(error, terminal, "the first terminal error is final");
			return true;
		},
	);
	assert.equal(gate.signal.reason, terminal, "the closed gate reason is final");
	pass("gate: beginAbort neither reopens a closed gate nor replaces its terminal error");
}

function gateAbortStillFences() {
	const { gate, control } = gateModule.createGate();
	const cancellation = deferred();
	control.beginAbort(cancellation.promise);
	assert.throws(() => gate.admit(() => "must not run"), (error) => {
		assert.ok(error instanceof gateModule.AbortRequested, "an aborting gate refuses admission");
		assert.equal(error.cancellation, cancellation.promise, "the refusal carries the cancellation promise");
		return true;
	});
	assert.equal(gate.signal.aborted, false, "signalling waits for the durable cancellation");

	cancellation.resolve();
	control.signalAbort();
	assert.equal(gate.signal.aborted, true, "signalAbort signals admitted work");
	assert.ok(gate.signal.reason instanceof gateModule.AbortRequested);

	const terminal = new Error("settled while aborting");
	control.close(terminal);
	assert.throws(
		() => gate.admit(() => "must not run"),
		(error) => {
			assert.equal(error, terminal, "completion replaces the abort request with the terminal error");
			return true;
		},
	);
	pass("gate: abort still fences new effects and completion keeps the terminal error");
}

function sealedDriveCannotReopen() {
	const drive = new driveTypes.Drive({ operationId: "op-gate" }, {});
	const terminal = new Error("drive sealed");
	drive.closeGate(terminal);
	// requestOperationAbort() calls beginAbort on the active drive before its command lands.
	drive.beginAbort(Promise.resolve());
	drive.signalAbort();
	assert.throws(
		() => drive.gate.admit(() => "must not run"),
		(error) => {
			assert.equal(error, terminal, "a sealed drive never re-admits effects after a late abort request");
			return true;
		},
	);
	pass("gate: a sealed Drive never reopens for a late abort request");
}

/* ---------------------------------------------------------------------------------------
 * 2. Executor fence: completion seals live and checkpoint callbacks.
 * ------------------------------------------------------------------------------------- */

function clearedCall(id, name, execute) {
	return {
		toolCall: { id, name, arguments: { value: name } },
		tool: { name, execute },
		args: { value: name },
	};
}

async function completionSealsCallbacks() {
	const { gate } = gateModule.createGate();
	const forwarded = [];
	const record = (partial, options) =>
		forwarded.push({ text: textOf(partial), checkpoint: options?.checkpoint === true });
	const invocation = { invocationId: "call-0", operationId: "op-exec", turnId: "turn-1" };
	let publish = () => {};
	const execute = async (_id, _args, onUpdate) => {
		publish = (partial, options) => onUpdate(partial, options);
		onUpdate(text("live"));
		onUpdate(text("checkpoint"), { checkpoint: true });
		return { ...text("done"), details: { value: "done" } };
	};
	const executed = await execution.executeToolCall(
		clearedCall("call-0", "stream", execute),
		gate,
		record,
		undefined,
		invocation,
		{},
	);

	assert.deepEqual(
		forwarded,
		[
			{ text: "live", checkpoint: false },
			{ text: "checkpoint", checkpoint: true },
		],
		"updates raised while the tool runs are forwarded verbatim",
	);
	assert.equal(executed.isError, false, "the admitted effect produced a result");
	assert.equal(textOf(executed.result), "done");

	// The tool promise already settled: nothing may escape through the stale callback.
	publish(text("late live"));
	publish(text("late checkpoint"), { checkpoint: true });
	assert.equal(forwarded.length, 2, "completion seals both live and checkpoint callbacks");
	pass("executor: completion seals live and checkpoint callbacks");
}

async function failureSealsCallbacks() {
	const { gate } = gateModule.createGate();
	const forwarded = [];
	const invocation = { invocationId: "call-1", operationId: "op-exec", turnId: "turn-1" };
	let publish = () => {};
	const execute = async (_id, _args, onUpdate) => {
		publish = (partial, options) => onUpdate(partial, options);
		onUpdate(text("before failure"));
		throw new Error("tool exploded");
	};
	const executed = await execution.executeToolCall(
		clearedCall("call-1", "boom", execute),
		gate,
		(partial, options) => forwarded.push({ text: textOf(partial), checkpoint: options?.checkpoint === true }),
		undefined,
		invocation,
		{},
	);
	assert.equal(executed.isError, true, "tool throws become error output");
	assert.equal(forwarded.length, 1, "updates raised before the throw are forwarded");

	publish(text("after failure"), { checkpoint: true });
	assert.equal(forwarded.length, 1, "completion seals callbacks after a failed tool too");
	pass("executor: completion seals callbacks after failure as well");
}

/* ---------------------------------------------------------------------------------------
 * Minimal serialized-mutation lane mirroring the Lane surface used by drive/tools.ts.
 * ------------------------------------------------------------------------------------- */

function createStore() {
	const valuesByKey = new Map();
	const entriesById = new Map();
	let seq = 0;
	const keyOf = (address) => `${address.namespace}\u0000${address.key}`;
	return {
		entries: entriesById,
		nextSeq: () => ++seq,
		has: (address) => valuesByKey.has(keyOf(address)),
		get: (address) => valuesByKey.get(keyOf(address)),
		set: (address, value) => valuesByKey.set(keyOf(address), value),
		remove: (address) => valuesByKey.delete(keyOf(address)),
		scan(prefix) {
			const found = [];
			for (const [key, value] of valuesByKey) {
				const separator = key.indexOf("\u0000");
				const namespace = key.slice(0, separator);
				const rest = key.slice(separator + 1);
				if (namespace !== prefix.namespace || !rest.startsWith(prefix.key)) continue;
				found.push({ address: { namespace, key: rest, kind: "value" }, value, seq: ++seq });
			}
			return found;
		},
	};
}

function createWorld(options) {
	const { operationId, calls, tools, toolExecution, control, toolContext } = options;
	const store = createStore();
	const events = [];
	const commits = [];
	const hookCalls = [];
	let usageIds = 0;

	const configuration = { activeToolNames: tools.map(({ name }) => name) };
	const run = {
		at: "tools",
		control,
		settings: { toolExecution },
		latestAssistantEntryId: null,
		batch: { assistantEntryId: "assistant", configuration, turnId: "turn-1", calls },
	};
	const lane = {
		name: "main",
		state: {
			tipId: "assistant",
			configuration,
			inbox: [],
			lastOperationId: null,
			currentOperationId: operationId,
			operation: { meta: { operationId, intent: { kind: "run", promptEntryIds: [] } }, state: run },
		},
		session: { idGenerator: { next: () => `usage-${++usageIds}` } },
		hooks: {
			async runToolWithGate(event) {
				hookCalls.push(event);
				return undefined;
			},
			async runWithGate() {
				return undefined;
			},
		},
		models: { getModel: () => undefined, cancelDeferred: async () => undefined },
		readConfig: () => config,
		async emitBatch(batch) {
			events.push(...(Array.isArray(batch) ? batch : [batch]));
		},
		command,
		continueOperation,
		settleOperation,
	};

	const reader = {
		async getValue(address) {
			return store.has(address) ? { address, value: store.get(address), seq: store.nextSeq() } : undefined;
		},
		async scanValues(prefix) {
			return store.scan(prefix);
		},
		async getEntries(ids) {
			const found = new Map();
			for (const id of ids) {
				const entry = store.entries.get(id);
				if (entry !== undefined) found.set(id, entry);
			}
			return found;
		},
	};

	function applyWrite(write) {
		if (write.kind === "value") {
			if (write.op === "set") store.set(write, write.value);
			else store.remove(write);
			return;
		}
		if (write.kind === "entry") store.entries.set(write.entry.id, { ...write.entry });
	}

	function record(decision) {
		commits.push(
			decision.writes.map((write) => ({
				kind: write.kind,
				op: write.op,
				namespace: write.namespace,
				key: write.key,
			})),
		);
		for (const write of decision.writes) applyWrite(write);
		if (decision.lane?.tipId !== undefined) lane.state.tipId = decision.lane.tipId;
		if (decision.events !== undefined) events.push(...decision.events({ seqs: [], timestamp: 1, stats: { usage: {} } }));
		return decision.materialize({ seqs: [], timestamp: 1, stats: { usage: {} } });
	}

	async function command(decide) {
		const decision = await decide(lane.state, reader);
		if (decision.kind === "return") return decision.result;
		if (decision.kind === "reject") throw decision.error;
		if (decision.next !== undefined) lane.state = decision.next;
		return record(decision);
	}

	async function continueOperation(_capability, decide) {
		const operation = lane.state.operation;
		if (operation === null || operation.state.control.status === "cancel_requested") {
			return { kind: "cancel_requested" };
		}
		const decision = await decide(lane.state, operation.state, operation.meta, reader);
		if (decision.kind === "return") return { kind: "result", value: decision.result };
		lane.state.operation = { ...operation, state: decision.operationState };
		return { kind: "result", value: record(decision) };
	}

	async function settleOperation(_capability, decide) {
		const operation = lane.state.operation;
		if (operation === null) return undefined;
		const decision = await decide(lane.state, operation.state, operation.meta, reader);
		if (decision.kind === "return") return decision.result;
		lane.state.operation = { ...operation, state: decision.operationState };
		return record(decision);
	}

	const config = {
		tools,
		resources: {},
		streamOptions: {},
		retryPolicy: {},
		compaction: {},
		steeringMode: "queue",
		followUpMode: "queue",
		toolExecution,
		toolContext,
		systemPrompt: undefined,
		toProviderMessages: () => [],
		entryProjectors: [],
	};

	store.entries.set("assistant", {
		id: "assistant",
		parentId: null,
		type: "message",
		message: {
			role: "assistant",
			api: "faux",
			provider: "faux",
			model: "faux-model",
			usage: zUsage,
			stopReason: "toolUse",
			timestamp: 1,
			content: calls.map((call, index) => ({
				type: "toolCall",
				id: `call-${index}`,
				name: call.toolName,
				arguments: { value: call.toolName },
			})),
		},
	});

	const drive = new driveTypes.Drive({ operationId }, {});
	return { store, lane, drive, run, events, commits, hookCalls, configuration, config };
}

function eventsOfType(events, type, toolCallId) {
	return events.filter(
		(event) => event.type === type && (toolCallId === undefined || event.toolCallId === toolCallId),
	);
}

/* ---------------------------------------------------------------------------------------
 * 3. Scheduler fence: a cancelled recovery never clears the checkpoint and never invokes.
 * ------------------------------------------------------------------------------------- */

async function cancelledRecoveryIsFenced() {
	const operationId = "op-cancel";
	const executed = [];
	const world = createWorld({
		operationId,
		calls: [
			{ status: "effect_pending", sourceIndex: 0, resultEntryId: "result-0", replay: "safe", toolName: "safe" },
		],
		tools: [
			{
				name: "safe",
				replay: "safe",
				async execute(...args) {
					executed.push(args);
					return { ...text("replayed"), details: { value: "replayed" } };
				},
			},
		],
		toolExecution: "parallel",
		control: { status: "running" },
		// Cancellation commits while the pass resolves its tool context, before the batch
		// dispatch observes live control. Everything after this point must stay fenced.
		toolContext: async () => {
			world.lane.state.operation = {
				...world.lane.state.operation,
				state: { ...world.lane.state.operation.state, control: { status: "cancel_requested", requestedAt: 5 } },
			};
		},
	});

	world.store.set(values.operationToolArgs(operationId, "turn-1", 0), { value: "persisted" });
	world.store.set(values.operationToolMemo(operationId, "result-0", "step/a"), { complete: true });
	world.store.set(values.pendingToolOutput(operationId, "result-0"), {
		...text("durable partial"),
		details: { progress: "kept" },
		usage: zUsage,
	});

	await scheduler.runTools(world.lane, world.drive, world.run);

	assert.equal(executed.length, 0, "a cancelled recovery never crosses the tool effect boundary");
	assert.equal(
		eventsOfType(world.events, "tool_start").length,
		0,
		"a cancelled recovery never replays the persisted checkpoint (no tool_start)",
	);
	const standaloneClears = world.commits.filter(
		(writes) =>
			writes.some((write) => write.namespace === "pi.pending.tool_output" && write.op === "delete") &&
			!writes.some((write) => write.namespace === "pi.pending.entry" && write.op === "set"),
	);
	assert.equal(standaloneClears.length, 0, "a cancelled recovery never clears the checkpoint on its own");

	const ends = eventsOfType(world.events, "tool_end", "call-0");
	assert.equal(ends.length, 1, "the cancelled recovery settles the call exactly once");
	assert.equal(ends[0].isError, true, "the settled call reports the interruption");
	assert.equal(ends[0].recovery, true, "the settled call is published as a recovery");

	const staged = world.store.entries.get("result-0");
	assert.ok(staged !== undefined, "the interrupted outcome is staged for placement");
	assert.equal(staged.message.isError, true);
	assert.equal(textOf(staged.message).split("|")[0], "durable partial", "the durable checkpoint content is kept");
	assert.match(textOf(staged.message), /external outcome is unknown/, "the interruption marker is appended");
	assert.deepEqual(staged.message.details, { progress: "kept" }, "checkpoint details survive the fence");
	assert.deepEqual(staged.message.usage, zUsage, "checkpoint usage survives the fence");
	assert.equal(world.hookCalls.length, 0, "a cancelled recovery admits no ordinary tool hooks");
	pass("scheduler: a cancelled recovery neither clears the checkpoint nor invokes the tool");
}

/* ---------------------------------------------------------------------------------------
 * 4. Scheduler completeness: a live safe/safe recovery still replays, preserves the
 *    result, and publishes exactly once.
 * ------------------------------------------------------------------------------------- */

async function safeRecoveryStillCompletes() {
	const operationId = "op-safe";
	const invocations = [];
	const memoReads = [];
	const updates = [];
	const world = createWorld({
		operationId,
		calls: [
			{ status: "effect_pending", sourceIndex: 0, resultEntryId: "result-0", replay: "safe", toolName: "safe" },
		],
		tools: [
			{
				name: "safe",
				replay: "safe",
				async execute(_id, args, onUpdate, _toolContext, invocation) {
					invocations.push(args);
					memoReads.push(await invocation.getMemo("step/a"));
					onUpdate(text("live progress"));
					onUpdate(text("checkpoint progress"), { checkpoint: true });
					return { ...text("safe replay"), details: { value: "safe" }, usage: zUsage };
				},
			},
		],
		toolExecution: "parallel",
		control: { status: "running" },
		toolContext: undefined,
	});

	world.store.set(values.operationToolArgs(operationId, "turn-1", 0), { value: "persisted" });
	world.store.set(values.operationToolMemo(operationId, "result-0", "step/a"), { complete: true });
	world.store.set(values.pendingToolOutput(operationId, "result-0"), {
		...text("old progress"),
		details: { progress: "stale" },
	});

	await scheduler.runTools(world.lane, world.drive, world.run);

	assert.equal(invocations.length, 1, "a live safe/safe recovery replays the persisted effect once");
	assert.deepEqual(invocations[0], { value: "persisted" }, "the replay uses the persisted arguments");
	assert.deepEqual(memoReads, [{ complete: true }], "the replay keeps its invocation memos");

	const starts = eventsOfType(world.events, "tool_start", "call-0");
	assert.equal(starts.length, 1, "the replay publishes one tool_start");
	assert.deepEqual(starts[0].args, { value: "persisted" });
	assert.equal(starts[0].recovery, true);
	assert.equal(eventsOfType(world.events, "tool_end", "call-0").length, 1, "the replay publishes one tool_end");
	assert.equal(eventsOfType(world.events, "tool_update", "call-0").length, 2, "live and checkpoint updates flow");
	assert.equal(
		world.events.filter((event) => event.type === "message_start" && event.message.toolCallId === "call-0").length,
		1,
		"the placement publishes exactly one message_start",
	);
	assert.equal(world.events.filter((event) => event.type === "message_end" && event.entryId === "result-0").length, 1);
	assert.equal(world.events.filter((event) => event.type === "entry_added" && event.entry.id === "result-0").length, 1);

	const staged = world.store.entries.get("result-0");
	assert.ok(staged !== undefined, "the replayed result is staged for placement");
	assert.equal(staged.message.isError, false, "the replayed result is not an error");
	assert.equal(textOf(staged.message), "safe replay");
	assert.deepEqual(staged.message.details, { value: "safe" }, "tool details survive the replay");
	assert.deepEqual(staged.message.usage, zUsage, "tool usage survives the replay");
	assert.equal(
		world.store.has(values.operationToolMemo(operationId, "result-0", "step/a")),
		false,
		"the consumed memo is cleaned up with the outcome",
	);
	assert.equal(updates.length, 0, "no unused counters");
	pass("scheduler: a live safe/safe recovery completes, preserves usage/details, and publishes once");
}

async function unsafeRecoveryStillInterrupts() {
	const operationId = "op-unsafe";
	const executed = [];
	const world = createWorld({
		operationId,
		calls: [
			{ status: "effect_pending", sourceIndex: 0, resultEntryId: "result-0", replay: "never", toolName: "unsafe" },
		],
		tools: [
			{
				name: "unsafe",
				replay: "never",
				async execute() {
					executed.push(1);
					return text("must not run");
				},
			},
		],
		toolExecution: "parallel",
		control: { status: "running" },
		toolContext: undefined,
	});

	world.store.set(values.operationToolArgs(operationId, "turn-1", 0), { value: "unsafe" });
	world.store.set(values.pendingToolOutput(operationId, "result-0"), {
		...text("durable partial"),
		details: { progress: "kept" },
		usage: zUsage,
	});

	await scheduler.runTools(world.lane, world.drive, world.run);

	assert.equal(executed.length, 0, "an unsafe effect is never replayed");
	assert.equal(eventsOfType(world.events, "tool_end", "call-0").length, 1, "the unsafe call settles once");
	const staged = world.store.entries.get("result-0");
	assert.ok(staged !== undefined);
	assert.equal(staged.message.isError, true);
	assert.deepEqual(staged.message.details, { progress: "kept" }, "the durable checkpoint details are preserved");
	assert.deepEqual(staged.message.usage, zUsage, "the durable checkpoint usage is preserved");
	assert.match(textOf(staged.message), /external outcome is unknown/);
	pass("scheduler: an unsafe recovery still interrupts while preserving its checkpoint");
}

gateCannotReopen();
gateAbortStillFences();
sealedDriveCannotReopen();
await completionSealsCallbacks();
await failureSealsCallbacks();
await cancelledRecoveryIsFenced();
await safeRecoveryStillCompletes();
await unsafeRecoveryStillInterrupts();

console.log(`regression: ${passed.length} scenario groups passed`);
for (const name of passed) console.log(`  ok ${name}`);
