#!/usr/bin/env node
/**
 * Cross-module regression coverage for `advanced/execution-lifecycle/correction`.
 *
 * Real production modules linked through `.prale-eval/subject.mjs`:
 *   - runtime/drive/tools.ts          (recovery + tool procedure)
 *   - runtime/drive/tool-placement.ts (durable placement of staged results)
 *   - runtime/progress.ts             (tool progress channel)
 *   - runtime/types.ts                (real Drive + its effect gate)
 *   - execution/tools.ts              (tool execution + after-tool finalization)
 *   - execution/effect-gate.ts        (effect admission gate)
 *   - hooks.ts                        (real HookRegistry after-tool aggregation)
 *   - session/values.ts, session/commit.ts, session/types.ts (addresses and writes)
 *
 * Boundary fakes: the pi-ai argument validator, the chord context helpers, the
 * telemetry span factory, the session invariant error type, and an in-memory
 * Lane/Session that stores the writes these modules emit. No task-specific
 * adapters are used and no test-only source is appended to production modules.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { createGraph } from "./subject.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DRIVE_TOOLS = "packages/agent/src/harness/runtime/drive/tools.ts";
const TOOL_PLACEMENT = "packages/agent/src/harness/runtime/drive/tool-placement.ts";
const PROGRESS = "packages/agent/src/harness/runtime/progress.ts";
const DRIVE_TYPES = "packages/agent/src/harness/runtime/types.ts";
const EXECUTION_TOOLS = "packages/agent/src/harness/execution/tools.ts";
const EFFECT_GATE = "packages/agent/src/harness/execution/effect-gate.ts";
const HOOKS = "packages/agent/src/harness/hooks.ts";
const VALUES = "packages/agent/src/harness/session/values.ts";
const COMMIT = "packages/agent/src/harness/session/commit.ts";
const SESSION_TYPES = "packages/agent/src/harness/session/types.ts";

const MODULES = [
	DRIVE_TOOLS,
	TOOL_PLACEMENT,
	PROGRESS,
	DRIVE_TYPES,
	EXECUTION_TOOLS,
	EFFECT_GATE,
	HOOKS,
	VALUES,
	COMMIT,
	SESSION_TYPES,
];

class SessionInvariantError extends Error {
	constructor(message) {
		super(message);
		this.name = "SessionInvariantError";
	}
}

/** Structural snapshot that erases realm-specific prototypes before comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	promise.catch(() => {});
	return { promise, resolve };
}

const graph = createGraph(ROOT, MODULES, {
	// The pi-ai argument validator is a boundary; these assertions never depend on its schema work.
	validateToolArguments: (_tool, call) => call.arguments,
	withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
	withoutAbortSignal: (context) => ({ ...context, abortSignal: undefined }),
	startHarnessSpan: (_name, _attributes, callback, context) =>
		callback({ setAttributes() {}, setStatus() {} }, context),
	SessionInvariantError,
});

const driveTools = await graph.module(DRIVE_TOOLS);
const execution = await graph.module(EXECUTION_TOOLS);
const effectGate = await graph.module(EFFECT_GATE);
const hooksModule = await graph.module(HOOKS);
const values = await graph.module(VALUES);
const commit = await graph.module(COMMIT);
const driveTypes = await graph.module(DRIVE_TYPES);

const ASSISTANT = "assistant-1";
const OPERATION = "operation-1";
const TURN = "turn-1";

function toolCall(index, name, arguments_) {
	return { type: "toolCall", id: `call-${index}`, name, arguments: arguments_ };
}

function harnessTool(name, execute, replay = "never") {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		replay,
		execute: async (toolCallId, args, onUpdate, toolContext, invocation, context) =>
			execute({ toolCallId, args, onUpdate, toolContext, invocation, context }),
	};
}

function configurationFor(calls) {
	return {
		model: { provider: "faux", modelId: "faux" },
		thinkingLevel: "off",
		activeToolNames: calls.map((call) => call.name),
	};
}

function toolsOperation(calls, overrides = {}) {
	return {
		at: "tools",
		control: { status: "running" },
		settings: {
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "sequential",
		},
		batch: {
			assistantEntryId: ASSISTANT,
			configuration: configurationFor(calls),
			turnId: TURN,
			calls: calls.map((_call, index) => ({
				status: "planned",
				sourceIndex: index,
				resultEntryId: `result-${index}`,
			})),
		},
		latestAssistantEntryId: ASSISTANT,
		...overrides,
	};
}

/**
 * Fake Lane that only honours the Lane surface drive/tools.ts, progress.ts and
 * tool-placement.ts use: state, command, continueOperation, settleOperation,
 * emitBatch, readConfig, hooks and a session id generator.
 */
function createLane({ hooks, tools, toolContext, mode = "sequential", operation, calls, callStates }) {
	const stored = new Map();
	const entries = new Map();
	const events = [];
	const log = [];
	let seq = 0;
	let timestamp = 0;
	let generated = 0;

	const keyOf = (namespace, key) => `${namespace}\u0000${key}`;
	const reader = {
		async getValue(address) {
			return stored.get(keyOf(address.namespace, address.key));
		},
		async scanValues(prefix) {
			return [...stored.values()].filter(
				(entry) => entry.address.namespace === prefix.namespace && entry.address.key.startsWith(prefix.key),
			);
		},
		async getEntries(ids) {
			const found = new Map();
			for (const id of ids) {
				const entry = entries.get(id);
				if (entry !== undefined) found.set(id, entry);
			}
			return found;
		},
		async readList() {
			return [];
		},
	};

	const applyWrite = (write) => {
		seq += 1;
		if (write.kind === "entry") {
			entries.set(write.entry.id, { ...write.entry, seq });
			return;
		}
		if (write.kind !== "value") return;
		if (write.op === "set") {
			stored.set(keyOf(write.namespace, write.key), {
				address: { namespace: write.namespace, key: write.key, kind: "value" },
				value: write.value,
				seq,
			});
			return;
		}
		stored.delete(keyOf(write.namespace, write.key));
	};

	const applyCommit = (writes) => {
		const stagesOutcome = writes.some(
			(write) => write.kind === "value" && write.op === "set" && write.namespace === "pi.pending.entry",
		);
		const dropsCheckpoint = writes.some(
			(write) => write.kind === "value" && write.op === "delete" && write.namespace === "pi.pending.tool_output",
		);
		if (!stagesOutcome && dropsCheckpoint) log.push("replay_commit");
		const prepared = commit.prepareStorageCommit(writes, seq + 1, (timestamp += 1));
		for (const write of writes) applyWrite(write);
		return { ...prepared.result, stats: { usage: undefined } };
	};

	const lane = {
		name: "main",
		state: undefined,
		hooks,
		session: { idGenerator: { next: () => `generated-${(generated += 1)}` } },
		entries,
		events,
		log,
		readConfig: () => ({
			tools,
			resources: {},
			streamOptions: {},
			retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
			compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: mode,
			toolContext,
			systemPrompt: undefined,
			toProviderMessages: (messages) => messages,
			entryProjectors: {},
		}),
		async emitBatch(batch) {
			events.push(...batch);
			log.push(...batch.map((event) => event.type));
		},
		async command(plan) {
			const decision = await plan(lane.state, reader);
			if (decision.kind === "return") return decision.result;
			if (decision.kind === "reject") throw decision.error;
			const result = applyCommit(decision.writes);
			lane.state = decision.next;
			const materialized = decision.materialize(result);
			const emitted = decision.events?.(result) ?? [];
			if (emitted.length !== 0) await lane.emitBatch(emitted);
			return materialized;
		},
		async settleOperation(_capability, plan) {
			return lane.command(async (state) => {
				const operationMeta = state.operation.meta;
				const decision = await plan(state, state.operation.state, operationMeta, reader);
				if (decision.kind === "commit") {
					return {
						kind: "commit",
						writes: decision.writes,
						next: {
							...state,
							...(decision.lane ?? {}),
							operation: { meta: operationMeta, state: decision.operationState },
						},
						materialize: decision.materialize,
						...(decision.events === undefined ? {} : { events: decision.events }),
					};
				}
				if (decision.kind !== "finish") return decision;
				return {
					kind: "commit",
					writes: decision.writes,
					next: {
						...state,
						...(decision.lane ?? {}),
						lastOperationId: operationMeta.operationId,
						operation: null,
					},
					materialize: decision.materialize,
					...(decision.events === undefined ? {} : { events: decision.events }),
				};
			});
		},
		async continueOperation(capability, plan) {
			return lane.settleOperation(capability, async (state, latest, meta, valueReader) => {
				if (latest.control.status === "cancel_requested") {
					return { kind: "return", result: { kind: "cancel_requested" } };
				}
				const decision = await plan(state, latest, meta, valueReader);
				if (decision.kind === "return") {
					return { kind: "return", result: { kind: "result", value: decision.result } };
				}
				return {
					...decision,
					materialize: (result) => ({ kind: "result", value: decision.materialize(result) }),
				};
			});
		},
	};

	entries.set(ASSISTANT, {
		id: ASSISTANT,
		parentId: null,
		type: "message",
		message: { role: "assistant", content: calls, stopReason: "toolUse", timestamp: 20 },
		seq: 0,
	});
	lane.state = {
		tipId: ASSISTANT,
		configuration: configurationFor(calls),
		inbox: [],
		lastOperationId: null,
		operation: {
			meta: {
				operationId: OPERATION,
				lane: "main",
				sourceTipId: null,
				startedAt: 10,
				intent: { kind: "run", promptEntryIds: [] },
			},
			state: {
				...operation,
				batch: {
					...operation.batch,
					calls: callStates ?? operation.batch.calls,
				},
			},
		},
	};
	return lane;
}

/** Seed durable values the way an interrupted drive pass would have left them. */
async function seedValue(lane, address, value) {
	await lane.command(async () => ({
		kind: "commit",
		writes: [values.setValue(address, value)],
		next: lane.state,
		materialize: () => undefined,
	}));
}

const drive = new driveTypes.Drive({ operationId: OPERATION }, {});

/* ---------------------------------------------------------------------------------------------------------- *
 * 1. Effect gate: closing an aborting gate makes the terminal error authoritative for later admissions.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const { gate, control } = effectGate.createGate();
	const pendingCancellation = deferred();
	control.beginAbort(pendingCancellation.promise);

	let refusal;
	try {
		gate.admit(() => "admitted");
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof effectGate.AbortRequested, "an aborting gate refuses admission with AbortRequested");
	assert.equal(refusal.cancellation, pendingCancellation.promise);

	const terminal = new Error("terminal harness fault");
	control.close(terminal);
	assert.equal(gate.signal.aborted, true, "closing an aborting gate still signals admitted work");
	assert.equal(gate.signal.reason, terminal, "the terminal error becomes the signal reason");

	const attempt = () => {
		try {
			return gate.admit(() => "admitted");
		} catch (error) {
			return error;
		}
	};
	assert.equal(attempt(), terminal, "the terminal error is authoritative for future admissions");

	// A cancellation arriving after the closure must not resurrect the abort path.
	const laterCancellation = deferred();
	control.beginAbort(laterCancellation.promise);
	control.signalAbort();
	assert.equal(attempt(), terminal, "a pending cancellation does not override the closed gate");
	assert.equal(gate.signal.reason, terminal, "the closure reason survives a late cancellation");

	control.close(new Error("second fault"));
	assert.equal(attempt(), terminal, "the first closure remains authoritative");
}

/* ---------------------------------------------------------------------------------------------------------- *
 * 2. Real Drive gate: closing an aborting drive gate replaces the pending cancellation.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const driveGate = new driveTypes.Drive({ operationId: "operation-gate" }, {});
	const cancellation = deferred();
	driveGate.beginAbort(cancellation.promise);
	let refusal;
	try {
		driveGate.gate.admit(() => undefined);
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof effectGate.AbortRequested, "an aborting drive gate refuses admission");

	const terminal = new Error("drive fault");
	driveGate.closeGate(terminal);
	let afterClose;
	try {
		driveGate.gate.admit(() => undefined);
	} catch (error) {
		afterClose = error;
	}
	assert.equal(afterClose, terminal, "the drive gate reports the terminal fault after closure");
	assert.equal(driveGate.gate.signal.reason, terminal);
	const completion = await driveGate.completion.then(
		() => "settled",
		(error) => error,
	);
	assert.equal(completion, terminal, "the drive reports the terminal error");
}

/* ---------------------------------------------------------------------------------------------------------- *
 * 3. A real after-tool hook clears isError through the drive procedure.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const hooks = new hooksModule.HookRegistry(() => {});
	const seen = [];
	hooks.on("after_tool", ({ toolName, isError, content }) => {
		seen.push({ toolName, isError, content: plain(content) });
		return toolName === "failing"
			? { content: [{ type: "text", text: "recovered" }], details: { patched: true }, isError: false }
			: undefined;
	});
	const calls = [toolCall(0, "failing", { value: "input" })];
	const operation = toolsOperation(calls);
	const lane = createLane({
		hooks,
		tools: [
			harnessTool("failing", async () => {
				throw new Error("boom");
			}),
		],
		operation,
		calls,
	});

	await driveTools.runTools(lane, drive, lane.state.operation.state);

	assert.equal(seen.length, 1, "the after-tool hook observes the raw executed result");
	assert.equal(seen[0].toolName, "failing");
	assert.equal(seen[0].isError, true, "the raw executed result is an error");
	const recovered = lane.entries.get("result-0");
	assert.equal(recovered.message.isError, false, "the hook clears isError on the durable transcript");
	assert.deepEqual(plain(recovered.message.content), [{ type: "text", text: "recovered" }]);
	assert.deepEqual(plain(recovered.message.details), { patched: true });
}

/* ---------------------------------------------------------------------------------------------------------- *
 * 4. After-tool finalization: explicit false/empty patch values apply while unspecified fields and usage survive.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const cleared = { toolCall: toolCall(0, "echo", { value: "input" }), tool: harnessTool("echo", () => {}), args: {} };
	const executed = {
		result: { content: [{ type: "text", text: "original" }], details: { original: true }, usage },
		isError: true,
	};

	const kept = execution.finalizeToolCall(cleared, executed, { isError: false });
	assert.equal(kept.isError, false, "an after-tool patch can clear isError");
	assert.deepEqual(plain(kept.result.content), [{ type: "text", text: "original" }]);
	assert.deepEqual(plain(kept.result.details), { original: true });
	assert.deepEqual(plain(kept.result.usage), usage, "usage survives a patch that does not mention it");
	const message = execution.createToolResultMessage(kept);
	assert.equal(message.isError, false);
	assert.deepEqual(plain(message.usage), usage);

	const emptied = execution.finalizeToolCall(cleared, executed, { content: [], details: {}, isError: false });
	assert.deepEqual(plain(emptied.result.content), [], "an explicit empty content patch is applied");
	assert.deepEqual(plain(emptied.result.details), {}, "an explicit empty details patch is applied");
	assert.deepEqual(plain(emptied.result.usage), usage, "unspecified usage is preserved");
	assert.equal(emptied.isError, false);

	const escalated = execution.finalizeToolCall(
		cleared,
		{ result: { content: [], details: {} }, isError: false },
		{ isError: true },
	);
	assert.equal(escalated.isError, true, "an explicit isError patch applies in both directions");
}

/* ---------------------------------------------------------------------------------------------------------- *
 * 5. Recovery of a durable tool batch: non-cancelled safe/safe replay reruns with persisted arguments and
 *    memos, unsafe effects are interrupted, and the after-tool hook patch reaches the durable transcript.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const hooks = new hooksModule.HookRegistry(() => {});
	const calls = [toolCall(0, "safe", { value: "original" }), toolCall(1, "unsafe", { value: "original" })];
	const observations = [];
	const safeUsage = {
		input: 4,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 9,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const safeExecute = async ({ args, onUpdate, invocation, context }) => {
		observations.push({ name: "safe", args: plain(args), memo: plain(await invocation.getMemo("step/a")) });
		assert.equal(context.abortSignal, drive.gate.signal, "the replayed tool is admitted through the drive gate");
		onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { partial: true } }, { checkpoint: true });
		return { content: [{ type: "text", text: "safe replay" }], details: { value: args.value }, usage: safeUsage };
	};
	const unsafeExecute = async () => {
		observations.push({ name: "unsafe" });
		return { content: [{ type: "text", text: "must not run" }], details: {} };
	};

	const operation = toolsOperation(calls);
	const lane = createLane({
		hooks,
		tools: [harnessTool("safe", safeExecute, "safe"), harnessTool("unsafe", unsafeExecute, "never")],
		operation,
		calls,
		callStates: [
			{ status: "effect_pending", sourceIndex: 0, resultEntryId: "result-0", replay: "safe" },
			{ status: "effect_pending", sourceIndex: 1, resultEntryId: "result-1", replay: "never" },
		],
	});
	await seedValue(lane, values.operationToolArgs(OPERATION, TURN, 0), { value: "persisted" });
	await seedValue(lane, values.operationToolArgs(OPERATION, TURN, 1), { value: "unsafe" });
	await seedValue(lane, values.operationToolMemo(OPERATION, "result-0", "step/a"), { complete: true });
	await seedValue(lane, values.pendingToolOutput(OPERATION, "result-0"), {
		content: [{ type: "text", text: "old progress" }],
		details: {},
	});
	await seedValue(lane, values.pendingToolOutput(OPERATION, "result-1"), {
		content: [{ type: "text", text: "durable partial" }],
		details: { progress: "kept" },
	});

	const result = await driveTools.runTools(lane, drive, lane.state.operation.state);
	assert.deepEqual(plain(result), { kind: "continue" });

	assert.deepEqual(
		observations,
		[{ name: "safe", args: { value: "persisted" }, memo: { complete: true } }],
		"the safe/safe replay reruns exactly once with the persisted arguments and memos",
	);

	const safeStart = lane.events.find((event) => event.type === "tool_start" && event.toolCallId === "call-0");
	assert.ok(safeStart, "the replay publishes a recovery tool_start");
	assert.equal(safeStart.recovery, true);
	assert.deepEqual(plain(safeStart.args), { value: "persisted" });
	assert.ok(
		lane.log.indexOf("replay_commit") !== -1 && lane.log.indexOf("replay_commit") < lane.log.indexOf("tool_start"),
		"the replay drops the stale checkpoint before rerunning the effect",
	);
	assert.equal(
		lane.events.some((event) => event.type === "tool_start" && event.toolCallId === "call-1"),
		false,
		"unsafe effects are never replayed",
	);
	const unsafeEnd = lane.events.find((event) => event.type === "tool_end" && event.toolCallId === "call-1");
	assert.equal(unsafeEnd.isError, true);

	const safeEntry = lane.entries.get("result-0");
	assert.deepEqual(plain(safeEntry.message.content), [{ type: "text", text: "safe replay" }]);
	assert.equal(safeEntry.message.isError, false);
	assert.deepEqual(plain(safeEntry.message.usage), safeUsage, "the replayed result keeps its usage");
	assert.deepEqual(plain(safeEntry.message.details), { value: "persisted" });

	const unsafeEntry = lane.entries.get("result-1");
	assert.equal(unsafeEntry.message.isError, true);
	assert.deepEqual(
		plain(unsafeEntry.message.details),
		{ progress: "kept" },
		"the interrupted effect keeps its checkpoint details",
	);
	assert.match(unsafeEntry.message.content.at(-1).text, /external outcome is unknown/);
	assert.equal(lane.state.operation.state.at, "checkpoint", "the completed batch advances the operation");
}
/* ---------------------------------------------------------------------------------------------------------- *
 * 6. A cancelled pass does not rerun safe/safe effects: the replay guard rejects cancellation.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const hooks = new hooksModule.HookRegistry(() => {});
	const observations = [];
	const holder = {};
	const calls = [toolCall(0, "safe-a", { value: "original" }), toolCall(1, "safe-b", { value: "original" })];
	const operation = {
		...toolsOperation(calls, {
			settings: {
				compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
				steeringMode: "all",
				followUpMode: "all",
				toolExecution: "parallel",
			},
		}),
	};
	const first = harnessTool(
		"safe-a",
		async ({ args }) => {
			observations.push({ name: "safe-a", args: plain(args) });
			// Cancellation lands while the parallel batch is still starting later calls.
			holder.lane.state.operation.state.control = { status: "cancel_requested", requestedAt: 30 };
			return { content: [{ type: "text", text: "first" }], details: {} };
		},
		"safe",
	);
	const second = harnessTool(
		"safe-b",
		async () => {
			observations.push({ name: "safe-b" });
			return { content: [{ type: "text", text: "second" }], details: {} };
		},
		"safe",
	);
	const lane = createLane({
		hooks,
		tools: [first, second],
		operation,
		calls,
		mode: "parallel",
		callStates: [
			{ status: "effect_pending", sourceIndex: 0, resultEntryId: "result-0", replay: "safe" },
			{ status: "effect_pending", sourceIndex: 1, resultEntryId: "result-1", replay: "safe" },
		],
	});
	holder.lane = lane;
	await seedValue(lane, values.operationToolArgs(OPERATION, TURN, 0), { value: "persisted-a" });
	await seedValue(lane, values.operationToolArgs(OPERATION, TURN, 1), { value: "persisted-b" });
	await seedValue(lane, values.pendingToolOutput(OPERATION, "result-1"), {
		content: [{ type: "text", text: "durable partial" }],
		details: { progress: "kept" },
	});

	await driveTools.runTools(lane, drive, lane.state.operation.state);

	assert.deepEqual(
		observations,
		[{ name: "safe-a", args: { value: "persisted-a" } }],
		"only the effect admitted before cancellation reruns",
	);
	assert.equal(
		lane.log.filter((entry) => entry === "replay_commit").length,
		1,
		"the cancelled call keeps its checkpoint instead of replaying",
	);
	assert.equal(
		lane.events.some((event) => event.type === "tool_start" && event.toolCallId === "call-1"),
		false,
		"the cancelled call never restarts",
	);
	const cancelledEntry = lane.entries.get("result-1");
	assert.equal(cancelledEntry.message.isError, true);
	assert.deepEqual(plain(cancelledEntry.message.details), { progress: "kept" });
	assert.match(cancelledEntry.message.content.at(-1).text, /external outcome is unknown/);
}

/* ---------------------------------------------------------------------------------------------------------- *
 * 7. A tool that is still running when the drive gate closes with a terminal error fails with that error
 *    instead of waiting on the pending cancellation.
 * ---------------------------------------------------------------------------------------------------------- */

{
	const hooks = new hooksModule.HookRegistry(() => {});
	const started = deferred();
	const finish = deferred();
	const gatedDrive = new driveTypes.Drive({ operationId: "operation-closed" }, {});
	const calls = [toolCall(0, "slow", { value: "input" })];
	const operation = toolsOperation(calls);
	const lane = createLane({
		hooks,
		tools: [
			harnessTool("slow", async () => {
				started.resolve();
				await finish.promise;
				return { content: [{ type: "text", text: "slow" }], details: {} };
			}),
		],
		operation,
		calls,
	});

	const running = driveTools.runTools(lane, gatedDrive, lane.state.operation.state).then(
		() => ({ ok: true }),
		(error) => ({ ok: false, error }),
	);
	await started.promise;

	const terminal = new Error("terminal fault while a tool was running");
	gatedDrive.beginAbort(deferred().promise);
	gatedDrive.signalAbort();
	gatedDrive.closeGate(terminal);
	finish.resolve();

	const settled = await running;
	assert.equal(settled.ok, false, "the procedure fails once the gate is closed");
	assert.equal(settled.error, terminal, "the terminal error wins over the pending cancellation");
}

console.log("regression: execution-lifecycle correction checks passed");
