// Operate the real JSONL/session utilities on a tiny fixture and emit a lineage
// report: session ID, branch tip, parent relation and replay result.
//
// Run: node --import ./.prale-eval/operate/register.mjs ./.prale-eval/operate/lineage-demo.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../packages/agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../packages/agent/src/harness/env/nodejs.ts";
import * as sessionWrites from "../../packages/agent/src/harness/session/commit.ts";
import { buildSessionContext } from "../../packages/agent/src/harness/session/context.ts";
import { JSONL_FORMAT_VERSION, JsonlStorage } from "../../packages/agent/src/harness/session/jsonl/index.ts";
import * as storedValues from "../../packages/agent/src/harness/session/values.ts";
import { getOrThrow } from "../../packages/agent/src/harness/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "tiny-session.jsonl");
const REPORT_PATH = join(HERE, "lineage-report.json");

const SESSION_ID = "tiny-lineage-fixture";
const BRANCH = "main";
const NOW = 1_700_000_000_000;
const tmp = mkdtempSync(join(tmpdir(), "pi-lineage-"));

try {
	// ------------------------------------------------------------------
	// Phase 1: supply the tiny fixture by writing it through JsonlStorage.
	// ------------------------------------------------------------------
	const fileSystem = new NodeExecutionEnv({ cwd: tmp });
	const options = { fileSystem, path: FIXTURE_PATH, now: () => NOW };
	const header = {
		v: JSONL_FORMAT_VERSION,
		kind: "header",
		id: SESSION_ID,
		storageVersion: 1,
		createdAt: NOW,
		cwd: tmp,
	};

	const storage = await JsonlStorage.create(options, header, [], BACKGROUND_CONTEXT);
	const seeded = await storage.commit(
		[
			sessionWrites.insertEntry({
				id: "root",
				parentId: null,
				type: "message",
				message: { role: "user", content: "hello root", timestamp: 1 },
			}),
			sessionWrites.insertEntry({
				id: "child",
				parentId: "root",
				type: "message",
				message: { role: "user", content: "hello child", timestamp: 2 },
			}),
			storedValues.setValue(storedValues.branchTip(BRANCH), "child"),
		],
		BACKGROUND_CONTEXT,
	);
	await storage.close(BACKGROUND_CONTEXT);

	// ------------------------------------------------------------------
	// Phase 2: reopen the supplied fixture and replay it.
	// ------------------------------------------------------------------
	const replayOptions = { fileSystem, path: FIXTURE_PATH, now: () => NOW };
	const replayed = await JsonlStorage.open(replayOptions, BACKGROUND_CONTEXT);

	const entries = await replayed.getEntries(["root", "child"], BACKGROUND_CONTEXT);
	const tip = await replayed.getValue(storedValues.branchTip(BRANCH), BACKGROUND_CONTEXT);
	const stats = await replayed.getStats(BACKGROUND_CONTEXT);
	await replayed.close(BACKGROUND_CONTEXT);

	// ------------------------------------------------------------------
	// Phase 3: project the replayed lineage through the session-context util.
	// ------------------------------------------------------------------
	const pathEntries = [...entries.values()].sort((a, b) => a.seq - b.seq);
	const projected = await buildSessionContext(pathEntries, undefined, BACKGROUND_CONTEXT);

	const child = entries.get("child");
	const report = {
		sessionId: replayed.header.id,
		branch: BRANCH,
		branchTip: tip?.value ?? null,
		parentRelation: {
			childId: child?.id ?? null,
			parentId: child?.parentId ?? null,
			resolvesToRoot: child?.parentId === "root" && entries.get("root")?.parentId === null,
		},
		replay: {
			ok: true,
			entryCount: entries.size,
			entries: [...entries.values()]
				.sort((a, b) => a.seq - b.seq)
				.map((entry) => ({ id: entry.id, parentId: entry.parentId, seq: entry.seq, timestamp: entry.timestamp })),
			branchTipSeq: tip?.seq ?? null,
			messageCount: stats.messageCount,
		},
		projection: {
			ok: true,
			messageCount: projected.length,
			roles: projected.map((message) => message.role),
			texts: projected.map((message) => (typeof message.content === "string" ? message.content : "[]")),
		},
		seededSeqs: seeded.seqs,
		seededTimestamp: seeded.timestamp,
		fixtureBytes: readFileSync(FIXTURE_PATH, "utf8"),
	};

	writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
