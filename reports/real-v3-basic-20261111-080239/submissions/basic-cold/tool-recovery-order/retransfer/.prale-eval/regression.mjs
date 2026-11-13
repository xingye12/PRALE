/**
 * Regression for tool-recovery-order/retransfer.
 *
 * Drives the real durable tool-batch procedure (`runTools`) against a minimal in-memory stand-in for the Lane/Drive
 * durable plumbing so the replay decision after an interruption is exercised directly:
 *
 *  1. A batch that is cancelled while it runs must never clear a replay checkpoint or re-enter the tool effect
 *     boundary, even when both the persisted call and the tool declare `replay: "safe"`; the durable checkpoint
 *     must be published as interruption evidence instead.
 *  2. A batch that is not cancelled must still replay a safe/safe effect exactly once and settle the batch.
 *  3. A batch that is already cancelled keeps publishing interruption evidence only.
 *
 * Run with: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODULES = {
	tools: "packages/agent/src/harness/runtime/drive/tools.ts",
	placement: "packages/agent/src/harness/runtime/drive/tool-placement.ts",
	values: "packages/agent/src/harness/session/values.ts",
	sessionTypes: "packages/agent/src/harness/session/types.ts",
	commit: "packages/agent/src/harness/session/commit.ts",
	progress: "packages/agent/src/harness/runtime/progress.ts",
	execution: "packages/agent/src/harness/execution/tools.ts",
	gate: "packages/agent/src/harness/execution/effect-gate.ts",
};

class SessionInvariantError extends Error {
	constructor(message) {
		super(message);
		this.name = "SessionInvariantError";
	}
}

/** Boundary fakes for the helper imports the real modules pull in. */
const bindings = {
	SessionInvariantError,
	validateToolArguments: (_tool, call) => call.arguments,
	withAbortSignal: (signal, context) => ({ ...context, abortSignal: signal }),
};

const graph = createGraph(root, Object.values(MODULES), bindings);
const { runTools } = await graph.module(MODULES.tools);
const { createGate } = await graph.module(MODULES.gate);

const OPERATION_ID = "op-test";
const LANE = "main";
const TURN = "turn-1";
const ASSISTANT_ENTRY = "assistant-entry";
const INTERRUPTION_MARKER = "external outcome is unknown";

const valueKey = (namespace, key) => `${namespace}\u0000${key}`;
const toolArgsKey = (sourceIndex) => valueKey("pi.op.tool_args", `${OPERATION_ID}:${TURN}:${sourceIndex}`);
const checkpointKey = (invocationId) => valueKey("pi.pending.tool_output", `${OPERATION_ID}:${invocationId}`);
const pendingEntryKey = (entryId) => valueKey("pi.pending.entry", entryId);

function tool(name, replay, execute) {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		replay,
		execute: async (toolCallId, args, onUpdate, toolContext, invocation, context) =>
			execute({ toolCallId, args, onUpdate, toolContext, invocation, context }),
	};
}

function assistantMessage(calls) {
	return {
		role: "assistant",
		content: calls.map(({ name, value }, index) => ({
			type: "toolCall",
			id: `call-${index}`,
			name,
			arguments: { value },
		})),
		stopReason: "toolUse",
		timestamp: 20,
	};
}

function plannedCall(sourceIndex, resultEntryId) {
	return { status: "planned", sourceIndex, resultEntryId };
}

function pendingCall(sourceIndex, resultEntryId, replay) {
	return { status: "effect_pending", sourceIndex, resultEntryId, replay };
}

/**
 * Durable lane stand-in. It keeps only the pieces `runTools` really touches: the live operation state, value and
 * entry writes, the reader surface, emitted events, and replay-relevant commit ordering.
 */
class FakeLane {
	constructor({ run, tools, values, assistant }) {
		this.name = LANE;
		this.operationId = OPERATION_ID;
		this.tools = tools;
		this.values = new Map(values ?? []);
		this.entries = new Map([
			[ASSISTANT_ENTRY, { id: ASSISTANT_ENTRY, parentId: null, type: "message", message: assistant }],
		]);
		this.events = [];
		this.observations = [];
		this.commits = [];
		this.seq = 0;
		this.generatedIds = 0;
		this.hookCalls = [];
		this.session = {
			id: "fake-session",
			idGenerator: { next: () => `generated-${++this.generatedIds}` },
		};
		this.hooks = {
			runToolWithGate: async (name, payload) => {
				this.hookCalls.push({ name, payload });
				return undefined;
			},
		};
		this.stateProjection = {
			tipId: ASSISTANT_ENTRY,
			configuration: {
				model: { provider: "faux", modelId: "faux" },
				thinkingLevel: "off",
				activeToolNames: run.batch.configuration.activeToolNames,
			},
			inbox: [],
			lastOperationId: null,
			operation: {
				meta: {
					operationId: OPERATION_ID,
					lane: LANE,
					sourceTipId: null,
					startedAt: 10,
					intent: { kind: "run", promptEntryIds: [] },
				},
				state: run,
			},
		};
	}

	get state() {
		return this.stateProjection;
	}

	get operationState() {
		return this.stateProjection.operation.state;
	}

	readConfig() {
		return {
			tools: this.tools,
			resources: {},
			streamOptions: {},
			compaction: {},
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: this.operationState.settings.toolExecution,
			toolContext: undefined,
			systemPrompt: undefined,
			toProviderMessages: (messages) => messages,
			entryProjectors: {},
		};
	}

	/** Durably commit a cancellation the way an abort request does, without touching the effect gate. */
	requestCancellation() {
		this.stateProjection = {
			...this.stateProjection,
			operation: {
				...this.stateProjection.operation,
				state: {
					...this.operationState,
					control: { status: "cancel_requested", requestedAt: 5 },
				},
			},
		};
	}

	reader() {
		const values = this.values;
		const entries = this.entries;
		return {
			async getValue(address) {
				const stored = values.get(valueKey(address.namespace, address.key));
				return stored === undefined ? undefined : { address, value: stored.value, seq: stored.seq };
			},
			async scanValues(prefix) {
				const matches = [];
				for (const [key, stored] of values) {
					const [namespace, ...rest] = key.split("\u0000");
					const addressKey = rest.join("\u0000");
					if (namespace !== prefix.namespace || !addressKey.startsWith(prefix.key)) continue;
					matches.push({
						address: { namespace, key: addressKey, kind: "value" },
						value: stored.value,
						seq: stored.seq,
					});
				}
				return matches;
			},
			async getEntries(ids) {
				const found = new Map();
				for (const id of ids) {
					const entry = entries.get(id);
					if (entry !== undefined) found.set(id, entry);
				}
				return found;
			},
			async getStats() {
				return { entries: entries.size, usage: {} };
			},
			async readList() {
				return [];
			},
			async scanBranch() {
				return [];
			},
		};
	}

	async command(plan) {
		const decision = await plan(this.stateProjection, this.reader());
		if (decision.kind === "return") return decision.result;
		if (decision.kind === "reject") throw decision.error;
		return decision.materialize?.(this.applyCommit(decision));
	}

	async settleOperation(_capability, plan) {
		const decision = await plan(
			this.stateProjection,
			this.operationState,
			this.stateProjection.operation.meta,
			this.reader(),
		);
		if (decision.kind === "return") return decision.result;
		if (decision.kind === "reject") throw decision.error;
		return decision.materialize?.(this.applyCommit(decision));
	}

	async continueOperation(_capability, plan) {
		const current = this.operationState;
		if (current.control.status === "cancel_requested") return { kind: "cancel_requested" };
		const decision = await plan(this.stateProjection, current, this.stateProjection.operation.meta, this.reader());
		if (decision.kind === "return") return { kind: "result", value: decision.result };
		if (decision.kind === "reject") throw decision.error;
		return { kind: "result", value: decision.materialize?.(this.applyCommit(decision)) };
	}

	async emitBatch(events) {
		for (const event of events) {
			this.events.push(event);
			this.observations.push(event.type);
		}
	}

	applyCommit(decision) {
		const before = new Set(this.values.keys());
		const writes = decision.writes ?? [];
		this.commits.push({
			writes: writes.map((write) => ({
				kind: write.kind,
				op: write.op,
				namespace: write.namespace,
				key: write.key,
				entryId: write.entry?.id,
			})),
			before,
		});
		const stagesOutcome = writes.some(
			(write) => write.kind === "value" && write.op === "set" && write.namespace === "pi.pending.entry",
		);
		if (stagesOutcome) this.observations.push("outcome_commit");
		else if (
			writes.some(
				(write) => write.kind === "value" && write.op === "delete" && write.namespace === "pi.pending.tool_output",
			)
		) {
			this.observations.push("replay_commit");
		}
		for (const write of writes) {
			if (write.kind === "value") {
				const key = valueKey(write.namespace, write.key);
				if (write.op === "set") this.values.set(key, { value: write.value, seq: ++this.seq });
				else this.values.delete(key);
			} else if (write.kind === "entry") {
				this.entries.set(write.entry.id, write.entry);
			}
		}
		const nextOperationState = decision.operationState ?? decision.next?.operation?.state;
		if (decision.next !== undefined) this.stateProjection = decision.next;
		if (nextOperationState !== undefined) {
			this.stateProjection = {
				...this.stateProjection,
				...(decision.lane ?? {}),
				operation: { meta: this.stateProjection.operation.meta, state: nextOperationState },
			};
		} else if (decision.lane !== undefined) {
			this.stateProjection = { ...this.stateProjection, ...decision.lane };
		}
		const commit = { seqs: writes.map(() => ++this.seq), timestamp: 100, stats: { usage: {} } };
		for (const event of decision.events?.(commit) ?? []) {
			this.events.push(event);
			this.observations.push(event.type);
		}
		return commit;
	}
}

function buildRun({ calls, toolNames, toolExecution, cancelled }) {
	return {
		at: "tools",
		control: cancelled ? { status: "cancel_requested", requestedAt: 5 } : { status: "running" },
		settings: { compaction: {}, steeringMode: "all", followUpMode: "all", toolExecution },
		batch: {
			assistantEntryId: ASSISTANT_ENTRY,
			configuration: {
				model: { provider: "faux", modelId: "faux" },
				thinkingLevel: "off",
				activeToolNames: toolNames,
			},
			turnId: TURN,
			calls,
		},
		latestAssistantEntryId: ASSISTANT_ENTRY,
	};
}

/** Drive one durable tool batch through the real procedure and return the observable lane. */
async function runBatch({ run, tools, values, assistant, onLane }) {
	const lane = new FakeLane({ run, tools, values, assistant });
	onLane?.(lane);
	const { gate } = createGate();
	const result = await runTools(
		lane,
		{ operationId: OPERATION_ID, context: { lane: LANE }, gate, beginAbort() {}, signalAbort() {} },
		run,
	);
	return { lane, result };
}

const toolStarts = (lane, toolCallId) =>
	lane.events.filter((event) => event.type === "tool_start" && event.toolCallId === toolCallId);
const toolEnds = (lane, toolCallId) =>
	lane.events.filter((event) => event.type === "tool_end" && event.toolCallId === toolCallId);

function textOf(message) {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The incident: cancellation lands while a parallel batch is running. The safe/safe call that was already
//    interrupted must not be re-transferred: no checkpoint clearing, no tool invocation, evidence published instead.
// ---------------------------------------------------------------------------------------------------------------------
{
	let recordExecutions = 0;
	let replayExecutions = 0;
	const cancelled = { by: undefined, request: () => {} };
	const record = tool("record", "never", async () => {
		recordExecutions += 1;
		cancelled.by = "record";
		cancelled.request();
		return { content: [{ type: "text", text: "recorded" }], details: { value: "record" } };
	});
	const replayable = tool("replayable", "safe", async ({ args }) => {
		replayExecutions += 1;
		return { content: [{ type: "text", text: `replayed ${JSON.stringify(args)}` }], details: { value: "replay" } };
	});
	const { lane, result } = await runBatch({
		run: buildRun({
			toolExecution: "parallel",
			cancelled: false,
			toolNames: ["record", "replayable"],
			calls: [plannedCall(0, "result-record"), pendingCall(1, "result-replayable", "safe")],
		}),
		tools: [record, replayable],
		assistant: assistantMessage([
			{ name: "record", value: "record-args" },
			{ name: "replayable", value: "replayable-args" },
		]),
		values: [
			[toolArgsKey(1), { value: { value: "persisted-args" }, seq: 1 }],
			[
				checkpointKey("result-replayable"),
				{
					value: {
						content: [{ type: "text", text: "checkpoint evidence for replayable" }],
						details: { progress: "kept" },
					},
					seq: 2,
				},
			],
		],
		onLane: (created) => {
			cancelled.request = () => created.requestCancellation();
		},
	});

	assert.equal(result.kind, "continue");
	assert.equal(cancelled.by, "record", "the batch must have been cancelled while it was running");
	assert.equal(recordExecutions, 1, "the in-flight call still completes exactly once");
	assert.equal(
		replayExecutions,
		0,
		"a cancelled batch must not invoke a safe/safe tool that was interrupted before cancellation",
	);
	assert.deepEqual(
		toolStarts(lane, "call-1"),
		[],
		"a cancelled batch must not reopen the interrupted call with a recovery tool_start",
	);
	assert.equal(
		lane.observations.includes("replay_commit"),
		false,
		"cancellation must prevent the replay checkpoint from being cleared before the outcome is staged",
	);
	const outcomeCommit = lane.commits.find((commit) =>
		commit.writes.some((write) => write.kind === "value" && write.op === "set" && write.key === "result-replayable"),
	);
	assert.ok(outcomeCommit, "the interrupted call must still stage an outcome");
	assert.equal(
		outcomeCommit.before.has(checkpointKey("result-replayable")),
		true,
		"the durable checkpoint must survive until the interruption evidence is staged",
	);
	const ends = toolEnds(lane, "call-1");
	assert.equal(ends.length, 1, "the interrupted call must settle exactly once");
	assert.equal(ends[0].recovery, true);
	assert.equal(ends[0].isError, true);
	const evidence = textOf(ends[0].result);
	assert.match(evidence, /checkpoint evidence for replayable/, "interruption evidence must carry the checkpoint");
	assert.match(evidence, /external outcome is unknown/);
	assert.deepEqual(ends[0].result.details, { progress: "kept" });
	assert.equal(lane.operationState.at, "checkpoint", "the cancelled batch must still settle after completion");
	assert.equal(lane.operationState.control.status, "cancel_requested");
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. A batch that is not cancelled keeps the replay guarantee: the safe/safe effect replays exactly once from the
//    durable checkpoint and the batch settles after the completion.
// ---------------------------------------------------------------------------------------------------------------------
{
	const replayExecutions = [];
	const replayable = tool("replayable", "safe", async ({ args, invocation }) => {
		replayExecutions.push({ args, invocationId: invocation.invocationId });
		return { content: [{ type: "text", text: "replayed once" }], details: { value: "safe" } };
	});
	const { lane, result } = await runBatch({
		run: buildRun({
			toolExecution: "parallel",
			cancelled: false,
			toolNames: ["replayable"],
			calls: [pendingCall(0, "result-replayable", "safe")],
		}),
		tools: [replayable],
		assistant: assistantMessage([{ name: "replayable", value: "replayable-args" }]),
		values: [
			[toolArgsKey(0), { value: { value: "persisted-args" }, seq: 1 }],
			[checkpointKey("result-replayable"), { value: { content: [{ type: "text", text: "old progress" }] }, seq: 2 }],
		],
	});

	assert.equal(result.kind, "continue");
	assert.deepEqual(
		replayExecutions,
		[{ args: { value: "persisted-args" }, invocationId: "result-replayable" }],
		"an uncancelled safe/safe effect must replay exactly once with its persisted arguments",
	);
	const starts = toolStarts(lane, "call-0");
	assert.equal(starts.length, 1, "a replayed call must announce exactly one recovery start");
	assert.equal(starts[0].recovery, true);
	assert.deepEqual(starts[0].args, { value: "persisted-args" });
	assert.ok(
		lane.observations.includes("replay_commit"),
		"an uncancelled replay must clear its checkpoint once before re-admitting the effect",
	);
	assert.equal(
		lane.observations.indexOf("replay_commit") < lane.observations.indexOf("tool_start"),
		true,
		"the replay checkpoint must be cleared before the effect is re-admitted",
	);
	const ends = toolEnds(lane, "call-0");
	assert.equal(ends.length, 1);
	assert.equal(ends[0].isError, false);
	assert.equal(ends[0].recovery, true);
	assert.equal(
		textOf(ends[0].result).includes(INTERRUPTION_MARKER),
		false,
		"a completed replay must not be reported as interrupted",
	);
	assert.equal(lane.operationState.at, "checkpoint", "the batch must settle after the replay completes");
	assert.equal(lane.operationState.continuation.kind, "need_assistant");
	assert.equal(lane.values.has(pendingEntryKey("result-replayable")), false, "the staged outcome must be placed");
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. A batch that is already cancelled keeps publishing interruption evidence only.
// ---------------------------------------------------------------------------------------------------------------------
{
	let executions = 0;
	const never = tool("never", "never", async () => {
		executions += 1;
		return { content: [{ type: "text", text: "must not run" }], details: {} };
	});
	const { lane, result } = await runBatch({
		run: buildRun({
			toolExecution: "sequential",
			cancelled: true,
			toolNames: ["never"],
			calls: [pendingCall(0, "result-never", "never")],
		}),
		tools: [never],
		assistant: assistantMessage([{ name: "never", value: "never-args" }]),
		values: [
			[toolArgsKey(0), { value: { value: "persisted-args" }, seq: 1 }],
			[checkpointKey("result-never"), { value: { content: [{ type: "text", text: "never checkpoint" }] }, seq: 2 }],
		],
	});

	assert.equal(result.kind, "continue");
	assert.equal(executions, 0, "a cancelled batch must never cross the tool effect boundary");
	assert.deepEqual(toolStarts(lane, "call-0"), []);
	const ends = toolEnds(lane, "call-0");
	assert.equal(ends.length, 1);
	assert.match(textOf(ends[0].result), /never checkpoint/);
	assert.match(textOf(ends[0].result), /external outcome is unknown/);
	assert.equal(lane.operationState.at, "checkpoint");
}

console.log("regression: cancelled tool batches publish interruption evidence and never re-transfer");
