/**
 * Snapshot/restore demo fixture (T22, repository `pi`, mode `demo`).
 *
 * The fixture builds a durable session storage from an explicit write log, takes a
 * JSON snapshot of the committed log, restores it into a *separate* fresh
 * `InMemoryStorageState`, resolves the restored branch tip's ancestry path with the
 * repository's real `scanBranch`, and projects that path through the real
 * `buildSessionContext` entry point exercised by
 * `packages/agent/test/harness/session-context.test.ts`.
 *
 * It proves the restored branch sees its own terminal entry (the tip message) but
 * NOT the sibling branch entry, even though both entries survive the restore.
 *
 * Run with the workspace's Node (native TypeScript type-stripping, no dependencies):
 *   node .prale-eval/demo/snapshot-restore-fixture.ts
 */
import { prepareStorageCommit, insertEntry } from "../../packages/agent/src/harness/session/commit.ts";
import { buildSessionContext } from "../../packages/agent/src/harness/session/context.ts";
import { InMemoryStorageState } from "../../packages/agent/src/harness/session/in-memory-storage-state.ts";
import { branchTip, setValue } from "../../packages/agent/src/harness/session/values.ts";

const NOW = 1_700_000_000_000;

const TERMINAL_TEXT = "terminal entry on the restored feature branch";
const SIBLING_TEXT = "entry on the sibling branch";

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW };
}

/**
 * Fixture topology (parentId links form the branch tree):
 *
 *   root
 *   ├── feature-1
 *   │   └── feature-2   <-- restored branch tip (the expected terminal entry)
 *   └── sibling-1       <-- sibling branch entry, NOT an ancestor of feature-2
 */
function fixtureWrites() {
	return [
		insertEntry({ id: "root", parentId: null, type: "message", message: userMessage("root question") }),
		insertEntry({ id: "feature-1", parentId: "root", type: "message", message: userMessage("feature step 1") }),
		insertEntry({ id: "feature-2", parentId: "feature-1", type: "message", message: userMessage(TERMINAL_TEXT) }),
		insertEntry({ id: "sibling-1", parentId: "root", type: "message", message: userMessage(SIBLING_TEXT) }),
		setValue(branchTip("feature"), "feature-2"),
		setValue(branchTip("sibling"), "sibling-1"),
	];
}

/** Apply a write transaction to a storage state using the repository's commit pipeline. */
function applyWrites(state, writes) {
	const prepared = prepareStorageCommit(writes, state.getNextSeq(), NOW);
	state.validateCommitted(prepared.writes);
	state.applyValidated(prepared.writes);
	return prepared.writes;
}

/** Snapshot: the durable committed write log serialized to JSON. */
function snapshot(state, writes) {
	return JSON.stringify(applyWrites(state, writes));
}

/** Restore: replay a snapshot's committed writes into a separate, empty storage state. */
function restore(snapshotJson) {
	const writes = JSON.parse(snapshotJson);
	const state = new InMemoryStorageState();
	state.validateCommitted(writes);
	state.applyValidated(writes);
	return state;
}

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

async function main() {
	const failures = [];
	const check = (label, condition) => {
		if (!condition) failures.push(label);
		return condition;
	};

	// 1. Build the source session and capture a snapshot of its durable log.
	const source = new InMemoryStorageState();
	const snapshotJson = snapshot(source, fixtureWrites());

	// 2. Restore into a separate, empty storage state.
	const restored = restore(snapshotJson);
	check("restored storage is a distinct instance", restored !== source);

	// 3. Read the restored branch tip (the expected terminal entry) from restored storage.
	const restoredTip = restored.getValue(branchTip("feature"))?.value;
	check("restored feature tip is the terminal entry", restoredTip === "feature-2");

	// 4. Resolve the restored branch's ancestry path the same way the runtime does
	//    (`scanBranch({ start: tip, stopAtType: "compaction" })`, newest-first then reversed).
	const path = restored.scanBranch({ start: restoredTip, stopAtType: "compaction", order: "newestFirst" }).reverse();
	const pathIds = path.map((entry) => entry.id);
	check("restored branch path is root -> feature-1 -> feature-2", pathIds.join(",") === "root,feature-1,feature-2");

	// 5. Project the restored branch path through the real context builder.
	const messages = await buildSessionContext(path, undefined, undefined);
	const texts = messages.map(textOf);

	check("restored branch context contains the terminal entry", texts.includes(TERMINAL_TEXT));
	check("restored branch context excludes the sibling entry", !texts.includes(SIBLING_TEXT));
	check("restored branch context has exactly the 3 path messages", messages.length === 3);

	// 6. Control: the sibling entry DID survive the restore (absence above is branch scoping,
	//    not restore data loss), and it is reachable only from the sibling tip.
	const siblingTip = restored.getValue(branchTip("sibling"))?.value;
	const siblingPathIds = restored
		.scanBranch({ start: siblingTip, stopAtType: "compaction", order: "newestFirst" })
		.reverse()
		.map((entry) => entry.id);
	const allEntryIds = restored.scanEntries({ order: "asc" }).map((entry) => entry.id);
	check("sibling entry survives in restored storage", allEntryIds.includes("sibling-1"));
	check("sibling branch path excludes the terminal entry", !siblingPathIds.includes("feature-2"));

	const report = {
		fixture: "snapshot/restore branch projection",
		restoredTip,
		restoredBranchPathIds: pathIds,
		restoredContextTexts: texts,
		siblingPathIds,
		restoredEntryIds: allEntryIds,
		pass: failures.length === 0,
		failures,
	};

	console.log(JSON.stringify(report, null, 2));
	if (failures.length > 0) {
		console.error(`DEMO FAILED: ${failures.join("; ")}`);
		process.exit(1);
	}
	console.log("DEMO PASSED: restored branch sees its terminal entry but not the sibling entry.");
}

await main();
