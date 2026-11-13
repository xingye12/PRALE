/**
 * Cross-module regression for the execution-lifecycle correction.
 *
 * Real modules linked as production code:
 *   - packages/agent/src/harness/execution/effect-gate.ts   (admission gate)
 *   - packages/agent/src/harness/execution/tools.ts         (execute / after-tool finalize)
 *   - packages/agent/src/harness/hooks.ts                   (after_tool aggregate pipeline)
 *   - packages/agent/src/harness/runtime/drive/tools.ts     (durable recovery + safe replay)
 *
 * Everything else (lane command bus, session value store, progress channel, session
 * errors, tool placement) is supplied here as an explicit boundary fake. No real
 * time, randomness or external service is used; ordering is controlled with promises.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EFFECT_GATE = "packages/agent/src/harness/execution/effect-gate.ts";
const EXECUTION_TOOLS = "packages/agent/src/harness/execution/tools.ts";
const HOOKS = "packages/agent/src/harness/hooks.ts";
const DRIVE_TOOLS = "packages/agent/src/harness/runtime/drive/tools.ts";

/** Values created inside the VM realm have foreign prototypes; compare plain data. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------- boundary fakes

class SessionInvariantError extends Error {}

const address = (namespace, id) => ({ namespace, id });
const addressKey = (value) => `${value.namespace}\u0000${value.id}`;

const setValue = (target, value) => ({ kind: "value", op: "set", namespace: target.namespace, id: target.id, value });
const deleteValue = (target) => ({ kind: "value", op: "delete", namespace: target.namespace, id: target.id });

const operationToolArgs = (operationId, turnId, sourceIndex) =>
	address("pi.op.tool_args", `${operationId}/${turnId}/${sourceIndex}`);
const operationToolMemo = (operationId, resultEntryId, name) =>
	address("pi.op.tool_memo", `${operationId}/${resultEntryId}/${name}`);
const operationToolMemoPrefix = (operationId, resultEntryId) =>
	address("pi.op.tool_memo", `${operationId}/${resultEntryId}/`);
const pendingEntry = (entryId) => address("pi.pending.entry", entryId);
const pendingToolOutput = (operationId, resultEntryId) =>
	address("pi.pending.tool_output", `${operationId}/${resultEntryId}`);

class ValueStore {
	#entries = new Map();

	get(target) {
		return this.#entries.get(addressKey(target))?.value;
	}

	set(target, value) {
		this.#entries.set(addressKey(target), { address: target, value });
	}

	delete(target) {
		this.#entries.delete(addressKey(target));
	}

	scan(prefix) {
		const start = addressKey(prefix);
		return [...this.#entries.entries()]
			.filter(([key]) => key.startsWith(start))
			.map(([, entry]) => ({ address: entry.address, value: entry.value }));
	}
}

/** Context helper fake: remember the admitted child context for the hook span fake. */
let admittedContext;
const withAbortSignal = (signal, context) => {
	const next = { ...context, abortSignal: signal };
	admittedContext = next;
	return next;
};

const startHarnessSpan = async (_name, _attributes, run) =>
	run({ setAttributes() {}, setStatus() {} }, admittedContext ?? {});

const openToolProgress = () => ({ write() {}, seal() {}, drain: async () => {} });

const bindings = {
	withAbortSignal,
	startHarnessSpan,
	openToolProgress,
	SessionInvariantError,
	setValue,
	deleteValue,
	operationToolArgs,
	operationToolMemo,
	operationToolMemoPrefix,
	pendingEntry,
	pendingToolOutput,
	toolCallFor: (sources, call) => sources.calls.get(call.sourceIndex),
	withToolBatch: (run, batch) => ({ ...run, batch }),
	materializeReady: async () => {},
	readToolBatchSource: async () => {
		throw new Error("readToolBatchSource is outside this regression's boundary");
	},
	validateToolArguments: () => {
		throw new Error("validateToolArguments is outside this regression's boundary");
	},
};

const graph = createGraph(ROOT, [EFFECT_GATE, EXECUTION_TOOLS, HOOKS, DRIVE_TOOLS], bindings, {}, {
	[DRIVE_TOOLS]:
		"\nexport const __boundary = { recoverToolInvocation, performToolInvocation, publishToolOutcome };\n",
});

const gateModule = await graph.module(EFFECT_GATE);
const executionTools = await graph.module(EXECUTION_TOOLS);
const hooksModule = await graph.module(HOOKS);
const driveTools = await graph.module(DRIVE_TOOLS);

function createHookRegistry() {
	const errors = [];
	const hooks = new hooksModule.HookRegistry((error) => {
		errors.push(error);
	});
	return { hooks, errors };
}

/**
 * One durable tool batch whose only call is an `effect_pending` safe-replay candidate.
 * The lane fake implements only the command/settle/emit surface this procedure uses.
 */
function createDriveFixture({ hooks, toolName = "safe", callReplay = "safe", storedArgs, memo, checkpoint }) {
	const store = new ValueStore();
	if (storedArgs !== undefined) store.set(operationToolArgs("op-1", "turn-1", 0), storedArgs);
	if (checkpoint !== undefined) store.set(pendingToolOutput("op-1", "res-1"), checkpoint);
	if (memo !== undefined) store.set(operationToolMemo("op-1", "res-1", memo.name), memo.value);

	const timeline = [];
	const events = [];
	const toolCall = { type: "toolCall", id: "call-0", name: toolName, arguments: { value: "live" } };
	const call = { status: "effect_pending", sourceIndex: 0, resultEntryId: "res-1", replay: callReplay };
	const batch = {
		assistantEntryId: "assistant-1",
		configuration: { activeToolNames: [toolName] },
		turnId: "turn-1",
		calls: [call],
	};
	const run = {
		at: "tools",
		control: { status: "running" },
		settings: { compaction: {}, steeringMode: "all", followUpMode: "all", toolExecution: "sequential" },
		batch,
		latestAssistantEntryId: "assistant-1",
	};
	const laneState = { operation: { meta: { operationId: "op-1" }, state: run } };
	const { gate } = gateModule.createGate();
	const drive = { operationId: "op-1", context: {}, gate };
	const sources = {
		assistant: { role: "assistant", content: [toolCall], stopReason: "toolUse", timestamp: 1 },
		calls: new Map([[0, toolCall]]),
	};
	const reader = {
		getValue: async (target) => {
			const value = store.get(target);
			return value === undefined ? undefined : { value };
		},
		scanValues: async (prefix) => store.scan(prefix),
		getEntries: async () => new Map(),
	};
	const settle = (result) => {
		if (result === undefined) return undefined;
		if (result.kind === "return") return result.result;
		if (result.kind === "reject") throw result.error;
		for (const write of result.writes ?? []) {
			timeline.push(`${write.op}:${write.namespace}`);
			if (write.op === "set") store.set(write, write.value);
			else store.delete(write);
		}
		if (result.operationState !== undefined) laneState.operation.state = result.operationState;
		for (const event of result.events?.() ?? []) {
			timeline.push(`event:${event.type}`);
			events.push(event);
		}
		return result.materialize?.();
	};
	const lane = {
		name: "main",
		state: laneState,
		hooks,
		command: async (mutate) => settle(await mutate(laneState, reader)),
		settleOperation: async (_capability, mutate) =>
			settle(await mutate(laneState, laneState.operation.state, {}, reader)),
		emitBatch: async (batchEvents) => {
			for (const event of batchEvents) {
				timeline.push(`event:${event.type}`);
				events.push(event);
			}
		},
	};
	return { lane, drive, run, sources, call, batch, toolCall, store, timeline, events, spec: toolName };
}

// ----------------------------------------------------------------------- checks

const checks = [];

function check(name, body) {
	checks.push({ name, body });
}

check("an aborting gate closed with a terminal error keeps that error authoritative", async () => {
	const { gate, control } = gateModule.createGate();
	let releaseCancellation;
	const cancellation = new Promise((resolve) => {
		releaseCancellation = resolve;
	});
	control.beginAbort(cancellation);

	// While the cancellation is pending, admission reports the cancellation request.
	assert.throws(() => gate.admit(() => "never"), gateModule.AbortRequested);

	const terminal = new Error("drive sealed");
	control.close(terminal);

	// The terminal closure wins over the still-pending cancellation.
	assert.throws(
		() => gate.admit(() => "never"),
		(error) => error === terminal,
	);
	assert.equal(gate.signal.aborted, true);
	assert.equal(gate.signal.reason, terminal);

	// Late cancellation signalling must not turn the closure back into a cancellation.
	control.signalAbort();
	assert.throws(
		() => gate.admit(() => "never"),
		(error) => error === terminal,
	);
	assert.equal(gate.signal.reason, terminal);

	// The first terminal error stays authoritative.
	control.close(new Error("later seal"));
	assert.throws(
		() => gate.admit(() => "never"),
		(error) => error === terminal,
	);

	releaseCancellation();
	await cancellation;
});

check("closed gate refuses admitted hook work instead of reporting a pending cancellation", async () => {
	const { gate, control } = gateModule.createGate();
	const { hooks, errors } = createHookRegistry();
	let handlerCalls = 0;
	hooks.on("before_tool", () => {
		handlerCalls += 1;
		return undefined;
	});

	const cancellation = new Promise(() => {});
	control.beginAbort(cancellation);
	const terminal = new Error("harness closed");
	control.close(terminal);

	assert.throws(
		() =>
			hooks.runToolWithGate(
				"before_tool",
				{ lane: "main", runId: "op-1", toolCallId: "call-0", toolName: "safe", args: {} },
				gate,
				{},
			),
		(error) => error === terminal,
	);
	assert.equal(handlerCalls, 0);
	assert.deepEqual(plain(errors), []);
});

check("non-cancelled safe/safe replay re-executes the persisted call and clears its checkpoint", async () => {
	const { hooks, errors } = createHookRegistry();
	const fixture = createDriveFixture({
		hooks,
		storedArgs: { value: "persisted" },
		memo: { name: "step/a", value: { complete: true } },
		checkpoint: { content: [{ type: "text", text: "old progress" }], details: {} },
	});
	const calls = [];
	const tool = {
		name: "safe",
		replay: "safe",
		execute: async (toolCallId, args, onUpdate, _toolContext, invocation) => {
			onUpdate({ content: [{ type: "text", text: "half way" }], details: { progress: "half" } }, { checkpoint: true });
			calls.push({ toolCallId, args: plain(args), memo: plain(await invocation.getMemo("step/a")) });
			return { content: [{ type: "text", text: "safe replay" }], details: { value: args.value } };
		},
	};

	const task = await driveTools.__boundary.recoverToolInvocation(
		fixture.lane,
		fixture.drive,
		fixture.run,
		fixture.sources,
		fixture.call,
		new Map([["safe", tool]]),
		undefined,
		false,
	);
	await task.completion;

	assert.equal(calls.length, 1, "safe/safe replay must re-invoke the tool exactly once");
	assert.deepEqual(calls[0], { toolCallId: "call-0", args: { value: "persisted" }, memo: { complete: true } });

	const staged = fixture.store.get(pendingEntry("res-1"));
	assert.equal(staged.type, "message");
	assert.equal(staged.payload.isError, false);
	assert.deepEqual(plain(staged.payload.content), [{ type: "text", text: "safe replay" }]);
	assert.deepEqual(plain(staged.payload.details), { value: "persisted" });

	const start = fixture.events.find((event) => event.type === "tool_start");
	assert.equal(start.recovery, true);
	assert.deepEqual(plain(start.args), { value: "persisted" });
	const update = fixture.events.find((event) => event.type === "tool_update");
	assert.equal(update.recovery, true);
	assert.equal(fixture.timeline.indexOf("event:tool_update") < fixture.timeline.indexOf("event:tool_end"), true);
	const end = fixture.events.find((event) => event.type === "tool_end");
	assert.equal(end.recovery, true);
	assert.equal(end.isError, false);
	assert.deepEqual(plain(end.result.content), [{ type: "text", text: "safe replay" }]);

	// The durable replay checkpoint is cleared before the replayed effect and the memo is released after it.
	assert.equal(fixture.timeline.indexOf("delete:pi.pending.tool_output") < fixture.timeline.indexOf("event:tool_start"), true);
	assert.equal(fixture.store.get(pendingToolOutput("op-1", "res-1")), undefined);
	assert.equal(fixture.store.get(operationToolMemo("op-1", "res-1", "step/a")), undefined);
	assert.deepEqual(plain(errors), []);
});

check("unsafe, mismatched or cancelled recoveries never replay the external effect", async () => {
	const scenarios = [
		{ label: "cancelled safe/safe", callReplay: "safe", toolReplay: "safe", cancelled: true },
		{ label: "unsafe call", callReplay: "never", toolReplay: "safe", cancelled: false },
		{ label: "unsafe tool", callReplay: "safe", toolReplay: "never", cancelled: false },
		{ label: "unsafe tool default", callReplay: "safe", toolReplay: undefined, cancelled: false },
	];

	for (const scenario of scenarios) {
		const { hooks, errors } = createHookRegistry();
		const fixture = createDriveFixture({
			hooks,
			callReplay: scenario.callReplay,
			storedArgs: { value: "persisted" },
			checkpoint: { content: [{ type: "text", text: "durable partial" }], details: { progress: "kept" } },
		});
		let executed = 0;
		const tool = {
			...(scenario.toolReplay === undefined ? {} : { replay: scenario.toolReplay }),
			name: "safe",
			execute: async () => {
				executed += 1;
				return { content: [{ type: "text", text: "must not run" }], details: {} };
			},
		};

		const task = await driveTools.__boundary.recoverToolInvocation(
			fixture.lane,
			fixture.drive,
			fixture.run,
			fixture.sources,
			fixture.call,
			new Map([["safe", tool]]),
			undefined,
			scenario.cancelled,
		);
		await task.completion;

		assert.equal(executed, 0, `${scenario.label} must not replay the effect`);
		assert.equal(
			fixture.events.some((event) => event.type === "tool_start"),
			false,
			`${scenario.label} must not announce a replayed start`,
		);
		const staged = fixture.store.get(pendingEntry("res-1"));
		assert.equal(staged.payload.isError, true, `${scenario.label} stages an interrupted result`);
		assert.deepEqual(plain(staged.payload.details), { progress: "kept" });
		const texts = plain(staged.payload.content.map((block) => block.text));
		assert.deepEqual(texts.slice(0, 1), ["durable partial"]);
		assert.match(texts.at(-1), /external outcome is unknown/);
		const end = fixture.events.find((event) => event.type === "tool_end");
		assert.equal(end.isError, true);
		assert.equal(fixture.store.get(pendingToolOutput("op-1", "res-1")), undefined);
		assert.deepEqual(plain(errors), []);
	}
});

async function runAfterTool({ hooks, tool, clearedArgs = {} }) {
	const fixture = createDriveFixture({ hooks, storedArgs: clearedArgs });
	const call = { status: "effect_pending", sourceIndex: 0, resultEntryId: "res-1", replay: "safe" };
	const outcome = await driveTools.__boundary.performToolInvocation(
		fixture.lane,
		fixture.drive,
		fixture.batch,
		call,
		{ toolCall: fixture.toolCall, tool, args: clearedArgs },
		undefined,
		false,
	);
	return outcome;
}

check("an after-tool hook may explicitly clear isError on a failed tool result", async () => {
	const { hooks, errors } = createHookRegistry();
	hooks.on("after_tool", () => ({
		content: [{ type: "text", text: "recovered by hook" }],
		details: { patched: true },
	}));
	hooks.on("after_tool", () => ({ isError: false }));

	const outcome = await runAfterTool({
		hooks,
		tool: {
			name: "safe",
			replay: "safe",
			execute: async () => {
				throw new Error("boom");
			},
		},
	});

	assert.equal(outcome.message.isError, false, "the hook's explicit false must survive finalization");
	assert.deepEqual(plain(outcome.message.content), [{ type: "text", text: "recovered by hook" }]);
	assert.deepEqual(plain(outcome.message.details), { patched: true });
	assert.deepEqual(plain(errors), []);
});

check("finalization applies explicit empty/false patches and preserves unpatched fields and usage", async () => {
	const details = { raw: true };
	const usage = {
		input: 3,
		output: 4,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 7,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	const { hooks, errors } = createHookRegistry();
	hooks.on("after_tool", () => ({ content: [] }));

	const outcome = await runAfterTool({
		hooks,
		tool: {
			name: "safe",
			replay: "safe",
			execute: async () => ({ content: [{ type: "text", text: "raw" }], details, usage, terminate: true }),
		},
	});

	assert.deepEqual(plain(outcome.message.content), [], "an explicit empty content patch must be applied");
	assert.equal(outcome.message.details, details, "unpatched details must be preserved by identity");
	assert.equal(outcome.message.usage, usage, "unpatched usage must be preserved by identity");
	assert.equal(outcome.message.isError, false);
	assert.equal(outcome.terminate, true, "unpatched terminate must be preserved");

	const second = createHookRegistry();
	second.hooks.on("after_tool", () => ({ terminate: false, isError: true }));
	const raised = await runAfterTool({
		hooks: second.hooks,
		tool: {
			name: "safe",
			replay: "safe",
			execute: async () => ({ content: [{ type: "text", text: "raw" }], details, usage, terminate: true }),
		},
	});
	assert.equal(raised.message.isError, true, "an explicit true patch must win over a successful execution");
	assert.equal(raised.terminate, false, "an explicit false terminate patch must be applied");
	assert.deepEqual(plain(raised.message.content), [{ type: "text", text: "raw" }]);
	assert.equal(raised.message.usage, usage);

	const third = createHookRegistry();
	third.hooks.on("after_tool", () => ({}));
	const untouched = await runAfterTool({
		hooks: third.hooks,
		tool: {
			name: "safe",
			replay: "safe",
			execute: async () => ({ content: [{ type: "text", text: "raw" }], details, usage }),
		},
	});
	assert.deepEqual(plain(untouched.message.content), [{ type: "text", text: "raw" }]);
	assert.equal(untouched.message.details, details);
	assert.equal(untouched.message.usage, usage);
	assert.equal(untouched.message.isError, false);
	assert.deepEqual(plain([...errors, ...second.errors, ...third.errors]), []);
});

check("a failing tool without hooks keeps isError true and reports the tool failure text", async () => {
	const { hooks, errors } = createHookRegistry();
	const outcome = await runAfterTool({
		hooks,
		tool: {
			name: "safe",
			replay: "safe",
			execute: async () => {
				throw new Error("tool exploded");
			},
		},
	});
	assert.equal(outcome.message.isError, true);
	assert.deepEqual(plain(outcome.message.content), [{ type: "text", text: "tool exploded" }]);
	assert.deepEqual(plain(errors), []);
});

let failures = 0;
for (const { name, body } of checks) {
	try {
		await body();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}
if (failures !== 0) throw new Error(`${failures} regression check(s) failed`);
console.log(`regression: ${checks.length} checks passed`);
