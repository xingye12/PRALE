/**
 * Regression: interrupted tool replay requires BOTH the persisted call policy
 * (`ToolCall.replay`, written when the intent was published) AND the current tool
 * declaration (`AgentHarnessTool.replay`) to be "safe", and no cancellation.
 *
 * Exercised code: `recoverToolInvocation` in
 *   packages/agent/src/harness/runtime/drive/tools.ts
 * The private procedure is reached through a test-only trailer that re-exports it
 * from the real module; every boundary (lane, session values, execution) is faked
 * here. Nothing in the repository is stubbed out of existence: the module under
 * test is the production file itself.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = "packages/agent/src/harness/runtime/drive/tools.ts";
const INTERRUPTED_MARKER = "external outcome is unknown";

/* ------------------------------------------------------------------ boundaries */

const address = (namespace, key) => ({ kind: "value", namespace, key });

const bindings = {
	AbortRequested: class AbortRequested extends Error {},
	SessionInvariantError: class SessionInvariantError extends Error {},
	applyBeforeToolDecision: () => {
		throw new Error("unexpected boundary: applyBeforeToolDecision");
	},
	prepareToolCall: () => {
		throw new Error("unexpected boundary: prepareToolCall");
	},
	toolResultFromMessage: (message, terminate) => ({
		content: message.content,
		...(message.details === undefined ? {} : { details: message.details }),
		...(terminate ? { terminate: true } : {}),
	}),
	materializeReady: () => {
		throw new Error("unexpected boundary: materializeReady");
	},
	readToolBatchSource: () => {
		throw new Error("unexpected boundary: readToolBatchSource");
	},
	withToolBatch: (run, batch) => ({ ...run, batch }),
	// pi.harness.session.values
	setValue: (target, value) => ({ kind: "value", op: "set", namespace: target.namespace, key: target.key, value }),
	deleteValue: (target) => ({ kind: "value", op: "delete", namespace: target.namespace, key: target.key }),
	operationToolArgs: (operationId, turnId, sourceIndex) =>
		address("pi.op.tool_args", `${operationId}/${turnId}/${sourceIndex}`),
	operationToolMemo: (operationId, resultEntryId, name) =>
		address("pi.op.tool_memo", `${operationId}/${resultEntryId}/${name}`),
	operationToolMemoPrefix: (operationId, resultEntryId) =>
		address("pi.op.tool_memo", `${operationId}/${resultEntryId}/`),
	pendingEntry: (entryId) => address("pi.pending.entry", entryId),
	pendingToolOutput: (operationId, resultEntryId) =>
		address("pi.pending.tool_output", `${operationId}/${resultEntryId}`),
	// pi.harness.runtime.progress
	openToolProgress: () => ({ write() {}, seal() {}, drain: async () => {} }),
	// pi.harness.runtime.drive.tool-placement (driven by the scenario itself)
	toolCallFor: (sources) => sources.toolCall,
};

/**
 * One recovery attempt for a single interrupted (effect_pending) tool call.
 * `persistedReplay` is the durable call policy, `declaredReplay` the current tool
 * declaration, `declared === false` means the tool is no longer registered.
 */
async function recover({ persistedReplay, declaredReplay, declared = true, cancelled = false }) {
	const operationId = "op-1";
	const resultEntryId = "entry-1";
	const toolName = "write-file";
	const call = { status: "effect_pending", sourceIndex: 0, resultEntryId, replay: persistedReplay };
	const batch = {
		turnId: "turn-1",
		calls: [call],
		configuration: { activeToolNames: [toolName] },
	};
	const run = { batch, control: { status: cancelled ? "cancel_requested" : "running" }, settings: { toolExecution: "parallel" } };
	const drive = { operationId, context: {}, gate: {} };

	const observed = {
		executions: [],
		commandWrites: [],
		commandEvents: [],
		outcomeWrites: [],
		outcomeEvents: [],
		delivered: [],
	};

	// Durable state: the published argument record and the durable checkpoint the
	// interrupted invocation left behind.
	const values = new Map();
	const argsAddress = address("pi.op.tool_args", `${operationId}/turn-1/0`);
	values.set(JSON.stringify(argsAddress), { value: { value: "persisted" } });
	const checkpoint = { content: [{ type: "text", text: "durable partial" }], details: { progress: "kept" } };
	values.set(JSON.stringify(address("pi.pending.tool_output", `${operationId}/${resultEntryId}`)), {
		value: checkpoint,
	});

	const reader = {
		async getValue(target) {
			const stored = values.get(JSON.stringify(target));
			return stored === undefined ? undefined : structuredClone(stored);
		},
		async scanValues() {
			return [];
		},
	};

	const laneState = { operation: { state: { at: "tools", batch, control: run.control, settings: run.settings } } };
	const lane = {
		name: "lane-a",
		state: laneState,
		async command(plan, _context) {
			const decision = await plan(laneState, reader);
			if (decision.kind === "return") return decision.result;
			if (decision.kind === "reject") throw decision.error;
			if (decision.kind !== "commit") throw new Error(`unexpected lane command decision: ${decision.kind}`);
			observed.commandWrites.push(...decision.writes);
			observed.commandEvents.push(...(decision.events?.() ?? []));
			return decision.materialize === undefined ? undefined : decision.materialize();
		},
		async settleOperation(operation, plan, _context) {
			const decision = await plan(laneState, operation, {}, reader);
			if (decision.kind !== "commit") throw new Error(`unexpected settle decision: ${decision.kind}`);
			observed.outcomeWrites.push(...decision.writes);
			const events = decision.events?.() ?? [];
			observed.outcomeEvents.push(...events);
			// The real lane re-emits a settle commit's events through the event stream.
			observed.delivered.push(...events);
			return decision.materialize === undefined ? undefined : decision.materialize();
		},
		async emitBatch(events, _context) {
			observed.delivered.push(...events);
		},
		hooks: {
			async runToolWithGate() {
				return undefined;
			},
		},
		readConfig() {
			return { tools: [], toolContext: undefined };
		},
	};

	const graph = createGraph(
		root,
		[TOOLS],
		{
			...bindings,
			// The decision under test is the ordering/policy gate, not execution plumbing:
			// a real execution is recorded so an unexpected replay is observable.
			executeToolCall: (cleared) => {
				observed.executions.push(cleared.toolCall.name);
				return Promise.resolve({
					result: { content: [{ type: "text", text: "replayed execution" }] },
					isError: false,
				});
			},
			finalizeToolCall: (cleared) => ({ toolCall: cleared.toolCall, terminate: false }),
			createToolResultMessage: (finalized) => ({
				role: "toolResult",
				toolCallId: finalized.toolCall.id,
				toolName: finalized.toolCall.name,
				content: [{ type: "text", text: "replayed execution" }],
				isError: false,
				timestamp: 1,
			}),
		},
		{},
		{ [TOOLS]: "\nexport { recoverToolInvocation as __recoverToolInvocation };\n" },
	);
	const tools = await graph.module(TOOLS);
	assert.equal(
		typeof tools.__recoverToolInvocation,
		"function",
		"production module does not expose the recovery procedure under test",
	);

	const sources = { toolCall: { id: "call-1", name: toolName, arguments: { value: "persisted" } } };
	const toolsByName = new Map(
		declared ? [[toolName, { name: toolName, label: toolName, replay: declaredReplay }]] : [],
	);

	const task = await tools.__recoverToolInvocation(
		lane,
		drive,
		run,
		sources,
		call,
		toolsByName,
		undefined,
		cancelled,
	);
	await task.completion;

	const staged = observed.outcomeWrites.find((write) => write.namespace === "pi.pending.entry");
	assert.ok(staged, "recovery published no tool result entry");
	const message = staged.value.payload;
	return {
		message,
		executions: observed.executions,
		commandWrites: observed.commandWrites,
		commandEvents: observed.commandEvents,
		outcomeWrites: observed.outcomeWrites,
		outcomeEvents: observed.outcomeEvents,
		delivered: observed.delivered,
	};
}

/** The synthetic interruption result: durable checkpoint prefix plus the marker. */
function assertInterrupted(outcome, label) {
	assert.deepEqual(outcome.executions, [], `${label}: the interrupted tool was invoked`);
	assert.deepEqual(
		outcome.commandWrites,
		[],
		`${label}: the durable checkpoint was cleared instead of being preserved for the outcome`,
	);
	assert.deepEqual(outcome.commandEvents, [], `${label}: a replay tool_start was announced for a blocked call`);
	const content = outcome.message.content;
	assert.deepEqual(
		content[0],
		{ type: "text", text: "durable partial" },
		`${label}: the durable checkpoint content was not published with the outcome`,
	);
	const marker = content.at(-1);
	assert.equal(marker?.type, "text", `${label}: the outcome has no interruption marker`);
	assert.ok(
		String(marker.text).includes(INTERRUPTED_MARKER),
		`${label}: expected an interrupted outcome, got ${JSON.stringify(marker.text)}`,
	);
	assert.equal(outcome.message.isError, true, `${label}: an interrupted outcome must be an error result`);
	assert.deepEqual(
		outcome.message.details,
		{ progress: "kept" },
		`${label}: the checkpoint details were not carried into the outcome`,
	);
	const starts = outcome.delivered.filter((event) => event.type === "tool_start");
	assert.deepEqual(starts, [], `${label}: the blocked call published tool_start on the event stream`);
	const ends = outcome.delivered.filter((event) => event.type === "tool_end");
	assert.equal(ends.length, 1, `${label}: the blocked call must publish exactly one tool_end`);
	assert.equal(ends[0].recovery, true, `${label}: the blocked outcome must be marked as recovery`);
	assert.equal(ends[0].isError, true, `${label}: the blocked outcome must be an error`);
}

function assertReplayed(outcome, label) {
	assert.deepEqual(outcome.executions, ["write-file"], `${label}: a doubly-safe interrupted call was not replayed`);
	const deletes = outcome.commandWrites.filter(
		(write) => write.op === "delete" && write.namespace === "pi.pending.tool_output",
	);
	assert.equal(deletes.length, 1, `${label}: replay must clear the persisted checkpoint once before re-invoking`);
	const starts = outcome.commandEvents.filter((event) => event.type === "tool_start");
	assert.equal(starts.length, 1, `${label}: replay must announce exactly one recovery tool_start`);
	assert.deepEqual(starts[0].args, { value: "persisted" }, `${label}: replay must reuse the persisted arguments`);
	assert.equal(outcome.message.isError, false, `${label}: a replayed call must publish an executed result`);
	assert.ok(
		!JSON.stringify(outcome.message).includes(INTERRUPTED_MARKER),
		`${label}: a replayed call must not publish an interrupted outcome`,
	);
}

/* --------------------------------------------------------------------- scenarios */

// Positive control: both declarations safe and no cancellation -> replay.
assertReplayed(
	await recover({ persistedReplay: "safe", declaredReplay: "safe" }),
	"persisted safe + declared safe",
);

// The incident: either declaration alone being safe must not authorize replay.
assertInterrupted(
	await recover({ persistedReplay: "safe", declaredReplay: "never" }),
	"persisted safe + declared never",
);
assertInterrupted(
	await recover({ persistedReplay: "never", declaredReplay: "safe" }),
	"persisted never + declared safe",
);
assertInterrupted(
	await recover({ persistedReplay: "never", declaredReplay: "never" }),
	"persisted never + declared never",
);
assertInterrupted(
	await recover({ persistedReplay: "safe", declaredReplay: undefined }),
	"persisted safe + declaration default",
);
assertInterrupted(
	await recover({ persistedReplay: "safe", declaredReplay: "never", declared: false }),
	"persisted safe + tool unregistered",
);

// Cancellation wins over two safe declarations.
assertInterrupted(
	await recover({ persistedReplay: "safe", declaredReplay: "safe", cancelled: true }),
	"persisted safe + declared safe + cancelled",
);

console.log("regression: interrupted tool replay requires both safe declarations and no cancellation");
