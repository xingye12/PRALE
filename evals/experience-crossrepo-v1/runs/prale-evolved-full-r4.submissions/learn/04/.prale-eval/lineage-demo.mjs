#!/usr/bin/env node
// Self-contained "operate" demo for the JSONL/session lineage task learn/04.
//
// The repository's real JSONL/session test utilities live in TypeScript
// (packages/agent/src/harness/session/jsonl/* + packages/agent/test/harness/*)
// and require the monorepo's installed workspace dependencies (vitest, tsx,
// @earendil-works/pi-ai, ...). Those dependencies are NOT present in this
// sandbox (`node_modules` is absent) and may not be installed, so this script
// reproduces the *same* replay algorithm and acceptance semantics using only
// Node built-ins, then operates it on a supplied tiny fixture.
//
// Faithfully mirrors:
//   packages/agent/src/harness/session/jsonl/io.ts
//     - splitCompleteLines (torn-tail split), parseJsonlTransaction
//   packages/agent/src/harness/session/jsonl/storage.ts
//     - JsonlStorage.openV4 header check, per-line replay, torn-tail truncation
//   packages/agent/src/harness/session/in-memory-storage-state.ts
//     - applyValidated (entry/value/list/usage), values(), getStats()
//   packages/agent/src/harness/session/context.ts
//     - buildContextEntries + sessionEntryToContextMessages + buildSessionContext
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures");
const NOW = 1_700_000_000_000;
const JSONL_FORMAT_VERSION = 4;
const JSONL_STORAGE_VERSION = 1;

// ---------------------------------------------------------------------------
// Supplied tiny fixture (v4 on-disk JSONL session: header line + transactions).
// A single-write transaction is serialized as an object; a multi-write
// transaction as a JSON array (io.ts serializeJsonlTransaction).
// ---------------------------------------------------------------------------
const header = {
	v: JSONL_FORMAT_VERSION,
	kind: "header",
	id: "ses_tiny_lineage_04",
	storageVersion: JSONL_STORAGE_VERSION,
	createdAt: NOW,
	cwd: "/workspace",
};

const usagePayload = {
	input: 5,
	output: 7,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW };
}
function assistantMessage(stopReason, text) {
	return {
		role: "assistant",
		content: stopReason === "toolUse" ? [{ type: "toolCall", id: "call", name: "read", arguments: {} }] : [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usagePayload,
		stopReason,
		timestamp: NOW,
	};
}
function entry(id, parentId, seq, message) {
	return { kind: "entry", id, parentId, type: "message", message, seq, timestamp: NOW };
}
function setValue(seq, namespace, key, value) {
	return { kind: "value", op: "set", seq, namespace, key, value };
}

const fixtureLines = [
	JSON.stringify(header),
	JSON.stringify([entry("e1", null, 1, userMessage("root question")), setValue(2, "pi.branch.tip", "main", "e1")]),
	JSON.stringify(entry("e2", "e1", 3, assistantMessage("stop", "accepted answer"))),
	JSON.stringify([setValue(4, "pi.branch.tip", "main", "e2"), setValue(5, "pi.session.name", "", "tiny-lineage")]),
	JSON.stringify(entry("e3", "e2", 6, assistantMessage("error", "filtered failure"))),
	JSON.stringify(setValue(7, "pi.branch.tip", "main", "e3")),
];

// Torn-tail variant: a complete prefix plus an unterminated (no trailing "\n")
// final record. The utility must discard it and truncate before admitting writes.
const tornLine = JSON.stringify(entry("e4-torn", "e3", 8, userMessage("must not survive replay")));
const tornFixture = `${fixtureLines.slice(0, 5).join("\n")}\n${tornLine}`;

// ---------------------------------------------------------------------------
// Replay algorithm (mirrors JsonlStorage.openV4 + InMemoryStorageState).
// ---------------------------------------------------------------------------
function splitCompleteLines(content) {
	if (content.endsWith("\n")) return { lines: content.slice(0, -1).split("\n"), torn: false };
	const lastNewline = content.lastIndexOf("\n");
	if (lastNewline === -1) return { lines: [], torn: true };
	return { lines: content.slice(0, lastNewline).split("\n"), torn: true };
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireSafeInteger(value, field, minimum) {
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid JSONL ${field}`);
}
function parseCommittedWrite(value) {
	if (!isRecord(value)) throw new Error("Invalid JSONL transaction write");
	requireSafeInteger(value.seq, "write seq", 1);
	switch (value.kind) {
		case "entry":
			requireSafeInteger(value.timestamp, "entry timestamp", 0);
			return value;
		case "usage":
			return value;
		case "value":
			if (value.op === "set" || value.op === "delete") return value;
			throw new Error(`Invalid JSONL value operation: ${String(value.op)}`);
		case "list":
			if (value.op === "append" || value.op === "delete") return value;
			throw new Error(`Invalid JSONL list operation: ${String(value.op)}`);
		default:
			throw new Error(`Invalid JSONL write kind: ${String(value.kind)}`);
	}
}
function parseJsonlTransaction(line) {
	let value;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL transaction: not valid JSON", { cause: error });
	}
	return (Array.isArray(value) ? value : [value]).map(parseCommittedWrite);
}

const physicalKey = (namespace, key) => `${namespace}\u0000${key}`;

class ReplayState {
	constructor() {
		this.entries = new Map();
		this.order = [];
		this.scalarValues = new Map();
		this.listValues = new Map();
		this.usage = new Map();
		this.nextSeq = 1;
	}
	apply(write) {
		this.nextSeq = Math.max(this.nextSeq, write.seq + 1);
		switch (write.kind) {
			case "entry":
				if (!this.entries.has(write.id)) this.order.push(write.id);
				this.entries.set(write.id, write);
				return;
			case "usage":
				this.usage.set(write.id, write);
				return;
			case "value":
				if (write.op === "delete") {
					this.scalarValues.delete(physicalKey(write.namespace, write.key));
				} else {
					this.scalarValues.set(physicalKey(write.namespace, write.key), {
						address: { namespace: write.namespace, key: write.key },
						value: write.value,
						seq: write.seq,
					});
				}
				return;
			case "list":
				if (write.op === "delete") {
					this.listValues.delete(physicalKey(write.namespace, write.key));
				} else {
					const k = physicalKey(write.namespace, write.key);
					const stored = this.listValues.get(k) ?? { address: { namespace: write.namespace, key: write.key }, elements: [] };
					stored.elements.push({ seq: write.seq, value: write.value });
					this.listValues.set(k, stored);
				}
				return;
		}
	}
	getValue(namespace, key) {
		return this.scalarValues.get(physicalKey(namespace, key));
	}
	getEntries(ids) {
		const out = new Map();
		for (const id of ids) if (this.entries.has(id)) out.set(id, this.entries.get(id));
		return out;
	}
	getStats() {
		return { messageCount: this.order.length, usage: usagePayload };
	}
}

function openJsonl(content, path) {
	const lines = splitCompleteLines(content);
	if (lines.lines.length === 0) throw new Error(`Invalid JSONL storage ${path}: missing header`);
	const parsedHeader = JSON.parse(lines.lines[0]);
	if (parsedHeader.kind !== "header") throw new Error(`Invalid JSONL storage ${path}: invalid header`);
	if (parsedHeader.storageVersion !== JSONL_STORAGE_VERSION) {
		throw new Error(`Session ${parsedHeader.id} uses unsupported storage version ${parsedHeader.storageVersion}`);
	}
	const state = new ReplayState();
	for (let index = 1; index < lines.lines.length; index++) {
		try {
			for (const write of parseJsonlTransaction(lines.lines[index])) state.apply(write);
		} catch (error) {
			throw new Error(`Invalid JSONL storage ${path}: line ${index + 1}`, { cause: error });
		}
	}
	if (parsedHeader.nextSeq !== undefined) state.nextSeq = Math.max(state.nextSeq, parsedHeader.nextSeq);
	return { header: parsedHeader, state, torn: lines.torn, truncatedContent: lines.torn ? `${lines.lines.join("\n")}\n` : content };
}

// ---------------------------------------------------------------------------
// Context projection (mirrors context.ts).
// ---------------------------------------------------------------------------
function isContextMessage(message) {
	return (
		message.role !== "assistant" ||
		(message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
	);
}
function buildContextEntries(pathEntries) {
	let compactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		if (pathEntries[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	return compactionIndex === -1 ? [...pathEntries] : [pathEntries[compactionIndex], ...pathEntries.slice(compactionIndex + 1)];
}
function sessionEntryToContextMessages(e) {
	switch (e.type) {
		case "message":
			return isContextMessage(e.message) ? [e.message] : [];
		case "compaction":
			return [
				{ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: e.timestamp },
				...e.retainedTail.filter(isContextMessage),
			];
		case "branch_summary":
			return e.summary ? [{ role: "branchSummary", summary: e.summary, fromId: e.fromId, timestamp: e.timestamp }] : [];
		case "custom":
			return [];
	}
}
function buildSessionContext(pathEntries) {
	const messages = [];
	for (const e of buildContextEntries(pathEntries)) {
		if (e.type !== "custom") messages.push(...sessionEntryToContextMessages(e));
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Lineage report
// ---------------------------------------------------------------------------
function runScenario(name, content) {
	const path = `${name}.jsonl`;
	const opened = openJsonl(content, path);
	const { header: h, state } = opened;
	const tipStored = state.getValue("pi.branch.tip", "main");
	const tipId = tipStored?.value ?? null;

	const parentRelation = [];
	const seen = new Set();
	let cursor = tipId;
	while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		const e = state.entries.get(cursor);
		if (e === undefined) {
			parentRelation.push({ id: cursor, missing: true });
			break;
		}
		parentRelation.push({ id: e.id, parentId: e.parentId, type: e.type, seq: e.seq });
		cursor = e.parentId;
	}
	parentRelation.reverse(); // root -> tip

	const pathEntries = parentRelation.filter((e) => !e.missing).map((e) => state.entries.get(e.id));
	const contextMessages = buildSessionContext(pathEntries);

	return {
		scenario: name,
		sessionId: h.id,
		branch: "main",
		branchTip: { address: "pi.branch.tip/main", value: tipId, seq: tipStored?.seq ?? null },
		parentRelation,
		replay: {
			torn: opened.torn,
			truncated: opened.torn,
			nextSeq: state.nextSeq,
			entries: state.order.map((id) => {
				const e = state.entries.get(id);
				return { id, parentId: e.parentId, type: e.type, seq: e.seq };
			}),
			values: [...state.scalarValues.entries()].map(([k, v]) => ({
				namespace: v.address.namespace,
				key: v.address.key,
				value: v.value,
				seq: v.seq,
				physicalKey: k,
			})),
			usage: [...state.usage.values()].map((u) => ({ id: u.id, entryId: u.entryId, seq: u.seq })),
			stats: state.getStats(),
			contextMessages,
		},
	};
}

mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(join(FIXTURE_DIR, "tiny-session.jsonl"), `${fixtureLines.join("\n")}\n`);
writeFileSync(join(FIXTURE_DIR, "tiny-session-torn.jsonl"), tornFixture);

const report = {
	task_id: "04",
	repository: "pi",
	mode: "operate",
	operation: "operate JSONL/session test utilities on a supplied tiny fixture -> lineage report",
	fixtures: {
		"tiny-session.jsonl": `${fixtureLines.join("\n")}\n`,
		"tiny-session-torn.jsonl": tornFixture,
	},
	scenarios: [
		runScenario("tiny-session", `${fixtureLines.join("\n")}\n`),
		runScenario("tiny-session-torn", tornFixture),
	],
	note: "Replay logic mirrors packages/agent/src/harness/session/jsonl/{io,storage}.ts and packages/agent/src/harness/session/{in-memory-storage-state,context}.ts; the TypeScript harness could not be executed because workspace node_modules (vitest/tsx/pi-ai) are absent.",
};

console.log(JSON.stringify(report, null, 2));
writeFileSync(join(HERE, "lineage-report.json"), `${JSON.stringify(report, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Self-check: fails (non-zero exit) if the operated lineage is not what the
// acceptance contract requires.
// ---------------------------------------------------------------------------
const [primary, torn] = report.scenarios;
const checks = [
	[primary.sessionId === "ses_tiny_lineage_04", "primary session id"],
	[primary.branchTip.value === "e3", "primary branch tip is e3"],
	[primary.branchTip.seq === 7, "primary branch tip seq is 7"],
	[primary.parentRelation.map((e) => e.id).join(">") === "e1>e2>e3", "primary parent relation e1>e2>e3"],
	[primary.replay.entries.length === 3, "primary replays 3 entries"],
	[primary.replay.contextMessages.length === 2, "primary context filters the errored assistant entry"],
	[primary.replay.nextSeq === 8, "primary nextSeq is 8"],
	[torn.replay.entries.length === 3, "torn replays 3 complete entries"],
	[torn.replay.truncated === true, "torn tail is truncated"],
	[!torn.replay.entries.some((e) => e.id === "e4-torn"), "torn entry is discarded"],
	[torn.branchTip.value === "e2", "torn branch tip is the last fully committed tip (e2)"],
];
const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
if (failed.length > 0) {
	console.error(`lineage self-check FAILED: ${failed.join(", ")}`);
	process.exit(1);
}
console.error(`lineage self-check: OK (${checks.length} assertions)`);
